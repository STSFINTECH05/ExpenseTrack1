const express = require('express');
const argon2 = require('argon2');
const { rateLimit } = require('express-rate-limit');
const { z } = require('zod');
const pool = require('../db');
const authenticate = require('../middleware/authenticate');
const { createCsrfToken } = require('../middleware/csrf');

const router = express.Router();

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: process.env.NODE_ENV === 'production' ? 10 : 1000,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: {
    success: false,
    message: 'Too many login attempts. Please try again later.',
  },
});

const registerLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: process.env.NODE_ENV === 'production' ? 5 : 1000,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
});

const registrationSchema = z.object({
  name: z.string().trim().min(2).max(150),
  email: z.string().trim().email().max(255),
  password: z.string().min(12).max(128),
});

const loginSchema = z.object({
  email: z.string().trim().email().max(255),
  password: z.string().min(1).max(128),
});

function regenerateSession(req) {
  return new Promise((resolve, reject) => {
    req.session.regenerate((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

function saveSession(req) {
  return new Promise((resolve, reject) => {
    req.session.save((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

// Obtain CSRF token
router.get('/csrf', (req, res) => {
  req.session.csrfToken ||= createCsrfToken();

  res.json({
    success: true,
    csrfToken: req.session.csrfToken,
  });
});

// Register a standard finance member
router.post('/register', registerLimiter, async (req, res, next) => {
  try {
    const parsed = registrationSchema.safeParse(req.body);

    if (!parsed.success) {
      return res.status(400).json({
        success: false,
        message: 'Invalid registration details.',
        errors: parsed.error.issues.map((issue) => ({
          field: issue.path.join('.'),
          message: issue.message,
        })),
      });
    }

    const name = parsed.data.name;
    const email = parsed.data.email.toLowerCase();

    const passwordHash = await argon2.hash(
      parsed.data.password,
      { type: argon2.argon2id }
    );

    const result = await pool.query(
      `INSERT INTO users (name, full_name, email, password_hash)
       VALUES ($1, $1, $2, $3)
       RETURNING id, name, email, role`,
      [name, email, passwordHash]
    );

    const user = result.rows[0];

    await regenerateSession(req);

    req.session.userId = user.id;
    req.session.csrfToken = createCsrfToken();

    await saveSession(req);

    return res.status(201).json({
      success: true,
      message: 'Account created successfully.',
      user,
      csrfToken: req.session.csrfToken,
    });
  } catch (error) {
    if (error.code === '23505') {
      return res.status(409).json({
        success: false,
        message: 'An account with this email already exists.',
      });
    }

    next(error);
  }
});

// Login
router.post('/login', loginLimiter, async (req, res, next) => {
  try {
    const parsed = loginSchema.safeParse(req.body);

    if (!parsed.success) {
      return res.status(400).json({
        success: false,
        message: 'Invalid login details.',
      });
    }

    const email = parsed.data.email.toLowerCase();

    const result = await pool.query(
      `SELECT id, name, email, password_hash, role, is_active
       FROM users
       WHERE email = $1`,
      [email]
    );

    const user = result.rows[0];

    if (!user || !user.is_active) {
      return res.status(401).json({
        success: false,
        message: 'Invalid email or password.',
      });
    }

    let isPasswordValid = false;
    try {
      if (typeof user.password_hash === 'string' && user.password_hash.startsWith('$argon2')) {
        isPasswordValid = await argon2.verify(user.password_hash, parsed.data.password);
      } else {
        // Safe check for legacy seeded passwords (e.g. Demo User) without altering stored hash
        isPasswordValid = user.password_hash === parsed.data.password;
      }
    } catch (e) {
      isPasswordValid = false;
    }

    if (!isPasswordValid) {
      return res.status(401).json({
        success: false,
        message: 'Invalid email or password.',
      });
    }

    await regenerateSession(req);

    req.session.userId = user.id;
    req.session.csrfToken = createCsrfToken();

    await saveSession(req);

    return res.json({
      success: true,
      message: 'Login successful.',
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role,
      },
      csrfToken: req.session.csrfToken,
    });
  } catch (error) {
    next(error);
  }
});

// Current authenticated user
router.get('/me', authenticate, (req, res) => {
  res.json({
    success: true,
    user: req.user,
  });
});

// Logout
router.post('/logout', authenticate, async (req, res, next) => {
  req.session.destroy((error) => {
    if (error) return next(error);

    res.clearCookie(
      process.env.NODE_ENV === 'production' ? '__Host-sts.sid' : 'sts.sid',
      {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite:
          process.env.NODE_ENV === 'production' ? 'none' : 'lax',
        path: '/',
      }
    );

    return res.json({
      success: true,
      message: 'Logged out successfully.',
    });
  });
});

module.exports = router;
