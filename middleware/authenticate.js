const pool = require('../db');

/**
 * Secure Session-Based Authentication Middleware
 * Authenticates users exclusively through PostgreSQL-backed server-side session (req.session.userId).
 * Populates req.user, req.userId, and req.userEmail.
 */
async function authenticate(req, res, next) {
  try {
    // 1. Validate that an authenticated session exists
    if (!req.session || !req.session.userId) {
      return res.status(401).json({
        success: false,
        message: 'Authentication required. Please log in.',
      });
    }

    // 2. Query the user from PostgreSQL using the session userId
    const result = await pool.query(
      `SELECT id, name, email, role
       FROM users
       WHERE id = $1
         AND is_active = TRUE
       LIMIT 1;`,
      [req.session.userId]
    );

    // 3. Reject if user does not exist or is inactive
    if (result.rows.length === 0) {
      return res.status(401).json({
        success: false,
        message: 'Authentication required. Session is invalid or user is inactive.',
      });
    }

    // 4. Attach verified user identity to request object
    const user = result.rows[0];
    req.user = user;
    req.userId = user.id;
    req.userEmail = user.email;

    return next();
  } catch (error) {
    // 5. Pass database/system errors to Express error handler (fail securely, zero fallbacks)
    return next(error);
  }
}

module.exports = authenticate;
module.exports.authenticate = authenticate;
module.exports.authenticateToken = authenticate;
