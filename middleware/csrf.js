const crypto = require('crypto');

function createCsrfToken() {
  return crypto.randomBytes(32).toString('hex');
}

function csrfProtection(req, res, next) {
  const safeMethods = ['GET', 'HEAD', 'OPTIONS'];

  if (safeMethods.includes(req.method)) {
    return next();
  }

  const sessionToken = req.session?.csrfToken;

  // If no session-based CSRF token was initiated, allow API/stateless requests to proceed
  if (!sessionToken) {
    return next();
  }

  const requestToken = req.get('X-CSRF-Token');

  if (!requestToken) {
    return res.status(403).json({
      success: false,
      message: 'CSRF token missing.',
    });
  }

  const expected = Buffer.from(sessionToken);
  const received = Buffer.from(requestToken);

  if (
    expected.length !== received.length ||
    !crypto.timingSafeEqual(expected, received)
  ) {
    return res.status(403).json({
      success: false,
      message: 'Invalid CSRF token.',
    });
  }

  next();
}

module.exports = { csrfProtection, createCsrfToken };
