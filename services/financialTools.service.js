/**
 * STS FINTECH PRIVATE LIMITED
 * Controlled Financial Tools Service for AI Chatbot
 *
 * Exposes validated, user-isolated financial intelligence functions to the LLM.
 * Reuses existing functions in aiIntelligence.service.js.
 * LLM has NO direct database access and cannot execute arbitrary SQL.
 */

const {
  getFinancialOverview,
  getIncomeSummary,
  getExpenseSummary,
  getSavingsSummary,
  getDailySpending,
  getSpendingByCategory,
  getTopSpendingCategories,
  getMonthlyComparison,
  getMonthlyHistory,
  getYearlyComparison,
  getSpendingInsights,
} = require('./aiIntelligence.service');

// Helper to calculate date boundaries
function getDateBoundaries(period = '30d', customStart = null, customEnd = null) {
  const now = new Date();
  const todayStr = now.toISOString().split('T')[0];

  const addDays = (dStr, days) => {
    const d = new Date(dStr);
    d.setDate(d.getDate() + days);
    return d.toISOString().split('T')[0];
  };

  if (period === '10d') {
    return { startDate: addDays(todayStr, -9), endDate: todayStr };
  } else if (period === '30d') {
    return { startDate: addDays(todayStr, -29), endDate: todayStr };
  } else if (period === 'currentMonth') {
    const start = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;
    return { startDate: start, endDate: todayStr };
  } else if (period === 'yearly') {
    return { startDate: `${now.getFullYear()}-01-01`, endDate: `${now.getFullYear()}-12-31` };
  } else if (period === 'custom') {
    if (!customStart || !customEnd) {
      throw new Error('startDate and endDate (YYYY-MM-DD) are required for custom period.');
    }
    if (customStart > customEnd) {
      throw new Error('startDate cannot be later than endDate.');
    }
    return { startDate: customStart, endDate: customEnd };
  }

  // Fallback to 30d
  return { startDate: addDays(todayStr, -29), endDate: todayStr };
}

/**
 * Tool Specifications for OpenAI Function Calling (tools parameter)
 */
const FINANCIAL_TOOL_DEFINITIONS = [
  {
    type: 'function',
    function: {
      name: 'getFinancialOverview',
      description: 'Get comprehensive financial overview including total income, total expenses, net savings, savings rate, category breakdown, highest spending category, and daily progression.',
      parameters: {
        type: 'object',
        properties: {
          period: {
            type: 'string',
            enum: ['10d', '30d', 'currentMonth', 'yearly', 'custom'],
            description: 'Reporting period: 10d (last 10 days), 30d (last 30 days), currentMonth, yearly, or custom.',
          },
          startDate: {
            type: 'string',
            description: 'Optional start date in YYYY-MM-DD format (used for custom period).',
          },
          endDate: {
            type: 'string',
            description: 'Optional end date in YYYY-MM-DD format (used for custom period).',
          },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'getIncomeSummary',
      description: 'Get total income inflow and number of credit entries for a specified period or date range.',
      parameters: {
        type: 'object',
        properties: {
          period: {
            type: 'string',
            enum: ['10d', '30d', 'currentMonth', 'yearly', 'custom'],
            description: 'Reporting period.',
          },
          startDate: { type: 'string', description: 'Start date (YYYY-MM-DD).' },
          endDate: { type: 'string', description: 'End date (YYYY-MM-DD).' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'getExpenseSummary',
      description: 'Get total expense outflow and number of debit transactions for a specified period or date range.',
      parameters: {
        type: 'object',
        properties: {
          period: {
            type: 'string',
            enum: ['10d', '30d', 'currentMonth', 'yearly', 'custom'],
            description: 'Reporting period.',
          },
          startDate: { type: 'string', description: 'Start date (YYYY-MM-DD).' },
          endDate: { type: 'string', description: 'End date (YYYY-MM-DD).' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'getSavingsSummary',
      description: 'Get total income, total expenses, net savings (surplus/deficit), savings rate percentage, and average daily expense.',
      parameters: {
        type: 'object',
        properties: {
          period: {
            type: 'string',
            enum: ['10d', '30d', 'currentMonth', 'yearly', 'custom'],
            description: 'Reporting period.',
          },
          startDate: { type: 'string', description: 'Start date (YYYY-MM-DD).' },
          endDate: { type: 'string', description: 'End date (YYYY-MM-DD).' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'getSpendingByCategory',
      description: 'Get detailed expenditure breakdown across all categories, including amount, percentage of total expenses, and period trends.',
      parameters: {
        type: 'object',
        properties: {
          period: {
            type: 'string',
            enum: ['10d', '30d', 'currentMonth', 'yearly', 'custom'],
            description: 'Reporting period.',
          },
          startDate: { type: 'string', description: 'Start date (YYYY-MM-DD).' },
          endDate: { type: 'string', description: 'End date (YYYY-MM-DD).' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'getTopSpendingCategories',
      description: 'Get top spending categories ranked by total expenditure amount (default top 5).',
      parameters: {
        type: 'object',
        properties: {
          limit: {
            type: 'integer',
            description: 'Number of top categories to return (default 5, maximum 10).',
          },
          period: {
            type: 'string',
            enum: ['10d', '30d', 'currentMonth', 'yearly', 'custom'],
            description: 'Reporting period.',
          },
          startDate: { type: 'string', description: 'Start date (YYYY-MM-DD).' },
          endDate: { type: 'string', description: 'End date (YYYY-MM-DD).' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'getDailySpending',
      description: 'Get day-by-day expenditure breakdown and identify the peak single-day spending day.',
      parameters: {
        type: 'object',
        properties: {
          period: {
            type: 'string',
            enum: ['10d', '30d', 'currentMonth', 'yearly', 'custom'],
            description: 'Reporting period.',
          },
          startDate: { type: 'string', description: 'Start date (YYYY-MM-DD).' },
          endDate: { type: 'string', description: 'End date (YYYY-MM-DD).' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'getMonthlyComparison',
      description: 'Compare current calendar month performance against the previous calendar month, including income, expense, and savings deltas with percentage changes.',
      parameters: {
        type: 'object',
        properties: {
          targetDate: {
            type: 'string',
            description: 'Optional reference date in YYYY-MM-DD format (defaults to current date).',
          },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'getYearlyComparison',
      description: 'Compare current year performance against the previous calendar year, including monthly breakdowns and yearly deltas.',
      parameters: {
        type: 'object',
        properties: {
          targetYear: {
            type: 'integer',
            description: 'Target year to compare (e.g., 2026). Defaults to current year.',
          },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'getFinancialInsights',
      description: 'Get deterministic rule-based statistical observations, deficit alerts, savings benchmark status, and category surge observations.',
      parameters: {
        type: 'object',
        properties: {
          period: {
            type: 'string',
            enum: ['10d', '30d', 'currentMonth', 'yearly'],
            description: 'Reporting period for evaluating statistical observations.',
          },
        },
      },
    },
  },
];

/**
 * Execute a controlled financial tool on behalf of the authenticated user.
 * Validates inputs strictly and calls existing methods in aiIntelligence.service.js.
 *
 * @param {number} userId - Authenticated user ID (derived from session)
 * @param {string} toolName - Name of the function to execute
 * @param {object} args - Arguments passed by the LLM
 * @returns {Promise<object>} - Execution result
 */
async function executeFinancialTool(userId, toolName, args = {}) {
  if (!userId || typeof userId !== 'number') {
    throw new Error('Valid integer userId is required to execute financial tools.');
  }

  const safeArgs = args && typeof args === 'object' ? args : {};

  switch (toolName) {
    case 'getFinancialOverview': {
      const period = safeArgs.period || '30d';
      return await getFinancialOverview(userId, {
        period,
        startDate: safeArgs.startDate,
        endDate: safeArgs.endDate,
      });
    }

    case 'getIncomeSummary': {
      const { startDate, endDate } = getDateBoundaries(
        safeArgs.period || '30d',
        safeArgs.startDate,
        safeArgs.endDate
      );
      const summary = await getIncomeSummary(userId, startDate, endDate);
      return {
        startDate,
        endDate,
        currency: 'INR',
        ...summary,
      };
    }

    case 'getExpenseSummary': {
      const { startDate, endDate } = getDateBoundaries(
        safeArgs.period || '30d',
        safeArgs.startDate,
        safeArgs.endDate
      );
      const summary = await getExpenseSummary(userId, startDate, endDate);
      return {
        startDate,
        endDate,
        currency: 'INR',
        ...summary,
      };
    }

    case 'getSavingsSummary': {
      const { startDate, endDate } = getDateBoundaries(
        safeArgs.period || '30d',
        safeArgs.startDate,
        safeArgs.endDate
      );
      const summary = await getSavingsSummary(userId, startDate, endDate);
      return {
        startDate,
        endDate,
        currency: 'INR',
        ...summary,
      };
    }

    case 'getSpendingByCategory': {
      const { startDate, endDate } = getDateBoundaries(
        safeArgs.period || '30d',
        safeArgs.startDate,
        safeArgs.endDate
      );
      const result = await getSpendingByCategory(userId, startDate, endDate);
      return {
        startDate,
        endDate,
        currency: 'INR',
        ...result,
      };
    }

    case 'getTopSpendingCategories': {
      const { startDate, endDate } = getDateBoundaries(
        safeArgs.period || '30d',
        safeArgs.startDate,
        safeArgs.endDate
      );
      const limit = Math.min(10, Math.max(1, parseInt(safeArgs.limit, 10) || 5));
      const categories = await getTopSpendingCategories(userId, startDate, endDate, limit);
      return {
        startDate,
        endDate,
        currency: 'INR',
        limit,
        categories,
      };
    }

    case 'getDailySpending': {
      const { startDate, endDate } = getDateBoundaries(
        safeArgs.period || '30d',
        safeArgs.startDate,
        safeArgs.endDate
      );
      const result = await getDailySpending(userId, startDate, endDate);
      return {
        startDate,
        endDate,
        currency: 'INR',
        ...result,
      };
    }

    case 'getMonthlyComparison': {
      const result = await getMonthlyComparison(userId, safeArgs.targetDate);
      return {
        currency: 'INR',
        ...result,
      };
    }

    case 'getYearlyComparison': {
      const result = await getYearlyComparison(userId, safeArgs.targetYear);
      return {
        currency: 'INR',
        ...result,
      };
    }

    case 'getFinancialInsights': {
      const period = safeArgs.period || '30d';
      const overview = await getFinancialOverview(userId, { period });
      return {
        period,
        currency: 'INR',
        summary: overview.summary,
        highestSpendingCategory: overview.highestSpendingCategory,
        highestSpendingDay: overview.highestSpendingDay,
        insights: overview.insights,
      };
    }

    default:
      throw new Error(`Unknown financial tool: '${toolName}'`);
  }
}

module.exports = {
  FINANCIAL_TOOL_DEFINITIONS,
  executeFinancialTool,
  getDateBoundaries,
};
