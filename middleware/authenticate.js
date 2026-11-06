const pool = require('../db');

async function authenticate(req, res, next) {
  try {
    const userId = req.session?.userId;

    if (!userId) {
      return res.status(401).json({
        success: false,
        message: 'Authentication required.',
      });
    }

    const result = await pool.query(
      `SELECT id, name, email, role
       FROM users
       WHERE id = $1 AND is_active = TRUE`,
      [userId]
    );

    if (result.rows.length === 0) {
      return req.session.destroy(() => {
        res.status(401).json({
          success: false,
          message: 'Session is no longer valid.',
        });
      });
    }

    req.user = result.rows[0];
    next();
  } catch (error) {
    next(error);
  }
}

module.exports = authenticate;
