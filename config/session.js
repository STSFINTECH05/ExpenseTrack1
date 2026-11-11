const session = require('express-session');
const connectPgSimple = require('connect-pg-simple');
const pool = require('../db');

const isProduction = process.env.NODE_ENV === 'production';
const sessionSecret = process.env.SESSION_SECRET;

if (!sessionSecret || sessionSecret.length < 32) {
  throw new Error('SESSION_SECRET must contain at least 32 characters.');
}

const PgSession = connectPgSimple(session);

const cookieName = isProduction ? '__Host-sts.sid' : 'sts.sid';

const sessionMiddleware = session({
  name: cookieName,
  store: new PgSession({
    pool,
    tableName: 'user_sessions',
    createTableIfMissing: false,
  }),
  secret: sessionSecret,
  resave: false,
  saveUninitialized: false,
  rolling: true,
  proxy: true,
  cookie: {
    httpOnly: true,
    secure: isProduction,
    sameSite: isProduction ? 'none' : 'lax',
    path: '/',
    maxAge: 8 * 60 * 60 * 1000,
  },
});

module.exports = { sessionMiddleware, cookieName };
