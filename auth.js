/**
 * auth.js — JWT session management + Telegram Login Widget verification
 * Bot: @riyazstorebot
 */
const crypto = require('crypto');
const jwt    = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET || 'fflike-jwt-secret-stable-key-2026-v2-production';
const COOKIE_NAME = 'ff_session';
const COOKIE_OPTS = {
  httpOnly: true,
  sameSite: 'lax',
  secure: Boolean(process.env.VERCEL), // HTTPS only on Vercel
  maxAge: 30 * 24 * 60 * 60 * 1000     // 30 days
};

const CANDIDATE_JWT_SECRETS = [
  process.env.JWT_SECRET,
  'change-this-to-a-long-random-secret-for-jwt',
  'fflike-jwt-secret-stable-key-2026-v2-production',
  'fflike-local-dev-secret-change-in-prod'
].filter(Boolean);

function signToken(user) {
  const payload = (typeof user === 'object' && user !== null)
    ? { uid: user.id, tid: String(user.telegram_id || ''), name: user.name || '', username: user.username || '' }
    : { uid: user };
  return jwt.sign(payload, JWT_SECRET, { expiresIn: '30d' });
}

function verifyToken(token) {
  for (const sec of CANDIDATE_JWT_SECRETS) {
    try {
      return jwt.verify(token, sec);
    } catch (_) {}
  }
  return null;
}

function signLoginToken(payload) {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: '15m' });
}

function verifyLoginToken(token) {
  for (const sec of CANDIDATE_JWT_SECRETS) {
    try {
      return jwt.verify(token, sec);
    } catch (_) {}
  }
  return null;
}

/**
 * Verify Telegram Login Widget data.
 * https://core.telegram.org/widgets/login#checking-authorization
 * Returns the verified data object or throws.
 */
function verifyTelegramLogin(data) {
  const candidateTokens = [
    process.env.LOGIN_BOT_TOKEN,
    '8994422473:AAG8iknKl0eK41Lf9V0gYa7qB9eW3QmPlOE',
    process.env.BOT_TOKEN,
    '8430101695:AAGx_Et9LWDBtKIFiwDBxjxnRrjaiZVitdM'
  ].filter(Boolean);

  const { hash, ...rest } = data;
  if (!hash) throw new Error('Missing hash');

  // Check freshness — must be within 24 hours
  const authDate = Number(rest.auth_date);
  if (!authDate || Date.now() / 1000 - authDate > 86400) {
    throw new Error('Telegram auth data expired');
  }

  // Build data-check-string — ONLY include official Telegram auth fields
  const validKeys = ['auth_date', 'first_name', 'id', 'last_name', 'photo_url', 'username'];
  const checkStr = Object.keys(rest)
    .filter(k => validKeys.includes(k) && rest[k] !== undefined && rest[k] !== null && rest[k] !== '')
    .sort()
    .map(k => `${k}=${rest[k]}`)
    .join('\n');

  let signatureValid = false;
  for (const botToken of candidateTokens) {
    const secretKey = crypto.createHash('sha256').update(botToken).digest();
    const expectedHash = crypto.createHmac('sha256', secretKey).update(checkStr).digest('hex');
    if (expectedHash === hash) {
      signatureValid = true;
      break;
    }
  }

  if (!signatureValid) throw new Error('Invalid Telegram auth signature');
  return data;
}

// Express middleware — reads JWT from cookie, sets req.user or returns 401
function authMiddleware(req, res, next) {
  const token = req.cookies && req.cookies[COOKIE_NAME];
  if (!token) return res.status(401).json({ error: 'Not authenticated' });
  const payload = verifyToken(token);
  if (!payload) return res.status(401).json({ error: 'Session expired' });
  req.userId = payload.uid;
  req.userTid = payload.tid;
  req.userName = payload.name;
  req.userUsername = payload.username;
  next();
}

// Optional auth — sets req.userId if valid cookie, always proceeds
function optionalAuth(req, res, next) {
  const token = req.cookies && req.cookies[COOKIE_NAME];
  if (token) {
    const payload = verifyToken(token);
    if (payload) {
      req.userId = payload.uid;
      req.userTid = payload.tid;
      req.userName = payload.name;
      req.userUsername = payload.username;
    }
  }
  next();
}

function setSessionCookie(res, userId) {
  res.cookie(COOKIE_NAME, signToken(userId), COOKIE_OPTS);
}

function clearSessionCookie(res) {
  res.clearCookie(COOKIE_NAME, COOKIE_OPTS);
  res.clearCookie(COOKIE_NAME);
}

module.exports = {
  verifyTelegramLogin,
  authMiddleware,
  optionalAuth,
  setSessionCookie,
  clearSessionCookie,
  signToken,
  verifyToken,
  signLoginToken,
  verifyLoginToken
};
