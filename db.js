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

// In-memory fallback store when local PostgreSQL is not configured yet
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

let nextId = 4;

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
  if (normalized.startsWith('SELECT')) {
    const sorted = [...inMemoryPayments].sort(
      (a, b) => new Date(b.created_at) - new Date(a.created_at)
    );
    return { rows: sorted, rowCount: sorted.length };
  } else if (normalized.startsWith('INSERT')) {
    const [title, amount, status] = params;
    const newRecord = {
      id: nextId++,
      title,
      amount: parseFloat(amount),
      status: status || 'completed',
      created_at: new Date().toISOString(),
    };
    inMemoryPayments.unshift(newRecord);
    return { rows: [newRecord], rowCount: 1 };
  }

  return { rows: [], rowCount: 0 };
};

module.exports = {
  pool,
  query,
  isDatabaseConfigured,
};
