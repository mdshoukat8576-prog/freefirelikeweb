/**
 * auth.js — JWT session management + Telegram Login Widget verification
 * Bot: @riyazstorebot
 */
const crypto = require('crypto');
const jwt    = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET || crypto.randomBytes(32).toString('hex');
const COOKIE_NAME = 'ff_session';
const COOKIE_OPTS = {
  httpOnly: true,
  sameSite: 'lax',
  secure: Boolean(process.env.VERCEL), // HTTPS only on Vercel
  maxAge: 7 * 24 * 60 * 60 * 1000     // 7 days
};

function signToken(userId) {
  return jwt.sign({ uid: userId }, JWT_SECRET, { expiresIn: '7d' });
}

function verifyToken(token) {
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch (_) {
    return null;
  }
}

/**
 * Verify Telegram Login Widget data.
 * https://core.telegram.org/widgets/login#checking-authorization
 * Returns the verified data object or throws.
 */
function verifyTelegramLogin(data) {
  const BOT_TOKEN = process.env.BOT_TOKEN;
  if (!BOT_TOKEN) throw new Error('Bot token not configured');

  const { hash, ...rest } = data;
  if (!hash) throw new Error('Missing hash');

  // Check freshness — must be within 1 hour
  const authDate = Number(rest.auth_date);
  if (!authDate || Date.now() / 1000 - authDate > 3600) {
    throw new Error('Telegram auth data expired');
  }

  // Build data-check-string
  const checkStr = Object.keys(rest)
    .sort()
    .map(k => `${k}=${rest[k]}`)
    .join('\n');

  // Key = SHA256(bot_token)
  const secretKey = crypto.createHash('sha256').update(BOT_TOKEN).digest();
  const expectedHash = crypto.createHmac('sha256', secretKey).update(checkStr).digest('hex');

  if (expectedHash !== hash) throw new Error('Invalid Telegram auth signature');
  return data;
}

// Express middleware — reads JWT from cookie, sets req.user or returns 401
function authMiddleware(req, res, next) {
  const token = req.cookies && req.cookies[COOKIE_NAME];
  if (!token) return res.status(401).json({ error: 'Not authenticated' });
  const payload = verifyToken(token);
  if (!payload) return res.status(401).json({ error: 'Session expired' });
  req.userId = payload.uid;
  next();
}

// Optional auth — sets req.userId if valid cookie, always proceeds
function optionalAuth(req, res, next) {
  const token = req.cookies && req.cookies[COOKIE_NAME];
  if (token) {
    const payload = verifyToken(token);
    if (payload) req.userId = payload.uid;
  }
  next();
}

function setSessionCookie(res, userId) {
  res.cookie(COOKIE_NAME, signToken(userId), COOKIE_OPTS);
}

function clearSessionCookie(res) {
  res.clearCookie(COOKIE_NAME);
}

module.exports = {
  verifyTelegramLogin,
  authMiddleware,
  optionalAuth,
  setSessionCookie,
  clearSessionCookie
};
