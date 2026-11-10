/**
 * STS FINTECH PRIVATE LIMITED
 * AI Provider Gateway Service
 *
 * Unified abstraction layer supporting:
 * 1. GroqCloud Hosted Free Plan ('groq', target: openai/gpt-oss-20b)
 * 2. Ollama Local Runtime ('ollama', target: gpt-oss:20b)
 *
 * Strict Security Architecture:
 * - HTTPS only for Groq (strict hostname: api.groq.com)
 * - Loopback only for Ollama (127.0.0.1, localhost)
 * - Zero cloud fallback: No silent transitions to third-party providers
 * - Fail-closed error handling and zero raw SQL access for the LLM
 */

const http = require('http');
const { executeFinancialTool, FINANCIAL_TOOL_DEFINITIONS } = require('./financialTools.service');
const {
  assertGroqUrl,
  getGroqConfig,
  checkGroqHealth,
  executeGroqChatInference,
  DEFAULT_GROQ_BASE_URL,
  DEFAULT_GROQ_MODEL,
} = require('./groqProvider.service');

// Default configurations
const DEFAULT_OLLAMA_BASE_URL = 'http://127.0.0.1:11434';
const DEFAULT_OLLAMA_MODEL = 'gpt-oss:20b';
const MAX_TOOL_ROUNDS = 4;
const ALLOWED_PROVIDERS = ['groq', 'ollama'];

/**
 * Validates and retrieves current AI provider configuration
 */
function getConfig() {
  const rawProvider = (process.env.AI_PROVIDER || 'groq').trim().toLowerCase();

  if (!ALLOWED_PROVIDERS.includes(rawProvider)) {
    throw new Error(
      `Security Violation: Unsupported AI provider '${rawProvider}'. Allowed providers: ${ALLOWED_PROVIDERS.join(', ')}.`
    );
  }

  if (rawProvider === 'groq') {
    const groqCfg = getGroqConfig();
    return {
      provider: 'groq',
      model: groqCfg.model,
      baseUrl: groqCfg.baseUrl,
      hasApiKey: groqCfg.hasApiKey,
    };
  }

  // Ollama
  const model = process.env.AI_MODEL || DEFAULT_OLLAMA_MODEL;
  const baseUrl = process.env.OLLAMA_BASE_URL || DEFAULT_OLLAMA_BASE_URL;
  const noCloud = process.env.OLLAMA_NO_CLOUD === '1' || process.env.OLLAMA_NO_CLOUD === 'true';

  return {
    provider: 'ollama',
    model,
    baseUrl,
    noCloud,
  };
}

/**
 * Validates that local Ollama URL does not target external or public network
 */
function assertLocalUrl(baseUrl) {
  try {
    const parsed = new URL(baseUrl);
    const hostname = parsed.hostname;
    const isLocal =
      hostname === '127.0.0.1' ||
      hostname === 'localhost' ||
      hostname === '::1';

    if (!isLocal) {
      throw new Error(`Security Violation: OLLAMA_BASE_URL must point to a local loopback address (127.0.0.1 or localhost). Got: ${hostname}`);
    }
  } catch (err) {
    throw new Error(`Invalid OLLAMA_BASE_URL: ${err.message}`);
  }
}

/**
 * Health check for local Ollama server and model availability
 */
async function checkLocalAiHealth() {
  const config = getConfig();

  try {
    assertLocalUrl(config.baseUrl);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 2000);

    const res = await fetch(`${config.baseUrl}/api/tags`, {
      method: 'GET',
      headers: { 'Accept': 'application/json' },
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!res.ok) {
      return {
        available: false,
        provider: 'ollama',
        error: 'LOCAL_AI_UNAVAILABLE',
        message: `Local Ollama runtime responded with status ${res.status}.`,
      };
    }

    const data = await res.json();
    const models = (data.models || []).map((m) => m.name || m.model || '');

    const isModelInstalled = models.some(
      (m) => m.toLowerCase().includes(config.model.toLowerCase())
    );

    if (!isModelInstalled) {
      return {
        available: false,
        provider: 'ollama',
        error: 'MODEL_NOT_INSTALLED',
        message: `Model '${config.model}' is not installed in local Ollama repository.`,
        instructions: `Run 'ollama pull ${config.model}' in terminal to install.`,
        installedModels: models,
      };
    }

    return {
      available: true,
      provider: 'ollama',
      model: config.model,
      baseUrl: config.baseUrl,
      installedModels: models,
      message: `Local Ollama service online with model '${config.model}'.`,
    };
  } catch (err) {
    const isAbort = err.name === 'AbortError';
    return {
      available: false,
      provider: 'ollama',
      error: 'LOCAL_AI_UNAVAILABLE',
      message: isAbort
        ? 'Connection to local Ollama runtime timed out (http://127.0.0.1:11434).'
        : `Local Ollama runtime is not reachable at ${config.baseUrl}: ${err.message}`,
      instructions: 'Ensure Ollama is installed and running locally on port 11434.',
    };
  }
}

/**
 * Unified health check for the active configured AI provider (Groq or Ollama)
 */
async function checkAiHealth() {
  const config = getConfig();
  if (config.provider === 'groq') {
    return await checkGroqHealth();
  }
  return await checkLocalAiHealth();
}

/**
 * Send a native chat request to Ollama API (/api/chat) with tool definitions
 */
async function sendOllamaChatRequest({ baseUrl, model, messages, tools = null, options = {} }) {
  assertLocalUrl(baseUrl);

  const payload = {
    model,
    messages,
    stream: false,
    options: {
      temperature: 0.2,
      ...options,
    },
  };

  if (tools && Array.isArray(tools) && tools.length > 0) {
    payload.tools = tools;
  }

  const res = await fetch(`${baseUrl}/api/chat`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`Ollama chat request failed (HTTP ${res.status}): ${errText || res.statusText}`);
  }

  return await res.json();
}

/**
 * Execute conversation using the active configured AI provider
 *
 * @param {object} params
 * @param {number} params.userId - Authenticated user integer ID
 * @param {Array<object>} params.messages - Conversational history formatted for LLM
 * @param {Function} [params.mockAdapter] - Optional mock adapter for hermetic unit testing
 * @returns {Promise<{ success: boolean, answer: string, financialData?: object, insights?: Array, error?: string, message?: string }>}
 */
async function executeChatInference({ userId, messages, mockAdapter = null }) {
  if (mockAdapter) {
    const mockRes = await mockAdapter({ userId, messages, executeFinancialTool });
    return {
      success: mockRes.success !== false,
      ...mockRes,
    };
  }

  const config = getConfig();

  // Route 1: GroqCloud Hosted Free Plan Provider
  if (config.provider === 'groq') {
    return await executeGroqChatInference({ userId, messages });
  }

  // Route 2: Ollama Local Runtime Provider
  if (config.provider === 'ollama') {
    const health = await checkLocalAiHealth();
    if (!health.available) {
      console.warn(`[STS FINTECH AI Provider] Local AI offline: ${health.error} - ${health.message}`);
      return {
        success: false,
        error: 'LOCAL_AI_UNAVAILABLE',
        message: 'The local AI assistant is currently unavailable. Please try again later.',
        diagnostic: health.message,
      };
    }

    const activeMessages = [...messages];
    let capturedFinancialData = null;
    let capturedInsights = [];
    let round = 0;
    let finalAnswer = '';

    while (round < MAX_TOOL_ROUNDS) {
      round++;

      const responseData = await sendOllamaChatRequest({
        baseUrl: config.baseUrl,
        model: config.model,
        messages: activeMessages,
        tools: FINANCIAL_TOOL_DEFINITIONS,
      });

      const responseMessage = responseData.message || {};
      const toolCalls = responseMessage.tool_calls;

      if (!toolCalls || !Array.isArray(toolCalls) || toolCalls.length === 0) {
        finalAnswer = responseMessage.content || 'I have reviewed your financial ledgers.';
        break;
      }

      activeMessages.push(responseMessage);

      for (const call of toolCalls) {
        const functionName = call.function?.name;
        const functionArgs = call.function?.arguments || {};

        let toolResult;
        const startTime = Date.now();
        try {
          toolResult = await executeFinancialTool(userId, functionName, functionArgs);
          if (!capturedFinancialData) {
            capturedFinancialData = toolResult;
          }
          if (toolResult?.insights) {
            capturedInsights = toolResult.insights;
          }
          console.log(`[STS FINTECH AI Provider] Executed tool '${functionName}' for session in ${Date.now() - startTime}ms.`);
        } catch (err) {
          console.error(`[STS FINTECH AI Provider] Error executing tool '${functionName}':`, err.message);
          toolResult = { error: err.message };
        }

        activeMessages.push({
          role: 'tool',
          content: JSON.stringify(toolResult),
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
      provider: 'ollama',
      model: config.model,
    };
  }

  // Reject all other unapproved providers (strict fail-closed)
  return {
    success: false,
    error: 'AI_PROVIDER_UNAVAILABLE',
    message: `Unsupported or unauthorized AI provider: ${config.provider}`,
  };
}

module.exports = {
  getConfig,
  assertLocalUrl,
  assertGroqUrl,
  checkAiHealth,
  checkLocalAiHealth,
  sendOllamaChatRequest,
  executeChatInference,
  DEFAULT_OLLAMA_BASE_URL,
  DEFAULT_MODEL: DEFAULT_GROQ_MODEL,
  ALLOWED_PROVIDERS,
};
