/**
 * STS FINTECH PRIVATE LIMITED
 * GroqCloud AI Provider Adapter Service
 *
 * Implements privacy-hardened, zero-API-cost inference via GroqCloud Free Plan.
 * Target Model: openai/gpt-oss-20b
 * Connects EXCLUSIVELY to https://api.groq.com/openai/v1.
 * Enforces strict endpoint validation, financial data minimization, and fail-closed security.
 */

const OpenAI = require('openai');
const { executeFinancialTool, FINANCIAL_TOOL_DEFINITIONS } = require('./financialTools.service');

// Default configurations
const DEFAULT_GROQ_BASE_URL = 'https://api.groq.com/openai/v1';
const DEFAULT_GROQ_MODEL = 'openai/gpt-oss-20b';
const MAX_TOOL_ROUNDS = 4;
const DEFAULT_TIMEOUT_MS = 45000;

/**
 * Strict endpoint validator for GroqCloud API
 * Requires HTTPS and strictly permits only 'api.groq.com'.
 * Rejects localhost, plain HTTP, and arbitrary third-party endpoints.
 *
 * @param {string} rawUrl
 * @returns {boolean}
 */
function assertGroqUrl(rawUrl) {
  if (!rawUrl || typeof rawUrl !== 'string') {
    throw new Error('Security Violation: GROQ_BASE_URL must be a non-empty string.');
  }

  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch (err) {
    throw new Error(`Security Violation: Malformed GROQ_BASE_URL: ${err.message}`);
  }

  if (parsed.protocol !== 'https:') {
    throw new Error(`Security Violation: HTTPS is strictly required for Groq Cloud API. Got protocol: ${parsed.protocol}`);
  }

  const hostname = parsed.hostname.toLowerCase();
  if (hostname !== 'api.groq.com') {
    throw new Error(`Security Violation: GROQ_BASE_URL hostname must be strictly 'api.groq.com'. Got: ${hostname}`);
  }

  // Reject localhost or loopback variants
  if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1') {
    throw new Error('Security Violation: Localhost endpoints are rejected for Groq provider.');
  }

  return true;
}

/**
 * Redacted structured logging helper to avoid logging API keys or confidential financial data
 */
function redactLog(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  const sanitized = Array.isArray(obj) ? [] : {};
  for (const [key, value] of Object.entries(obj)) {
    const lowerKey = key.toLowerCase();
    if (
      lowerKey.includes('key') ||
      lowerKey.includes('secret') ||
      lowerKey.includes('token') ||
      lowerKey.includes('auth') ||
      lowerKey.includes('password') ||
      lowerKey.includes('cookie')
    ) {
      sanitized[key] = '[REDACTED]';
    } else if (typeof value === 'object' && value !== null) {
      sanitized[key] = redactLog(value);
    } else {
      sanitized[key] = value;
    }
  }
  return sanitized;
}

/**
 * Financial Data Minimization: Strips raw transactions, user IDs, and internal metadata
 * before forwarding aggregated financial numbers to Groq LLM context.
 */
function minimizeFinancialToolResult(toolName, result) {
  if (!result || typeof result !== 'object') {
    return result;
  }

  if (result.error) {
    return { error: result.error };
  }

  const minimized = {
    currency: result.currency || 'INR',
    period: result.period || undefined,
    dateRange: result.dateRange || undefined,
    startDate: result.startDate || undefined,
    endDate: result.endDate || undefined,
  };

  if (result.totalExpenses !== undefined) {
    minimized.totalExpenses = result.totalExpenses;
  }
  if (result.totalIncome !== undefined) {
    minimized.totalIncome = result.totalIncome;
  }
  if (result.totalSavings !== undefined) {
    minimized.totalSavings = result.totalSavings;
  }
  if (result.count !== undefined) {
    minimized.count = result.count;
  }

  if (result.summary) {
    minimized.summary = {
      totalIncome: result.summary.totalIncome ?? 0,
      totalExpenses: result.summary.totalExpenses ?? 0,
      netSavings: result.summary.netSavings ?? 0,
      savingsRate: result.summary.savingsRate ?? 0,
      transactionCount: result.summary.transactionCount ?? 0,
    };
  }

  if (result.categoryBreakdown && Array.isArray(result.categoryBreakdown)) {
    minimized.categoryBreakdown = result.categoryBreakdown.map((c) => ({
      category: c.category,
      amount: c.amount,
      percentage: c.percentage,
    }));
  }

  if (result.categories && Array.isArray(result.categories)) {
    minimized.categories = result.categories.map((c) => ({
      category: c.category,
      amount: c.amount,
      percentage: c.percentage,
    }));
  }

  if (result.highestSpendingCategory) {
    minimized.highestSpendingCategory = {
      category: result.highestSpendingCategory.category,
      amount: result.highestSpendingCategory.amount,
      percentage: result.highestSpendingCategory.percentage,
    };
  }

  if (result.dailyTrends && Array.isArray(result.dailyTrends)) {
    minimized.dailyTrends = result.dailyTrends.map((d) => ({
      date: d.date,
      expense: d.expense,
      income: d.income,
    }));
  }

  if (result.dailyBreakdown && Array.isArray(result.dailyBreakdown)) {
    minimized.dailyBreakdown = result.dailyBreakdown.map((d) => ({
      date: d.date,
      totalAmount: d.totalAmount,
    }));
  }

  if (result.insights && Array.isArray(result.insights)) {
    minimized.insights = result.insights.map((i) => ({
      type: i.type,
      title: i.title,
      message: i.message,
    }));
  }

  if (result.currentMonth && result.previousMonth) {
    minimized.currentMonth = {
      month: result.currentMonth.month,
      income: result.currentMonth.income,
      expenses: result.currentMonth.expenses,
      savings: result.currentMonth.savings,
    };
    minimized.previousMonth = {
      month: result.previousMonth.month,
      income: result.previousMonth.income,
      expenses: result.previousMonth.expenses,
      savings: result.previousMonth.savings,
    };
    if (result.changes) minimized.changes = result.changes;
  }

  if (result.currentYear && result.previousYear) {
    minimized.currentYear = result.currentYear;
    minimized.previousYear = result.previousYear;
    if (result.changes) minimized.changes = result.changes;
  }

  return minimized;
}

/**
 * Retrieve active Groq configuration from environment
 */
function getGroqConfig() {
  const baseUrl = process.env.GROQ_BASE_URL || DEFAULT_GROQ_BASE_URL;
  const model = process.env.AI_MODEL || DEFAULT_GROQ_MODEL;
  const apiKey = (process.env.GROQ_API_KEY || '').trim();

  // Validate URL on load
  assertGroqUrl(baseUrl);

  return {
    provider: 'groq',
    baseUrl,
    model,
    apiKey,
    hasApiKey: apiKey.length > 0,
  };
}

/**
 * Health check for GroqCloud connectivity and model availability
 *
 * @returns {Promise<{ available: boolean, error?: string, message: string, provider: string, model: string }>}
 */
async function checkGroqHealth() {
  const config = getGroqConfig();

  if (!config.hasApiKey) {
    return {
      available: false,
      provider: 'groq',
      model: config.model,
      baseUrl: config.baseUrl,
      error: 'GROQ_API_KEY_MISSING',
      message: 'Groq API key is not configured in backend environment.',
      instructions: 'Add GROQ_API_KEY to ExpenseTrack1/.env to enable Groq Free Tier inference.',
    };
  }

  try {
    assertGroqUrl(config.baseUrl);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);

    const res = await fetch(`${config.baseUrl}/models`, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${config.apiKey}`,
        'Accept': 'application/json',
      },
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (res.status === 401) {
      return {
        available: false,
        provider: 'groq',
        model: config.model,
        error: 'INVALID_GROQ_API_KEY',
        message: 'The configured Groq API key was rejected (HTTP 401 Unauthorized).',
        instructions: 'Verify your Groq API key in https://console.groq.com/keys.',
      };
    }

    if (res.status === 429) {
      return {
        available: false,
        provider: 'groq',
        model: config.model,
        error: 'AI_RATE_LIMIT_REACHED',
        message: 'The AI assistant has reached its current usage limit. Please try again later.',
      };
    }

    if (!res.ok) {
      return {
        available: false,
        provider: 'groq',
        model: config.model,
        error: 'GROQ_UNAVAILABLE',
        message: `GroqCloud API responded with status ${res.status}.`,
      };
    }

    const data = await res.json();
    const models = (data.data || []).map((m) => m.id);
    const isModelAvailable = models.some((id) =>
      id.toLowerCase() === config.model.toLowerCase() ||
      id.toLowerCase().includes('gpt-oss-20b')
    );

    return {
      available: true,
      provider: 'groq',
      model: config.model,
      baseUrl: config.baseUrl,
      modelAvailable: isModelAvailable,
      message: `GroqCloud API online with model '${config.model}'.`,
    };
  } catch (err) {
    const isAbort = err.name === 'AbortError';
    return {
      available: false,
      provider: 'groq',
      model: config.model,
      error: isAbort ? 'GROQ_TIMEOUT' : 'GROQ_UNREACHABLE',
      message: isAbort
        ? 'Connection to Groq API timed out.'
        : `Groq API is unreachable: ${err.message}`,
    };
  }
}

/**
 * Execute conversation with GroqCloud using bounded financial function calling
 *
 * @param {object} params
 * @param {number} params.userId - Authenticated user integer ID
 * @param {Array<object>} params.messages - Conversational history formatted for OpenAI/Groq API
 * @param {Function} [params.mockAdapter] - Optional mock adapter for hermetic unit testing
 * @returns {Promise<{ success: boolean, answer: string, financialData?: object, insights?: Array, error?: string, message?: string }>}
 */
async function executeGroqChatInference({ userId, messages, mockAdapter = null }) {
  if (mockAdapter) {
    const mockRes = await mockAdapter({ userId, messages, executeFinancialTool });
    return {
      success: mockRes.success !== false,
      ...mockRes,
    };
  }

  const config = getGroqConfig();

  if (!config.hasApiKey) {
    return {
      success: false,
      error: 'GROQ_API_KEY_MISSING',
      message: 'Groq API key is not configured. Please configure GROQ_API_KEY in the backend environment.',
    };
  }

  assertGroqUrl(config.baseUrl);

  // Initialize OpenAI SDK instance strictly targeted at GroqCloud
  // maxRetries: 0 enforces Free Plan protection (avoids automatic retry loops that consume quota)
  const groqClient = new OpenAI({
    baseURL: config.baseUrl,
    apiKey: config.apiKey,
    timeout: DEFAULT_TIMEOUT_MS,
    maxRetries: 0,
  });

  const activeMessages = [...messages];
  let capturedFinancialData = null;
  let capturedInsights = [];
  let round = 0;
  let finalAnswer = '';

  try {
    while (round < MAX_TOOL_ROUNDS) {
      round++;

      const completion = await groqClient.chat.completions.create({
        model: config.model,
        messages: activeMessages,
        tools: FINANCIAL_TOOL_DEFINITIONS,
        tool_choice: 'auto',
        temperature: 0.2, // Low temperature for deterministic financial precision
      });

      const choice = completion.choices?.[0];
      const responseMessage = choice?.message;

      if (!responseMessage) {
        throw new Error('Groq API returned an empty completion choice.');
      }

      const toolCalls = responseMessage.tool_calls;

      // If model returned a direct text response with no tool calls, completion is reached
      if (!toolCalls || !Array.isArray(toolCalls) || toolCalls.length === 0) {
        finalAnswer = responseMessage.content || 'I have reviewed your financial ledgers.';
        break;
      }

      // Append assistant's tool-call request to conversational state
      activeMessages.push(responseMessage);

      // Execute each vetted tool requested by model
      for (const call of toolCalls) {
        const functionName = call.function?.name;
        let functionArgs = {};
        try {
          functionArgs = typeof call.function?.arguments === 'string'
            ? JSON.parse(call.function.arguments || '{}')
            : (call.function?.arguments || {});
        } catch (parseErr) {
          console.warn('[STS FINTECH Groq] Malformed tool arguments JSON from model:', parseErr.message);
          functionArgs = {};
        }

        let rawToolResult;
        const startTime = Date.now();
        try {
          // Strictly derive userId from session; LLM has zero direct SQL execution
          rawToolResult = await executeFinancialTool(userId, functionName, functionArgs);
          if (!capturedFinancialData) {
            capturedFinancialData = rawToolResult;
          }
          if (rawToolResult?.insights) {
            capturedInsights = rawToolResult.insights;
          }
          console.log(`[STS FINTECH Groq] Executed financial tool '${functionName}' in ${Date.now() - startTime}ms.`);
        } catch (err) {
          console.error(`[STS FINTECH Groq] Tool execution error for '${functionName}':`, err.message);
          rawToolResult = { error: err.message };
        }

        // Apply financial data minimization before sending output back to Groq
        const minimizedResult = minimizeFinancialToolResult(functionName, rawToolResult);

        activeMessages.push({
          role: 'tool',
          tool_call_id: call.id,
          content: JSON.stringify(minimizedResult),
        });
      }
    }

    if (!finalAnswer && round >= MAX_TOOL_ROUNDS) {
      finalAnswer = 'Financial analysis completed across your active ledger records.';
    }

    return {
      success: true,
      answer: finalAnswer,
      financialData: capturedFinancialData,
      insights: capturedInsights,
      provider: 'groq',
      model: config.model,
    };
  } catch (err) {
    const status = err.status || err.statusCode;

    // Rate-limit handling (HTTP 429)
    if (status === 429 || (err.message && err.message.includes('429'))) {
      console.warn('[STS FINTECH Groq] Rate limit reached on Groq Free Plan.');
      return {
        success: false,
        error: 'AI_RATE_LIMIT_REACHED',
        message: 'The AI assistant has reached its current usage limit. Please try again later.',
      };
    }

    // Invalid API Key (HTTP 401)
    if (status === 401 || (err.message && err.message.includes('401'))) {
      console.error('[STS FINTECH Groq] Invalid Groq API key.');
      return {
        success: false,
        error: 'INVALID_GROQ_API_KEY',
        message: 'Authentication with Groq API failed. Please check your GROQ_API_KEY.',
      };
    }

    // Access forbidden (HTTP 403)
    if (status === 403 || (err.message && err.message.includes('403'))) {
      console.error('[STS FINTECH Groq] Groq model access forbidden.');
      return {
        success: false,
        error: 'GROQ_ACCESS_FORBIDDEN',
        message: 'Access to the requested Groq model was forbidden. Check model access permissions.',
      };
    }

    // Model unavailable / not found (HTTP 404)
    if (status === 404 || (err.message && err.message.includes('404'))) {
      console.error('[STS FINTECH Groq] Model unavailable.');
      return {
        success: false,
        error: 'MODEL_UNAVAILABLE',
        message: `The model '${config.model}' is currently unavailable on Groq Free Tier.`,
      };
    }

    // Timeout
    if (err.name === 'AbortError' || err.code === 'ETIMEDOUT' || err.message?.includes('timeout')) {
      console.error('[STS FINTECH Groq] Inference timeout.');
      return {
        success: false,
        error: 'GROQ_TIMEOUT',
        message: 'The request to Groq AI timed out. Please try again.',
      };
    }

    console.error('[STS FINTECH Groq] Chat inference error:', err.message);
    return {
      success: false,
      error: 'AI_INFERENCE_ERROR',
      message: 'Failed to complete AI financial analysis.',
    };
  }
}

module.exports = {
  assertGroqUrl,
  getGroqConfig,
  checkGroqHealth,
  executeGroqChatInference,
  minimizeFinancialToolResult,
  DEFAULT_GROQ_BASE_URL,
  DEFAULT_GROQ_MODEL,
};
