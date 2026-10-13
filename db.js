const { Pool } = require('pg');
require('dotenv').config();

/**
 * PostgreSQL Connection Pool for STS FINTECH PRIVATE LIMITED
 * Configured with SSL support for Render, Supabase, Neon, and AWS environments.
 */

const databaseUrl = process.env.DATABASE_URL;

let pool = null;
let isDatabaseConfigured = false;

if (databaseUrl && databaseUrl.trim() !== '') {
  const isCloudEnvironment =
    process.env.NODE_ENV === 'production' ||
    databaseUrl.includes('render.com') ||
    databaseUrl.includes('oregon-postgres') ||
    databaseUrl.includes('frankfurt-postgres') ||
    databaseUrl.includes('supabase') ||
    databaseUrl.includes('neon.tech') ||
    databaseUrl.includes('amazonaws.com') ||
    databaseUrl.includes('sslmode=require');

  pool = new Pool({
    connectionString: databaseUrl,
    ssl: isCloudEnvironment ? { rejectUnauthorized: false } : false,
    max: 20,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
  });

  pool.on('error', (err) => {
    console.error('[STS FINTECH DB] Unexpected error on idle client:', err.message);
  });

  isDatabaseConfigured = true;
} else {
  console.warn('[STS FINTECH DB] Warning: DATABASE_URL is not set. Operating in fallback mode.');
}

// In-memory fallback stores when local PostgreSQL is not configured yet
let inMemoryPayments = [
  {
    id: 1,
    title: 'Cloud Infrastructure (Render & AWS)',
    amount: 14500.00,
    status: 'completed',
    created_at: new Date(Date.now() - 3600000 * 24 * 2).toISOString(),
  },
  {
    id: 2,
    title: 'Fintech API Gateway Subscription',
    amount: 8200.50,
    status: 'completed',
    created_at: new Date(Date.now() - 3600000 * 24).toISOString(),
  },
  {
    id: 3,
    title: 'PCI-DSS Compliance Audit Tools',
    amount: 25000.00,
    status: 'pending',
    created_at: new Date(Date.now() - 3600000 * 5).toISOString(),
  }
];

let inMemoryFinanceRecords = [
  // Additional Income
  {
    id: 1,
    type: 'additional_income',
    name: 'Freelance Tech Advisory',
    description: 'Advisory on High-Frequency Routing for Client X',
    date: '2026-10-05',
    time: '14:30',
    schedule: 'One-time',
    category: 'Consulting',
    associated_wallet: 'HDFC Corporate',
    amount: 35000.00,
    created_at: new Date(Date.now() - 3600000 * 48).toISOString(),
  },
  {
    id: 2,
    type: 'additional_income',
    name: 'Mutual Fund Dividend Yield',
    description: 'Quarterly payout from liquid debt fund',
    date: '2026-10-02',
    time: '11:15',
    schedule: 'Quarterly',
    category: 'Investment',
    associated_wallet: 'Zerodha Escrow',
    amount: 12500.00,
    created_at: new Date(Date.now() - 3600000 * 120).toISOString(),
  },
  // Additional Expense
  {
    id: 3,
    type: 'additional_expense',
    name: 'AWS Elastic GPU Cluster',
    description: 'Model inference workload compute overages',
    date: '2026-10-06',
    time: '18:00',
    schedule: 'One-time',
    category: 'Infrastructure',
    associated_wallet: 'ICICI Corporate',
    amount: 9400.00,
    created_at: new Date(Date.now() - 3600000 * 24).toISOString(),
  },
  {
    id: 4,
    type: 'additional_expense',
    name: 'Engineering Sprint Lunch',
    description: 'Milestone celebration dinner for 12 engineers',
    date: '2026-10-04',
    time: '20:30',
    schedule: 'One-time',
    category: 'Operations',
    associated_wallet: 'Petty Cash',
    amount: 4200.00,
    created_at: new Date(Date.now() - 3600000 * 72).toISOString(),
  },
  // Fixed Income
  {
    id: 5,
    type: 'fixed_income',
    name: 'STS Core Retainer Contract',
    description: 'Enterprise API integration retainer SLA',
    date: '2026-10-01',
    time: '09:00',
    schedule: 'Monthly (1st)',
    category: 'Retainer',
    associated_wallet: 'HDFC Corporate',
    amount: 185000.00,
    created_at: new Date(Date.now() - 3600000 * 150).toISOString(),
  },
  {
    id: 6,
    type: 'fixed_income',
    name: 'SaaS Platform License Tier',
    description: 'Institutional trading platform licensing fee',
    date: '2026-10-01',
    time: '09:30',
    schedule: 'Monthly (1st)',
    category: 'Software Subscription',
    associated_wallet: 'Razorpay Business',
    amount: 95000.00,
    created_at: new Date(Date.now() - 3600000 * 149).toISOString(),
  },
  // Fixed Expense
  {
    id: 7,
    type: 'fixed_expense',
    name: 'Tech Park Corporate Office Lease',
    description: 'Corporate headquarters 4th floor facilities',
    date: '2026-10-01',
    time: '10:00',
    schedule: 'Monthly (1st)',
    category: 'Office Rent',
    associated_wallet: 'HDFC Corporate',
    amount: 65000.00,
    created_at: new Date(Date.now() - 3600000 * 148).toISOString(),
  },
  {
    id: 8,
    type: 'fixed_expense',
    name: 'Core Engineering Payroll Batch',
    description: 'Fixed salaries base for software developers',
    date: '2026-10-01',
    time: '11:00',
    schedule: 'Monthly (1st)',
    category: 'Payroll',
    associated_wallet: 'HDFC Corporate',
    amount: 140000.00,
    created_at: new Date(Date.now() - 3600000 * 147).toISOString(),
  },
];

let inMemoryGoalWallets = [];
let nextPaymentId = 4;
let nextFinanceRecordId = 9;
let nextGoalWalletId = 1;

const query = async (text, params = []) => {
  if (pool) {
    try {
      return await pool.query(text, params);
    } catch (error) {
      console.error('[STS FINTECH DB Query Error]:', error.message);
      throw error;
    }
  }

  // Fallback simulator for development without an active PostgreSQL instance
  const normalized = text.trim().toUpperCase();

  // 1. Finance Records table queries
  if (normalized.includes('FINANCE_RECORDS')) {
    if (normalized.startsWith('SELECT')) {
      const uniqueRecords = Array.from(
        new Map(inMemoryFinanceRecords.map((item) => [item.id || item.name, item])).values()
      );
      let filtered = uniqueRecords;
      if (normalized.includes('WHERE TYPE =') && params.length > 0) {
        const filterType = params[0];
        filtered = filtered.filter((r) => r.type === filterType);
      }
      filtered.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
      return { rows: filtered, rowCount: filtered.length };
    } else if (normalized.startsWith('INSERT')) {
      const [type, name, description, date, time, schedule, category, associated_wallet, amount] = params;
      const existing = inMemoryFinanceRecords.find(
        (r) => r.type === type && (r.name || '').toLowerCase().trim() === (name || '').toLowerCase().trim()
      );
      if (existing) {
        return { rows: [existing], rowCount: 1 };
      }
      const newRec = {
        id: nextFinanceRecordId++,
        type,
        name,
        description: description || '',
        date: date || new Date().toISOString().split('T')[0],
        time: time || new Date().toTimeString().slice(0, 5),
        schedule: schedule || 'One-time',
        category: category || 'General',
        associated_wallet: associated_wallet || 'Primary Account',
        amount: parseFloat(amount) || 0.0,
        created_at: new Date().toISOString(),
      };
      inMemoryFinanceRecords.unshift(newRec);
      return { rows: [newRec], rowCount: 1 };
    } else if (normalized.startsWith('UPDATE')) {
      const [name, description, date, time, schedule, category, associated_wallet, amount, id] = params;
      const targetId = parseInt(id, 10);
      const index = inMemoryFinanceRecords.findIndex((r) => r.id === targetId);
      if (index === -1) {
        return { rows: [], rowCount: 0 };
      }
      const existing = inMemoryFinanceRecords[index];
      const updated = {
        ...existing,
        name: name !== undefined ? name : existing.name,
        description: description !== undefined ? description : existing.description,
        date: date !== undefined ? date : existing.date,
        time: time !== undefined ? time : existing.time,
        schedule: schedule !== undefined ? schedule : existing.schedule,
        category: category !== undefined ? category : existing.category,
        associated_wallet: associated_wallet !== undefined ? associated_wallet : existing.associated_wallet,
        amount: amount !== undefined ? parseFloat(amount) : existing.amount,
      };
      inMemoryFinanceRecords[index] = updated;
      return { rows: [updated], rowCount: 1 };
    } else if (normalized.startsWith('DELETE')) {
      const [id] = params;
      const targetId = parseInt(id, 10);
      const index = inMemoryFinanceRecords.findIndex((r) => r.id === targetId);
      if (index === -1) {
        return { rows: [], rowCount: 0 };
      }
      const removed = inMemoryFinanceRecords.splice(index, 1);
      return { rows: removed, rowCount: 1 };
    }
  }

  // 2. Payments table queries
  if (normalized.includes('PAYMENTS')) {
    if (normalized.startsWith('SELECT')) {
      const sorted = [...inMemoryPayments].sort(
        (a, b) => new Date(b.created_at) - new Date(a.created_at)
      );
      return { rows: sorted, rowCount: sorted.length };
    } else if (normalized.startsWith('INSERT')) {
      const [title, amount, status] = params;
      const newRecord = {
        id: nextPaymentId++,
        title,
        amount: parseFloat(amount),
        status: status || 'completed',
        created_at: new Date().toISOString(),
      };
      inMemoryPayments.unshift(newRecord);
      return { rows: [newRecord], rowCount: 1 };
    }
  }

  // 3. Goal Wallets table queries
  if (normalized.includes('GOAL_WALLETS')) {
    if (normalized.startsWith('SELECT')) {
      let filtered = [...inMemoryGoalWallets];
      if (normalized.includes('WHERE ID =') && params.length > 0) {
        filtered = filtered.filter((w) => w.id === parseInt(params[0], 10));
      }
      filtered.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
      return { rows: filtered, rowCount: filtered.length };
    } else if (normalized.startsWith('INSERT')) {
      const [name, target_amount, saved_amount, description, status] = params;
      const newWallet = {
        id: nextGoalWalletId++,
        name: name || 'Goal Wallet',
        target_amount: parseFloat(target_amount) || 0.0,
        saved_amount: parseFloat(saved_amount) || 0.0,
        description: description || '',
        status: status || 'in_progress',
        created_at: new Date().toISOString(),
      };
      inMemoryGoalWallets.unshift(newWallet);
      return { rows: [newWallet], rowCount: 1 };
    } else if (normalized.startsWith('UPDATE')) {
      const [addAmount, walletId] = params;
      const wallet = inMemoryGoalWallets.find((w) => w.id === parseInt(walletId, 10));
      if (wallet) {
        wallet.saved_amount += parseFloat(addAmount) || 0.0;
        if (wallet.saved_amount >= wallet.target_amount) {
          wallet.status = 'target_met';
        }
        return { rows: [wallet], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    } else if (normalized.startsWith('DELETE')) {
      const [walletId] = params;
      inMemoryGoalWallets = inMemoryGoalWallets.filter((w) => w.id !== parseInt(walletId, 10));
      return { rows: [], rowCount: 1 };
    }
  }

  return { rows: [], rowCount: 0 };
};

module.exports = {
  pool,
  query,
  isDatabaseConfigured,
};
