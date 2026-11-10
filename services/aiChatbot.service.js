/**
 * STS FINTECH PRIVATE LIMITED
 * AI Financial Chatbot Service
 *
 * Implements conversational AI financial advisory using OpenAI SDK with tool calling.
 * All financial data is strictly sourced from verified PostgreSQL ledger queries.
 * Context is isolated per authenticated user and persisted in ai_conversations / ai_chat_messages.
 */

const pool = require('../db');
const {
  FINANCIAL_TOOL_DEFINITIONS,
  executeFinancialTool,
} = require('./financialTools.service');
const {
  getConfig,
  checkAiHealth,
  checkLocalAiHealth,
  executeChatInference,
} = require('./aiProvider.service');

// Supported language codes
const SUPPORTED_LANGUAGES = ['en-IN', 'ta-IN', 'hi-IN'];

/**
 * Validates language code; defaults to 'en-IN'
 */
function sanitizeLanguage(lang) {
  if (lang && SUPPORTED_LANGUAGES.includes(lang)) {
    return lang;
  }
  if (lang === 'ta' || lang === 'ta-IN') return 'ta-IN';
  if (lang === 'hi' || lang === 'hi-IN') return 'hi-IN';
  return 'en-IN';
}

/**
 * Fetch or create a conversation thread owned by the authenticated user
 */
async function getOrCreateConversation(userId, conversationId = null, language = 'en-IN', initialMessage = '') {
  const cleanLang = sanitizeLanguage(language);

  if (conversationId) {
    // Validate UUID format
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    if (!uuidRegex.test(conversationId)) {
      throw new Error('Invalid conversation ID format.');
    }

    // Verify ownership
    const checkQuery = `
      SELECT id, user_id, title, language, created_at, updated_at
      FROM ai_conversations
      WHERE id = $1 AND user_id = $2;
    `;
    const res = await pool.query(checkQuery, [conversationId, userId]);
    if (res.rows.length === 0) {
      throw new Error('Conversation not found or access denied.');
    }
    return res.rows[0];
  }

  // Create new conversation
  const title = initialMessage
    ? initialMessage.slice(0, 60) + (initialMessage.length > 60 ? '...' : '')
    : 'Financial Advisory Session';

  const insertQuery = `
    INSERT INTO ai_conversations (user_id, title, language)
    VALUES ($1, $2, $3)
    RETURNING id, user_id, title, language, created_at, updated_at;
  `;
  const insertRes = await pool.query(insertQuery, [userId, title, cleanLang]);
  return insertRes.rows[0];
}

/**
 * Retrieve recent message history for multi-turn conversational context
 */
async function getConversationMessages(conversationId, limit = 20) {
  const query = `
    SELECT id, role, content, tool_calls, tool_call_id, financial_data, created_at
    FROM ai_chat_messages
    WHERE conversation_id = $1
    ORDER BY created_at ASC
    LIMIT $2;
  `;
  const res = await pool.query(query, [conversationId, limit]);
  return res.rows;
}

/**
 * Save a message into the conversation thread
 */
async function saveMessage({
  conversationId,
  userId,
  role,
  content,
  toolCalls = null,
  toolCallId = null,
  financialData = null,
}) {
  const query = `
    INSERT INTO ai_chat_messages (
      conversation_id, user_id, role, content, tool_calls, tool_call_id, financial_data
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7)
    RETURNING id, conversation_id, role, content, created_at;
  `;
  const res = await pool.query(query, [
    conversationId,
    userId,
    role,
    content || '',
    toolCalls ? JSON.stringify(toolCalls) : null,
    toolCallId || null,
    financialData ? JSON.stringify(financialData) : null,
  ]);

  // Touch conversation updated_at
  await pool.query(
    `UPDATE ai_conversations SET updated_at = CURRENT_TIMESTAMP WHERE id = $1;`,
    [conversationId]
  );

  return res.rows[0];
}

/**
 * Construct system prompt guiding the assistant on persona, currency, language, and grounding
 */
function buildSystemPrompt(userName = 'Valued User', language = 'en-IN') {
  let langInstruction = 'Respond in clear, professional Indian English.';
  if (language === 'ta-IN') {
    langInstruction = 'Respond in fluent, natural Tamil (தமிழ் script). Keep monetary figures in ₹ (INR).';
  } else if (language === 'hi-IN') {
    langInstruction = 'Respond in fluent, natural Hindi (हिन्दी / Devanagari script). Keep monetary figures in ₹ (INR).';
  }

  return `You are STS FINTECH AI, an expert, trustworthy, and precise personal financial advisor for STS FINTECH PRIVATE LIMITED.
You are assisting ${userName}.

CRITICAL OPERATIONAL RULES:
1. ALWAYS ground your financial numbers in the data returned by the provided financial tools.
2. If the user asks about income, expenses, savings, categories, comparisons, or transactions, CALL THE APPROPRIATE FINANCIAL TOOL.
3. NEVER invent, hallucinate, or simulate financial figures or merchant names.
4. If a tool returns ₹0 or empty transactions, inform the user clearly that no records exist in that period.
5. All monetary amounts must be formatted in Indian Rupees (e.g., ₹25,000.00).
6. Distinguish between actual verified ledger entries and mathematical estimates.
7. Note that insights provided are deterministic rule-based statistical observations from actual transactions, NOT black-box unverified ML predictions.
8. ${langInstruction}
9. Keep responses structured, concise, and helpful. Use bullet points for breakdowns when suitable.`;
}

/**
 * Primary Chat Orchestration Engine
 *
 * @param {object} params
 * @param {number} params.userId - Authenticated user integer ID
 * @param {string} params.userName - Name of user
 * @param {string} params.message - User prompt
 * @param {string} params.language - 'en-IN' | 'ta-IN' | 'hi-IN'
 * @param {string} params.conversationId - Optional existing conversation UUID
 * @param {object} params.mockAdapter - Optional mock LLM adapter for deterministic unit/integration testing
 */
async function processChatMessage({
  userId,
  userName = 'User',
  message,
  language = 'en-IN',
  conversationId = null,
  mockAdapter = null,
}) {
  if (!userId || typeof userId !== 'number') {
    throw new Error('Authentication required: Valid user ID is mandatory.');
  }

  if (!message || typeof message !== 'string' || message.trim().length === 0) {
    throw new Error('Message content cannot be empty.');
  }

  if (message.length > 4000) {
    throw new Error('Message exceeds maximum allowed length of 4000 characters.');
  }

  const cleanLang = sanitizeLanguage(language);

  // 1. Get or create conversation thread
  const conversation = await getOrCreateConversation(userId, conversationId, cleanLang, message);
  const activeConvId = conversation.id;

  // 2. Persist user message
  await saveMessage({
    conversationId: activeConvId,
    userId,
    role: 'user',
    content: message.trim(),
  });

  // 3. Retrieve prior conversational context
  const history = await getConversationMessages(activeConvId, 12);

  // Format messages for LLM
  const messages = [
    { role: 'system', content: buildSystemPrompt(userName, cleanLang) },
    ...history.map((h) => {
      const msgObj = {
        role: h.role,
        content: h.content,
      };
      if (h.tool_calls) {
        msgObj.tool_calls = typeof h.tool_calls === 'string' ? JSON.parse(h.tool_calls) : h.tool_calls;
      }
      if (h.tool_call_id) {
        msgObj.tool_call_id = h.tool_call_id;
      }
      return msgObj;
    }),
  ];

  // 4. Execute inference via local Ollama provider (or mock adapter for testing)
  const result = await executeChatInference({
    userId,
    messages,
    mockAdapter: mockAdapter
      ? (params) =>
          mockAdapter({
            userId,
            message,
            language: cleanLang,
            ...params,
            executeFinancialTool,
          })
      : null,
  });

  if (!result.success) {
    return {
      success: false,
      error: result.error || 'AI_PROVIDER_UNAVAILABLE',
      message: result.message || 'The AI assistant is currently unavailable. Please try again later.',
      conversationId: activeConvId,
      language: cleanLang,
      diagnostic: result.diagnostic || null,
    };
  }

  const finalAnswer = result.answer || 'Financial analysis completed across your active ledger records.';

  // 5. Save verified assistant response
  await saveMessage({
    conversationId: activeConvId,
    userId,
    role: 'assistant',
    content: finalAnswer,
    financialData: result.financialData || null,
  });

  return {
    success: true,
    answer: finalAnswer,
    language: cleanLang,
    conversationId: activeConvId,
    financialData: result.financialData || null,
    insights: result.insights || [],
    provider: result.provider || 'groq',
    model: result.model || 'openai/gpt-oss-20b',
  };
}

module.exports = {
  processChatMessage,
  getOrCreateConversation,
  getConversationMessages,
  buildSystemPrompt,
  sanitizeLanguage,
  SUPPORTED_LANGUAGES,
};
