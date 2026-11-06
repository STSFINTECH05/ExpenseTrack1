require('dotenv').config();

const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

async function migrate() {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('Refusing to run migrations in production.');
  }

  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL is not configured.');
  }

  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: false,
  });

  const client = await pool.connect();

  try {
    const dbResult = await client.query(
      'SELECT current_database() AS database, inet_server_addr() AS host'
    );

    const database = dbResult.rows[0].database;

    if (database !== 'sts_fintech1') {
      throw new Error(
        `Unexpected database: ${database}. Migration cancelled.`
      );
    }

    console.log('Connected to development database:', database);

    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        id SERIAL PRIMARY KEY,
        filename VARCHAR(255) UNIQUE NOT NULL,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    const filename = '001_auth_tables.sql';

    const existing = await client.query(
      'SELECT filename FROM schema_migrations WHERE filename = $1',
      [filename]
    );

    if (existing.rows.length > 0) {
      console.log('Migration already applied:', filename);
      return;
    }

    const migrationPath = path.join(
      __dirname,
      '..',
      'migrations',
      filename
    );

    const sql = fs.readFileSync(migrationPath, 'utf8');

    await client.query(sql);

    await client.query(
      'INSERT INTO schema_migrations (filename) VALUES ($1)',
      [filename]
    );

    console.log('Migration applied successfully:', filename);
  } finally {
    client.release();
    await pool.end();
  }
}

migrate().catch((error) => {
  console.error('Migration failed:', error.message);
  process.exitCode = 1;
});
