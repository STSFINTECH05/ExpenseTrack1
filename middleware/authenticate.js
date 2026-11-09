const jwt = require('jsonwebtoken');
const pool = require('../db');

const JWT_SECRET = process.env.JWT_SECRET || process.env.SESSION_SECRET || 'sts-fintech-jwt-super-secret-key-2025';

/**
 * authenticateToken Middleware
 * Validates JWT tokens sent via 'Authorization: Bearer <token>' header,
 * with fallbacks for session or custom headers.
 * Populates req.user, req.userId, and req.userEmail.
 */
async function authenticateToken(req, res, next) {
  try {
    const authHeader = req.headers['authorization'] || req.headers['Authorization'];
    let token = null;

    if (authHeader && typeof authHeader === 'string') {
      const parts = authHeader.trim().split(' ');
      if (parts.length === 2 && /^Bearer$/i.test(parts[0])) {
        token = parts[1];
      } else if (parts.length === 1 && !authHeader.toLowerCase().startsWith('basic')) {
        token = parts[0];
      }
    }

    // 1. If JWT token is present, verify it
    if (token) {
      try {
        const decoded = jwt.verify(token, JWT_SECRET);
        req.user = {
          id: decoded.id || decoded.userId || decoded.sub || decoded.email,
          userId: decoded.id || decoded.userId || decoded.sub || decoded.email,
          email: decoded.email,
          name: decoded.name || (decoded.email ? decoded.email.split('@')[0] : 'User'),
          role: decoded.role || 'finance_member',
        };
        req.userId = req.user.id;
        req.userEmail = req.user.email;
        return next();
      } catch (jwtErr) {
        // If JWT token is expired or invalid signature
        return res.status(401).json({
          success: false,
          message: 'Invalid or expired authentication token. Please log in again.',
          error: jwtErr.message,
        });
      }
    }

    // 2. Fallback to session or custom user-id headers
    const fallbackId =
      req.session?.userId ||
      req.headers['x-user-id'] ||
      req.headers['x-auth-user-id'] ||
      req.headers['x-user-email'];

    if (!fallbackId) {
      return res.status(401).json({
        success: false,
        message: 'Authentication required. Missing Authorization: Bearer <token> header.',
      });
    }

    try {
      const result = await pool.query(
        `SELECT id, name, email, role
         FROM users
         WHERE (id::text = $1 OR email = $1) AND is_active = TRUE`,
        [String(fallbackId)]
      );

      if (result.rows.length === 0) {
        // If no user found in DB, construct fallback user if offline / memory mode
        const isOffline = !process.env.DATABASE_URL;
        if (isOffline) {
          req.user = {
            id: String(fallbackId),
            userId: String(fallbackId),
            email: String(fallbackId).includes('@') ? String(fallbackId) : `${fallbackId}@stsfintech.com`,
            name: String(fallbackId).split('@')[0],
            role: 'finance_member',
          };
          req.userId = req.user.id;
          req.userEmail = req.user.email;
          return next();
        }

        return res.status(401).json({
          success: false,
          message: 'Session or user credential is no longer valid.',
        });
      }

      req.user = result.rows[0];
      req.userId = req.user.id;
      req.userEmail = req.user.email;
      return next();
    } catch (dbErr) {
      // Offline / fallback mode
      req.user = {
        id: String(fallbackId),
        userId: String(fallbackId),
        email: String(fallbackId).includes('@') ? String(fallbackId) : `${fallbackId}@stsfintech.com`,
        name: 'Finance User',
        role: 'finance_member',
      };
      req.userId = req.user.id;
      req.userEmail = req.user.email;
      return next();
    }
  } catch (error) {
    next(error);
  }
}

module.exports = authenticateToken;
module.exports.authenticate = authenticateToken;
module.exports.authenticateToken = authenticateToken;
