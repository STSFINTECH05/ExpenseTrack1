/**
 * STS FINTECH PRIVATE LIMITED
 * Financial Intelligence Engine (Routes)
 *
 * Provides authenticated, multi-user isolated endpoints for financial analytics,
 * category breakdowns, comparisons, and statistical insights.
 */

const express = require('express');
const router = express.Router();
const rateLimit = require('express-rate-limit');
const pool = require('../db');
const authenticate = require('../middleware/authenticate');
const {
  getFinancialOverview,
  getSpendingInsights,
  getMonthlyComparison,
  getYearlyComparison,
  getMonthlyHistory,
} = require('../services/aiIntelligence.service');
const {
  processChatMessage,
  getConversationMessages,
} = require('../services/aiChatbot.service');
const {
  checkAiHealth,
  checkLocalAiHealth,
} = require('../services/aiProvider.service');

// Rate limiting for conversational AI requests
const chatLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  message: {
    success: false,
    message: 'Too many chat requests. Please slow down and try again shortly.',
  },
  standardHeaders: true,
  legacyHeaders: false,
});

// All AI financial intelligence routes require authentication
router.use(authenticate);

/**
 * GET /api/ai/analytics
 * Supports:
 * - ?period=10d
 * - ?period=30d
 * - ?period=currentMonth
 * - ?period=yearly
 * - ?period=monthly
 * - ?period=custom&start_date=YYYY-MM-DD&end_date=YYYY-MM-DD
 */
router.get('/analytics', async (req, res) => {
  try {
    const userId = req.user.id;
    const { period = '30d', start_date, end_date } = req.query;

    const validPeriods = ['10d', '30d', 'currentMonth', 'yearly', 'monthly', 'custom'];
    if (period && !validPeriods.includes(period)) {
      return res.status(400).json({
        success: false,
        message: `Invalid period '${period}'. Supported periods: ${validPeriods.join(', ')}.`,
      });
    }

    if (period === 'monthly') {
      const history = await getMonthlyHistory(userId, 12);
      return res.status(200).json({
        success: true,
        period: 'monthly',
        currency: 'INR',
        data: history,
      });
    }

    const data = await getFinancialOverview(userId, {
      period,
      startDate: start_date,
      endDate: end_date,
    });

    return res.status(200).json(data);
  } catch (err) {
    console.error('[STS FINTECH AI] Analytics error:', err.message);
    const isValidationError =
      err.message.includes('Invalid custom date') ||
      err.message.includes('start_date cannot be later') ||
      err.message.includes('exceeds maximum allowed');

    return res.status(isValidationError ? 400 : 500).json({
      success: false,
      message: err.message || 'Failed to generate financial analytics.',
    });
  }
});

/**
 * GET /api/ai/insights
 * Standalone financial observations, budget warnings, and savings health
 */
router.get('/insights', async (req, res) => {
  try {
    const userId = req.user.id;
    const { period = '30d' } = req.query;

    const overview = await getFinancialOverview(userId, { period });

    return res.status(200).json({
      success: true,
      period: overview.period,
      dateRange: overview.dateRange,
      currency: 'INR',
      summary: overview.summary,
      highestSpendingCategory: overview.highestSpendingCategory,
      highestSpendingDay: overview.highestSpendingDay,
      insights: overview.insights,
    });
  } catch (err) {
    console.error('[STS FINTECH AI] Insights error:', err.message);
    return res.status(500).json({
      success: false,
      message: 'Failed to retrieve financial insights.',
      error: err.message,
    });
  }
});

/**
 * GET /api/ai/comparison/monthly
 * Detailed calendar month vs previous month comparison
 */
router.get('/comparison/monthly', async (req, res) => {
  try {
    const userId = req.user.id;
    const { date } = req.query;
    const comparison = await getMonthlyComparison(userId, date);
    return res.status(200).json({
      success: true,
      currency: 'INR',
      data: comparison,
    });
  } catch (err) {
    console.error('[STS FINTECH AI] Monthly comparison error:', err.message);
    return res.status(500).json({
      success: false,
      message: 'Failed to retrieve monthly comparison.',
      error: err.message,
    });
  }
});

/**
 * GET /api/ai/comparison/yearly
 * Detailed year vs previous year comparison
 */
router.get('/comparison/yearly', async (req, res) => {
  try {
    const userId = req.user.id;
    const { year } = req.query;
    const comparison = await getYearlyComparison(userId, year);
    return res.status(200).json({
      success: true,
      currency: 'INR',
      data: comparison,
    });
  } catch (err) {
    console.error('[STS FINTECH AI] Yearly comparison error:', err.message);
    return res.status(500).json({
      success: false,
      message: 'Failed to retrieve yearly comparison.',
      error: err.message,
    });
  }
});

/**
 * POST /api/ai/chat
 * Multi-turn conversational financial advisory endpoint
 * Body: { message, language, conversationId }
 */
router.post('/chat', chatLimiter, async (req, res) => {
  try {
    const userId = req.user.id;
    const userName = req.user.name || 'Valued User';
    const { message, language = 'en-IN', conversationId } = req.body || {};

    if (!message || typeof message !== 'string' || message.trim().length === 0) {
      return res.status(400).json({
        success: false,
        message: 'Message is required and must be a non-empty string.',
      });
    }

    if (message.length > 4000) {
      return res.status(400).json({
        success: false,
        message: 'Message exceeds maximum length of 4000 characters.',
      });
    }

    const result = await processChatMessage({
      userId,
      userName,
      message: message.trim(),
      language,
      conversationId,
    });

    if (!result.success) {
      if (result.error === 'AI_RATE_LIMIT_REACHED') {
        return res.status(429).json({
          success: false,
          error: 'AI_RATE_LIMIT_REACHED',
          message: 'The AI assistant has reached its current usage limit. Please try again later.',
        });
      }

      const isProviderUnavailable = [
        'GROQ_API_KEY_MISSING',
        'AI_PROVIDER_UNAVAILABLE',
        'LOCAL_AI_UNAVAILABLE',
        'MODEL_NOT_INSTALLED',
        'MODEL_UNAVAILABLE',
        'INVALID_GROQ_API_KEY',
        'GROQ_ACCESS_FORBIDDEN',
        'GROQ_TIMEOUT',
        'GROQ_UNREACHABLE',
        'AI_INFERENCE_ERROR',
      ].includes(result.error);

      if (isProviderUnavailable) {
        return res.status(503).json(result);
      }
      return res.status(400).json(result);
    }

    return res.status(200).json(result);
  } catch (err) {
    console.error('[STS FINTECH AI] Chat error:', err.message);
    const isNotFound =
      err.message.includes('not found') || err.message.includes('access denied');
    const isValidation =
      err.message.includes('Invalid conversation ID') ||
      err.message.includes('cannot be empty');

    const status = isNotFound ? 404 : isValidation ? 400 : 500;
    return res.status(status).json({
      success: false,
      message: err.message || 'Failed to process AI chat message.',
    });
  }
});

/**
 * GET /api/ai/health
 * Check active AI provider availability, models, and configuration
 */
router.get('/health', async (req, res) => {
  try {
    const health = await checkAiHealth();
    return res.status(health.available ? 200 : 503).json(health);
  } catch (err) {
    return res.status(500).json({
      available: false,
      error: 'HEALTH_CHECK_ERROR',
      message: err.message,
    });
  }
});

/**
 * GET /api/ai/conversations
 * List recent conversation threads for authenticated user
 */
router.get('/conversations', async (req, res) => {
  try {
    const userId = req.user.id;
    const result = await pool.query(
      `SELECT id, title, language, created_at, updated_at
       FROM ai_conversations
       WHERE user_id = $1
       ORDER BY updated_at DESC
       LIMIT 20;`,
      [userId]
    );
    return res.status(200).json({
      success: true,
      data: result.rows,
    });
  } catch (err) {
    console.error('[STS FINTECH AI] Conversations list error:', err.message);
    return res.status(500).json({
      success: false,
      message: 'Failed to retrieve conversation history.',
      error: err.message,
    });
  }
});

/**
 * GET /api/ai/conversations/:id/messages
 * Retrieve messages in a specific conversation thread
 */
router.get('/conversations/:id/messages', async (req, res) => {
  try {
    const userId = req.user.id;
    const { id } = req.params;

    // Verify ownership
    const check = await pool.query(
      `SELECT id FROM ai_conversations WHERE id = $1 AND user_id = $2;`,
      [id, userId]
    );
    if (check.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Conversation not found or access denied.',
      });
    }

    const messages = await getConversationMessages(id, 50);
    return res.status(200).json({
      success: true,
      conversationId: id,
      data: messages,
    });
  } catch (err) {
    console.error('[STS FINTECH AI] Messages error:', err.message);
    return res.status(500).json({
      success: false,
      message: 'Failed to retrieve conversation messages.',
      error: err.message,
    });
  }
});

module.exports = router;

