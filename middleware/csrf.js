const crypto = require('crypto');

/**
 * Generates a cryptographically secure 32-byte CSRF token (64 hex characters)
 */
function createCsrfToken() {
  return crypto.randomBytes(32).toString('hex');
}

/**
 * CSRF Protection Middleware
 * - Allows safe HTTP methods (GET, HEAD, OPTIONS) without CSRF validation.
 * - Exempts initial public authentication endpoints so sessions and tokens can be established.
 * - Requires and strictly validates matching CSRF tokens for state-changing methods
 *   (POST, PUT, PATCH, DELETE) against the session-stored token.
 * - Rejects missing session tokens, missing headers, length mismatches, and invalid tokens with 403 Forbidden.
 */
function csrfProtection(req, res, next) {
  const safeMethods = ['GET', 'HEAD', 'OPTIONS'];

  // 1. Allow safe idempotent methods without CSRF validation
  if (safeMethods.includes(req.method)) {
    return next();
  }

  // 2. Exempt public authentication endpoints from blocking CSRF checks so sessions can be established
  const publicAuthPaths = [
    '/api/auth/login',
    '/api/auth/register',
    '/api/auth/csrf',
    '/auth/login',
    '/auth/register',
    '/auth/csrf',
  ];

  if (publicAuthPaths.some((p) => req.path === p || req.originalUrl?.split('?')[0] === p)) {
    return next();
  }

  // 3. State-changing methods require an existing session CSRF token
  const sessionToken = req.session?.csrfToken;

  if (!sessionToken || typeof sessionToken !== 'string') {
    return res.status(403).json({
      success: false,
      error: 'CSRF_SESSION_TOKEN_MISSING',
      message: 'CSRF session token missing. Please refresh your session.',
    });
  }

  // 4. Retrieve CSRF token from request header (case-insensitive via req.get)
  const requestToken = req.get('X-CSRF-Token') || req.headers['x-csrf-token'];

  if (!requestToken || typeof requestToken !== 'string') {
    return res.status(403).json({
      success: false,
      error: 'CSRF_TOKEN_MISSING',
      message: 'CSRF token missing.',
    });
  }

  // 5. Validate buffer lengths and perform constant-time comparison
  const expected = Buffer.from(sessionToken, 'utf8');
  const received = Buffer.from(requestToken, 'utf8');

  if (
    expected.length !== received.length ||
    !crypto.timingSafeEqual(expected, received)
  ) {
    return res.status(403).json({
      success: false,
      error: 'CSRF_TOKEN_INVALID',
      message: 'Invalid CSRF token.',
    });
  }

  return next();
}

module.exports = {
  csrfProtection,
  validateCsrfToken: csrfProtection,
  createCsrfToken,
};