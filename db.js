const { Pool } = require('pg');
require('dotenv').config();

/**
 * PostgreSQL Connection Pool for STS FINTECH PRIVATE LIMITED
 * Configured with SSL support for Render, production, and cloud environments.
 */
const databaseUrl = process.env.DATABASE_URL || '';
const isProduction = process.env.NODE_ENV === 'production';
const requiresSsl =
  isProduction ||
  databaseUrl.includes('render.com') ||
  databaseUrl.includes('dpg-') ||
  databaseUrl.includes('supabase') ||
  databaseUrl.includes('neon.tech') ||
  databaseUrl.includes('amazonaws.com') ||
  databaseUrl.includes('sslmode=require');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: requiresSsl ? { rejectUnauthorized: false } : false,
});

pool.on('error', (err) => {
  console.error(' PostgreSQL connection error: ', err.message || err);
});

// Immediate test query to verify database connectivity on startup
pool.query('SELECT NOW()')
  .then(() => {
    console.log(' Connected to PostgreSQL database successfully');
  })
  .catch((err) => {
    console.error(' PostgreSQL connection error: ', err.message || err);
  });

pool.pool = pool;

module.exports = pool;
