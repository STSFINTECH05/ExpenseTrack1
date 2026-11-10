/**
 * STS FINTECH PRIVATE LIMITED
 * Financial Intelligence Engine (Service)
 *
 * Provides deterministic, multi-user isolated statistical financial analytics,
 * category breakdowns, period comparisons, spending trends, and rule-based insights.
 *
 * Source of truth: `segregation` table (strictly isolated by req.user.id).
 * NOTE: Never combines segregation and finance_records to prevent duplicate counting.
 */

const pool = require('../db');

// =============================================================================
// Date Helper Utilities (YYYY-MM-DD)
// =============================================================================
function formatDateString(date) {
  const d = new Date(date);
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function parseDateInput(str) {
  if (!str || typeof str !== 'string') return null;
  const match = str.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  const d = new Date(str);
  if (isNaN(d.getTime())) return null;
  return str;
}

function addDays(dateStr, days) {
  const d = new Date(dateStr);
  d.setDate(d.getDate() + days);
  return formatDateString(d);
}

function getDaysDifference(startDateStr, endDateStr) {
  const d1 = new Date(startDateStr);
  const d2 = new Date(endDateStr);
  const diffTime = Math.abs(d2 - d1);
  return Math.ceil(diffTime / (1000 * 60 * 60 * 24)) + 1;
}

// =============================================================================
// 1. Income & Expense Summaries
// =============================================================================
async function getIncomeSummary(userId, startDate, endDate) {
  const query = `
    SELECT
      COALESCE(SUM(amount), 0)::numeric AS total_income,
      COUNT(*)::int AS count
    FROM segregation
    WHERE user_id = $1
      AND type IN ('additional_income', 'fixed_income')
      AND date >= $2 AND date <= $3;
  `;
  const res = await pool.query(query, [userId, startDate, endDate]);
  return {
    totalIncome: parseFloat(res.rows[0]?.total_income) || 0,
    count: parseInt(res.rows[0]?.count, 10) || 0,
  };
}

async function getExpenseSummary(userId, startDate, endDate) {
  const query = `
    SELECT
      COALESCE(SUM(amount), 0)::numeric AS total_expenses,
      COUNT(*)::int AS count
    FROM segregation
    WHERE user_id = $1
      AND type IN ('additional_expense', 'fixed_expense', 'bill')
      AND date >= $2 AND date <= $3;
  `;
  const res = await pool.query(query, [userId, startDate, endDate]);
  return {
    totalExpenses: parseFloat(res.rows[0]?.total_expenses) || 0,
    count: parseInt(res.rows[0]?.count, 10) || 0,
  };
}

// =============================================================================
// 2. Savings Summary
// =============================================================================
async function getSavingsSummary(userId, startDate, endDate) {
  const [inc, exp] = await Promise.all([
    getIncomeSummary(userId, startDate, endDate),
    getExpenseSummary(userId, startDate, endDate),
  ]);

  const totalIncome = inc.totalIncome;
  const totalExpenses = exp.totalExpenses;
  const totalSavings = Math.round((totalIncome - totalExpenses) * 100) / 100;
  const savingsRate =
    totalIncome > 0
      ? Math.round(((totalSavings / totalIncome) * 100) * 100) / 100
      : 0;

  const totalDays = Math.max(1, getDaysDifference(startDate, endDate));
  const averageDailyExpense =
    Math.round((totalExpenses / totalDays) * 100) / 100;

  return {
    totalIncome,
    totalExpenses,
    totalSavings,
    savingsRate,
    averageDailyExpense,
    totalTransactions: inc.count + exp.count,
    incomeCount: inc.count,
    expenseCount: exp.count,
    totalDays,
  };
}

// =============================================================================
// 3. Daily Spending Breakdown
// =============================================================================
async function getDailySpending(userId, startDate, endDate) {
  const query = `
    SELECT
      date::text AS date,
      COALESCE(SUM(CASE WHEN type IN ('additional_income', 'fixed_income') THEN amount ELSE 0 END), 0)::numeric AS income,
      COALESCE(SUM(CASE WHEN type IN ('additional_expense', 'fixed_expense', 'bill') THEN amount ELSE 0 END), 0)::numeric AS expense,
      COUNT(*)::int AS count
    FROM segregation
    WHERE user_id = $1
      AND date >= $2 AND date <= $3
    GROUP BY date
    ORDER BY date ASC;
  `;
  const res = await pool.query(query, [userId, startDate, endDate]);

  let highestSpendingDay = null;
  let maxExpense = -1;

  const dailyList = (res.rows || []).map((r) => {
    const expense = parseFloat(r.expense) || 0;
    const income = parseFloat(r.income) || 0;
    const net = Math.round((income - expense) * 100) / 100;

    if (expense > maxExpense && expense > 0) {
      maxExpense = expense;
      highestSpendingDay = {
        date: r.date,
        amount: expense,
      };
    }

    return {
      date: r.date,
      income,
      expense,
      net,
      transactionCount: parseInt(r.count, 10) || 0,
    };
  });

  return {
    dailyBreakdown: dailyList,
    highestSpendingDay,
  };
}

// =============================================================================
// 4. Spending By Category & Top Categories
// =============================================================================
async function getSpendingByCategory(userId, startDate, endDate, prevStartDate = null, prevEndDate = null) {
  // Current period category query
  const query = `
    SELECT
      COALESCE(NULLIF(TRIM(category), ''), 'Uncategorized') AS category,
      COALESCE(SUM(amount), 0)::numeric AS amount,
      COUNT(*)::int AS count
    FROM segregation
    WHERE user_id = $1
      AND type IN ('additional_expense', 'fixed_expense', 'bill')
      AND date >= $2 AND date <= $3
    GROUP BY COALESCE(NULLIF(TRIM(category), ''), 'Uncategorized')
    ORDER BY amount DESC;
  `;
  const res = await pool.query(query, [userId, startDate, endDate]);

  const totalExpenseRes = await pool.query(
    `SELECT COALESCE(SUM(amount), 0)::numeric AS total
     FROM segregation
     WHERE user_id = $1 AND type IN ('additional_expense', 'fixed_expense', 'bill') AND date >= $2 AND date <= $3;`,
    [userId, startDate, endDate]
  );
  const totalExpense = parseFloat(totalExpenseRes.rows[0]?.total) || 0;

  // Previous period category query (if comparison range provided)
  let prevCatMap = new Map();
  if (prevStartDate && prevEndDate) {
    const prevQuery = `
      SELECT
        COALESCE(NULLIF(TRIM(category), ''), 'Uncategorized') AS category,
        COALESCE(SUM(amount), 0)::numeric AS amount
      FROM segregation
      WHERE user_id = $1
        AND type IN ('additional_expense', 'fixed_expense', 'bill')
        AND date >= $2 AND date <= $3
      GROUP BY COALESCE(NULLIF(TRIM(category), ''), 'Uncategorized');
    `;
    const prevRes = await pool.query(prevQuery, [userId, prevStartDate, prevEndDate]);
    (prevRes.rows || []).forEach((r) => {
      prevCatMap.set(r.category, parseFloat(r.amount) || 0);
    });
  }

  const increasingCategories = [];
  const decreasingCategories = [];

  const categories = (res.rows || []).map((r) => {
    const catAmount = parseFloat(r.amount) || 0;
    const percentage = totalExpense > 0
      ? Math.round(((catAmount / totalExpense) * 100) * 100) / 100
      : 0;

    const prevAmount = prevCatMap.get(r.category) || 0;
    let changePercentage = 0;
    let trend = 'stable';

    if (prevAmount > 0) {
      changePercentage = Math.round((((catAmount - prevAmount) / prevAmount) * 100) * 100) / 100;
      if (changePercentage > 0) trend = 'increasing';
      else if (changePercentage < 0) trend = 'decreasing';
    } else if (catAmount > 0 && prevStartDate) {
      trend = 'new';
      changePercentage = 100;
    }

    if (trend === 'increasing') {
      increasingCategories.push({ category: r.category, changePercentage, current: catAmount, previous: prevAmount });
    } else if (trend === 'decreasing') {
      decreasingCategories.push({ category: r.category, changePercentage, current: catAmount, previous: prevAmount });
    }

    return {
      category: r.category,
      amount: catAmount,
      percentage,
      count: parseInt(r.count, 10) || 0,
      previousAmount: prevAmount,
      changePercentage,
      trend,
    };
  });

  const highestSpendingCategory = categories.length > 0 ? categories[0] : null;
  const topFive = categories.slice(0, 5);

  return {
    categories,
    highestSpendingCategory,
    topFive,
    increasingCategories,
    decreasingCategories,
  };
}

async function getTopSpendingCategories(userId, startDate, endDate, limit = 5) {
  const result = await getSpendingByCategory(userId, startDate, endDate);
  return result.categories.slice(0, limit);
}

// =============================================================================
// 5. Monthly Comparison & Monthly History
// =============================================================================
async function getMonthlyComparison(userId, targetDateStr = null) {
  const now = targetDateStr ? new Date(targetDateStr) : new Date();
  const year = now.getFullYear();
  const month = now.getMonth(); // 0-indexed

  // Current Month: 1st of month to today (or end of month)
  const currentMonthStart = `${year}-${String(month + 1).padStart(2, '0')}-01`;
  const currentMonthEnd = formatDateString(now);

  // Previous Month
  const prevDate = new Date(year, month - 1, 1);
  const prevYear = prevDate.getFullYear();
  const prevMonth = prevDate.getMonth();
  const prevMonthStart = `${prevYear}-${String(prevMonth + 1).padStart(2, '0')}-01`;

  // Last day of previous month
  const lastDayOfPrevMonth = new Date(year, month, 0).getDate();
  const prevMonthEnd = `${prevYear}-${String(prevMonth + 1).padStart(2, '0')}-${String(lastDayOfPrevMonth).padStart(2, '0')}`;

  const [currentSummary, prevSummary] = await Promise.all([
    getSavingsSummary(userId, currentMonthStart, currentMonthEnd),
    getSavingsSummary(userId, prevMonthStart, prevMonthEnd),
  ]);

  const expenseChangePct = prevSummary.totalExpenses > 0
    ? Math.round((((currentSummary.totalExpenses - prevSummary.totalExpenses) / prevSummary.totalExpenses) * 100) * 100) / 100
    : 0;

  const incomeChangePct = prevSummary.totalIncome > 0
    ? Math.round((((currentSummary.totalIncome - prevSummary.totalIncome) / prevSummary.totalIncome) * 100) * 100) / 100
    : 0;

  const savingsChangePct = prevSummary.totalSavings !== 0
    ? Math.round((((currentSummary.totalSavings - prevSummary.totalSavings) / Math.abs(prevSummary.totalSavings)) * 100) * 100) / 100
    : 0;

  return {
    currentPeriod: {
      startDate: currentMonthStart,
      endDate: currentMonthEnd,
      ...currentSummary,
    },
    previousPeriod: {
      startDate: prevMonthStart,
      endDate: prevMonthEnd,
      ...prevSummary,
    },
    comparison: {
      expenseChangePct,
      incomeChangePct,
      savingsChangePct,
      expenseDifference: Math.round((currentSummary.totalExpenses - prevSummary.totalExpenses) * 100) / 100,
      incomeDifference: Math.round((currentSummary.totalIncome - prevSummary.totalIncome) * 100) / 100,
      savingsDifference: Math.round((currentSummary.totalSavings - prevSummary.totalSavings) * 100) / 100,
    },
  };
}

async function getMonthlyHistory(userId, monthsBack = 12) {
  const query = `
    SELECT
      TO_CHAR(date, 'YYYY-MM') AS month_key,
      COALESCE(SUM(CASE WHEN type IN ('additional_income', 'fixed_income') THEN amount ELSE 0 END), 0)::numeric AS income,
      COALESCE(SUM(CASE WHEN type IN ('additional_expense', 'fixed_expense', 'bill') THEN amount ELSE 0 END), 0)::numeric AS expense,
      COUNT(*)::int AS count
    FROM segregation
    WHERE user_id = $1
      AND date >= (CURRENT_DATE - INTERVAL '${monthsBack} months')
    GROUP BY TO_CHAR(date, 'YYYY-MM')
    ORDER BY month_key ASC;
  `;
  const res = await pool.query(query, [userId]);

  return (res.rows || []).map((r) => {
    const income = parseFloat(r.income) || 0;
    const expense = parseFloat(r.expense) || 0;
    const savings = Math.round((income - expense) * 100) / 100;
    const savingsRate = income > 0 ? Math.round(((savings / income) * 100) * 100) / 100 : 0;

    return {
      month: r.month_key,
      income,
      expense,
      savings,
      savingsRate,
      transactionCount: parseInt(r.count, 10) || 0,
    };
  });
}

// =============================================================================
// 6. Yearly Comparison & Yearly History
// =============================================================================
async function getYearlyComparison(userId, targetYear = null) {
  const currentYear = targetYear ? parseInt(targetYear, 10) : new Date().getFullYear();
  const prevYear = currentYear - 1;

  const currentYearStart = `${currentYear}-01-01`;
  const currentYearEnd = `${currentYear}-12-31`;

  const prevYearStart = `${prevYear}-01-01`;
  const prevYearEnd = `${prevYear}-12-31`;

  const [currentSummary, prevSummary] = await Promise.all([
    getSavingsSummary(userId, currentYearStart, currentYearEnd),
    getSavingsSummary(userId, prevYearStart, prevYearEnd),
  ]);

  // Monthly breakdown for target year
  const monthlyBreakdownQuery = `
    SELECT
      TO_CHAR(date, 'YYYY-MM') AS month_key,
      COALESCE(SUM(CASE WHEN type IN ('additional_income', 'fixed_income') THEN amount ELSE 0 END), 0)::numeric AS income,
      COALESCE(SUM(CASE WHEN type IN ('additional_expense', 'fixed_expense', 'bill') THEN amount ELSE 0 END), 0)::numeric AS expense
    FROM segregation
    WHERE user_id = $1
      AND date >= $2 AND date <= $3
    GROUP BY TO_CHAR(date, 'YYYY-MM')
    ORDER BY month_key ASC;
  `;
  const monthRes = await pool.query(monthlyBreakdownQuery, [userId, currentYearStart, currentYearEnd]);

  const months = (monthRes.rows || []).map((r) => {
    const income = parseFloat(r.income) || 0;
    const expense = parseFloat(r.expense) || 0;
    return {
      month: r.month_key,
      income,
      expense,
      savings: Math.round((income - expense) * 100) / 100,
    };
  });

  const expenseChangePct = prevSummary.totalExpenses > 0
    ? Math.round((((currentSummary.totalExpenses - prevSummary.totalExpenses) / prevSummary.totalExpenses) * 100) * 100) / 100
    : 0;

  const incomeChangePct = prevSummary.totalIncome > 0
    ? Math.round((((currentSummary.totalIncome - prevSummary.totalIncome) / prevSummary.totalIncome) * 100) * 100) / 100
    : 0;

  return {
    year: currentYear,
    summary: currentSummary,
    previousYear: {
      year: prevYear,
      summary: prevSummary,
    },
    comparison: {
      expenseChangePct,
      incomeChangePct,
      expenseDifference: Math.round((currentSummary.totalExpenses - prevSummary.totalExpenses) * 100) / 100,
      incomeDifference: Math.round((currentSummary.totalIncome - prevSummary.totalIncome) * 100) / 100,
    },
    monthlyBreakdown: months,
  };
}

// =============================================================================
// 7. Deterministic Statistical Insights Generator
// =============================================================================
function generateStatisticalInsights({ summary, categoryAnalysis, comparison, highestDay }) {
  const insights = [];

  const totalIncome = summary.totalIncome || 0;
  const totalExpenses = summary.totalExpenses || 0;
  const totalSavings = summary.totalSavings || 0;
  const savingsRate = summary.savingsRate || 0;

  // 1. Balance Health & Deficit/Surplus Insight
  if (totalExpenses > totalIncome && totalIncome > 0) {
    const deficit = Math.round((totalExpenses - totalIncome) * 100) / 100;
    insights.push({
      id: 'deficit_alert',
      type: 'warning',
      category: 'budget',
      title: 'Expense Exceeded Income',
      message: `Total expenses exceeded income by ₹${deficit.toLocaleString('en-IN')}. Consider reviewing discretionary spending.`,
      severity: 'high',
    });
  } else if (totalIncome > 0 && savingsRate >= 20) {
    insights.push({
      id: 'healthy_savings',
      type: 'positive',
      category: 'savings',
      title: 'Strong Savings Rate',
      message: `You maintained a healthy savings rate of ${savingsRate}% during this period, retaining ₹${totalSavings.toLocaleString('en-IN')}.`,
      severity: 'low',
    });
  } else if (totalIncome > 0 && savingsRate < 10 && savingsRate >= 0) {
    insights.push({
      id: 'low_savings',
      type: 'caution',
      category: 'savings',
      title: 'Low Savings Rate',
      message: `Your savings rate is currently ${savingsRate}%. A recommended target benchmark is at least 20% of net income.`,
      severity: 'medium',
    });
  } else if (totalIncome === 0 && totalExpenses > 0) {
    insights.push({
      id: 'no_income_recorded',
      type: 'neutral',
      category: 'cashflow',
      title: 'Expenses Recorded Without Income',
      message: `₹${totalExpenses.toLocaleString('en-IN')} in expenses recorded with zero incoming cash flow in this period.`,
      severity: 'medium',
    });
  }

  // 2. Highest Spending Category Concentration
  if (categoryAnalysis?.highestSpendingCategory && totalExpenses > 0) {
    const top = categoryAnalysis.highestSpendingCategory;
    if (top.percentage >= 40) {
      insights.push({
        id: 'category_concentration',
        type: 'caution',
        category: 'concentration',
        title: `Heavy Outlay in ${top.category}`,
        message: `${top.category} accounts for ${top.percentage}% (₹${top.amount.toLocaleString('en-IN')}) of total expenditure.`,
        severity: 'medium',
      });
    } else {
      insights.push({
        id: 'top_category',
        type: 'neutral',
        category: 'breakdown',
        title: `Top Spending: ${top.category}`,
        message: `${top.category} is your highest expense area at ₹${top.amount.toLocaleString('en-IN')} (${top.percentage}%).`,
        severity: 'low',
      });
    }
  }

  // 3. Peak Daily Expenditure Day
  if (highestDay && highestDay.amount > 0) {
    insights.push({
      id: 'peak_spending_day',
      type: 'neutral',
      category: 'daily',
      title: 'Peak Spending Day',
      message: `Highest single-day expenditure was ₹${highestDay.amount.toLocaleString('en-IN')} on ${highestDay.date}.`,
      severity: 'low',
    });
  }

  // 4. Period-over-Period Trend Insights
  if (comparison && comparison.expenseChangePct !== undefined) {
    const change = comparison.expenseChangePct;
    if (change > 15) {
      insights.push({
        id: 'spending_surge',
        type: 'warning',
        category: 'trend',
        title: 'Spending Increased',
        message: `Total spending rose by ${change}% compared to the previous period.`,
        severity: 'medium',
      });
    } else if (change < -15) {
      insights.push({
        id: 'spending_reduction',
        type: 'positive',
        category: 'trend',
        title: 'Spending Decreased',
        message: `Great discipline! Spending decreased by ${Math.abs(change)}% compared to the previous period.`,
        severity: 'low',
      });
    }
  }

  // 5. Category Trend Surge / Drop
  if (categoryAnalysis?.increasingCategories?.length > 0) {
    const surge = categoryAnalysis.increasingCategories[0];
    if (surge.changePercentage >= 25) {
      insights.push({
        id: `surge_${surge.category.toLowerCase().replace(/[^a-z0-9]/g, '_')}`,
        type: 'caution',
        category: 'category_trend',
        title: `${surge.category} Outlay Surged`,
        message: `${surge.category} expenses surged by ${surge.changePercentage}% compared to previous period.`,
        severity: 'medium',
      });
    }
  }

  // If no transactions exist
  if (summary.totalTransactions === 0) {
    insights.push({
      id: 'empty_ledger',
      type: 'neutral',
      category: 'onboarding',
      title: 'No Financial Records Found',
      message: 'No income or expense entries were recorded for this period. Add records in Segregation to view analytics.',
      severity: 'low',
    });
  }

  return insights;
}

// =============================================================================
// 8. Main Orchestrator: getFinancialOverview
// =============================================================================
async function getFinancialOverview(userId, options = {}) {
  const period = options.period || '30d';
  const todayStr = formatDateString(new Date());

  let startDate = options.startDate;
  let endDate = options.endDate;
  let prevStartDate = null;
  let prevEndDate = null;

  if (period === '10d') {
    endDate = todayStr;
    startDate = addDays(todayStr, -9); // 10 days inclusive
    prevEndDate = addDays(startDate, -1);
    prevStartDate = addDays(prevEndDate, -9);
  } else if (period === '30d') {
    endDate = todayStr;
    startDate = addDays(todayStr, -29); // 30 days inclusive
    prevEndDate = addDays(startDate, -1);
    prevStartDate = addDays(prevEndDate, -29);
  } else if (period === 'currentMonth') {
    const now = new Date();
    startDate = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;
    endDate = todayStr;

    // Previous month comparison
    const prevMonthDate = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    prevStartDate = `${prevMonthDate.getFullYear()}-${String(prevMonthDate.getMonth() + 1).padStart(2, '0')}-01`;
    const lastDayPrev = new Date(now.getFullYear(), now.getMonth(), 0).getDate();
    prevEndDate = `${prevMonthDate.getFullYear()}-${String(prevMonthDate.getMonth() + 1).padStart(2, '0')}-${String(lastDayPrev).padStart(2, '0')}`;
  } else if (period === 'yearly') {
    const currentYear = new Date().getFullYear();
    startDate = `${currentYear}-01-01`;
    endDate = `${currentYear}-12-31`;
    prevStartDate = `${currentYear - 1}-01-01`;
    prevEndDate = `${currentYear - 1}-12-31`;
  } else if (period === 'custom') {
    const parsedStart = parseDateInput(options.startDate);
    const parsedEnd = parseDateInput(options.endDate);

    if (!parsedStart || !parsedEnd) {
      throw new Error('Invalid custom date range. Expected YYYY-MM-DD format for start_date and end_date.');
    }
    if (parsedStart > parsedEnd) {
      throw new Error('start_date cannot be later than end_date.');
    }

    // Restrict date range to maximum 5 years (1826 days)
    const daysDiff = getDaysDifference(parsedStart, parsedEnd);
    if (daysDiff > 1826) {
      throw new Error('Custom date range exceeds maximum allowed window of 5 years.');
    }

    startDate = parsedStart;
    endDate = parsedEnd;

    // Symmetric previous period
    prevEndDate = addDays(startDate, -1);
    prevStartDate = addDays(prevEndDate, -(daysDiff - 1));
  } else {
    // Default fallback to 30d
    endDate = todayStr;
    startDate = addDays(todayStr, -29);
    prevEndDate = addDays(startDate, -1);
    prevStartDate = addDays(prevEndDate, -29);
  }

  // Execute queries in parallel
  const [summary, prevSummary, dailyResult, categoryAnalysis] = await Promise.all([
    getSavingsSummary(userId, startDate, endDate),
    prevStartDate ? getSavingsSummary(userId, prevStartDate, prevEndDate) : null,
    getDailySpending(userId, startDate, endDate),
    getSpendingByCategory(userId, startDate, endDate, prevStartDate, prevEndDate),
  ]);

  // Compute comparison delta
  let comparisons = null;
  if (prevSummary) {
    const expenseChangePct = prevSummary.totalExpenses > 0
      ? Math.round((((summary.totalExpenses - prevSummary.totalExpenses) / prevSummary.totalExpenses) * 100) * 100) / 100
      : 0;

    const incomeChangePct = prevSummary.totalIncome > 0
      ? Math.round((((summary.totalIncome - prevSummary.totalIncome) / prevSummary.totalIncome) * 100) * 100) / 100
      : 0;

    const savingsChangePct = prevSummary.totalSavings !== 0
      ? Math.round((((summary.totalSavings - prevSummary.totalSavings) / Math.abs(prevSummary.totalSavings)) * 100) * 100) / 100
      : 0;

    comparisons = {
      previousPeriod: {
        startDate: prevStartDate,
        endDate: prevEndDate,
        ...prevSummary,
      },
      expenseChangePct,
      incomeChangePct,
      savingsChangePct,
      expenseDifference: Math.round((summary.totalExpenses - prevSummary.totalExpenses) * 100) / 100,
      incomeDifference: Math.round((summary.totalIncome - prevSummary.totalIncome) * 100) / 100,
      savingsDifference: Math.round((summary.totalSavings - prevSummary.totalSavings) * 100) / 100,
    };
  }

  // Generate statistical observations
  const insights = generateStatisticalInsights({
    summary,
    categoryAnalysis,
    comparison: comparisons,
    highestDay: dailyResult.highestSpendingDay,
  });

  return {
    success: true,
    period,
    currency: 'INR',
    dateRange: {
      startDate,
      endDate,
      totalDays: summary.totalDays,
    },
    summary: {
      totalIncome: summary.totalIncome,
      totalExpenses: summary.totalExpenses,
      totalSavings: summary.totalSavings,
      savingsRate: summary.savingsRate,
      averageDailyExpense: summary.averageDailyExpense,
      totalTransactions: summary.totalTransactions,
      incomeCount: summary.incomeCount,
      expenseCount: summary.expenseCount,
    },
    categories: categoryAnalysis.categories,
    highestSpendingCategory: categoryAnalysis.highestSpendingCategory,
    topCategories: categoryAnalysis.topFive,
    dailyBreakdown: dailyResult.dailyBreakdown,
    highestSpendingDay: dailyResult.highestSpendingDay,
    comparisons,
    insights,
  };
}

module.exports = {
  getIncomeSummary,
  getExpenseSummary,
  getSavingsSummary,
  getDailySpending,
  getSpendingByCategory,
  getTopSpendingCategories,
  getMonthlyComparison,
  getMonthlyHistory,
  getYearlyComparison,
  getSpendingInsights: generateStatisticalInsights,
  getFinancialOverview,
};
