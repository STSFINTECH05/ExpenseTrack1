const pool = require('../db');

async function authenticate(req, res, next) {
  try {
    const userId = req.session?.userId || req.headers['x-user-id'] || req.headers['x-auth-user-id'];

    if (!userId) {
      return res.status(401).json({
        success: false,
        message: 'Authentication required.',
      });
    }

    try {
      const result = await pool.query(
        `SELECT id, name, email, role
         FROM users
         WHERE id = $1 AND is_active = TRUE`,
        [userId]
      );

      if (result.rows.length === 0) {
        if (req.session && typeof req.session.destroy === 'function') {
          return req.session.destroy(() => {
            res.status(401).json({
              success: false,
              message: 'Session is no longer valid.',
            });
          });
        }
        return res.status(401).json({
          success: false,
          message: 'Session is no longer valid.',
        });
      }

      req.user = result.rows[0];
      return next();
    } catch (dbErr) {
      // In offline / memory mode when PostgreSQL database or users table is unavailable
      const isOffline = !process.env.DATABASE_URL ||
        dbErr.code === 'ECONNREFUSED' ||
        dbErr.code === '42P01' ||
        dbErr.message?.includes('ECONNREFUSED');
      if (isOffline) {
        req.user = {
          id: String(userId),
          name: 'Finance User',
          email: 'user@stsfintech.com',
          role: 'finance_member',
        };
        return next();
      }
      throw dbErr;
    }
  } catch (error) {
    next(error);
  }
}

module.exports = authenticate;
