const path = require('path');
const fs   = require('fs');
const crypto = require('crypto');
const express = require('express');
const multer  = require('multer');
const cookieParser = require('cookie-parser');

// Load .env
const envPath = path.join(__dirname, '.env');
const envExPath = path.join(__dirname, '.env.example');
if (fs.existsSync(envPath)) require('dotenv').config({ path: envPath });
else if (fs.existsSync(envExPath)) require('dotenv').config({ path: envExPath });

// Modules (load after env)
const { notifyAdmin, notifyGuildGloryOrder, checkChannelMembership, processTelegramUpdate, createPendingAuthToken, getPendingAuthToken, consumePendingAuthToken } = require('./bot');
const db = require('./db');
const { authMiddleware, optionalAuth, verifyTelegramLogin, setSessionCookie, clearSessionCookie, verifyLoginToken } = require('./auth');

const app         = express();
const REQUESTED_PORT = Number(process.env.PORT || 3000);
const publicDir   = path.join(__dirname);
const isVercel    = Boolean(process.env.VERCEL);
const dataDir     = isVercel ? '/tmp/data' : path.join(__dirname, 'data');
const proofDir    = path.join(dataDir, 'proofs');
try { fs.mkdirSync(proofDir, { recursive: true }); } catch (_) {}

const ordersFile = path.join(dataDir, 'orders.json');
if (!fs.existsSync(ordersFile)) {
  const seed = path.join(__dirname, 'data', 'orders.json');
  try { fs.copyFileSync(seed, ordersFile); } catch (_) {}
  if (!fs.existsSync(ordersFile)) try { fs.writeFileSync(ordersFile, '[]'); } catch (_) {}
}

const PLANS = {
  '1 Day':  { inr: 20,  days: 1,  likes: 200   },
  '7 Days': { inr: 90,  days: 7,  likes: 1400  },
  '15 Days':{ inr: 190, days: 15, likes: 3000  },
  '30 Days':{ inr: 350, days: 30, likes: 6000  },
  '60 Days':{ inr: 600, days: 60, likes: 12000 },
  '90 Days':{ inr: 800, days: 90, likes: 18000 }
};
const SERVERS = ['IND','BR','US','SG','RU','ID','TW','VN','TH','PK','BD','EUROPE','ME','SAC','NA'];
const REGION_MAP = {
  IND:'ind',BD:'bd',BR:'br',US:'us',SG:'sg',RU:'ru',
  ID:'id',TW:'tw',VN:'vn',TH:'th',PK:'pk',
  EUROPE:'europe',ME:'me',SAC:'sac',NA:'na'
};
const GG_PACKAGES = {
  '1squad':  { name:'4 Bots · 1 Squad',  inr:150,  usd:6,  description:'Guild Glory 100K–200K' },
  '2squads': { name:'4 Bots · 2 Squads', inr:289,  usd:7,  description:'Guild Glory 200K–300K' },
  '3squads': { name:'6 Bots · 3 Squads', inr:700,  usd:11, description:'Level 1→7 Direct — 500K Glory', badge:'BEST VALUE' },
  '4squads': { name:'8 Bots · 4 Squads', inr:1400, usd:16, description:'Full 1 Million Guild Glory Boost' }
};
const REQUIRED_CHANNELS = ['riyazapi','riyazlike','autolikegrp','orewaaizennn'];

// ── Middleware ────────────────────────────────────────────────────────────────
// Security: block sensitive files
app.use((req, res, next) => {
  const p = req.path.toLowerCase();
  if (p.startsWith('/.env') || p === '/package.json' || p === '/package-lock.json' ||
      (!isVercel && p === '/server.js') || p === '/bot.js' || p === '/db.js' ||
      p === '/auth.js' || p === '/data/orders.json' || p.startsWith('/.git')) {
    return res.status(403).type('text/plain').send('Access Forbidden');
  }
  next();
});

// onrender.com → fflike.sbs redirect
app.use((req, res, next) => {
  if ((req.get('host') || '').includes('onrender.com'))
    return res.redirect(301, `https://fflike.sbs${req.originalUrl}`);
  next();
});

// Raw body for Razorpay webhook
app.use('/api/webhooks/razorpay', express.raw({ type: 'application/json' }));
app.use(express.json({ limit: '200kb' }));
app.use(express.urlencoded({ extended: true, limit: '200kb' }));
app.use(cookieParser());

// ── DB init (async, runs in background — routes wait if needed) ───────────────
db.initDb().catch(e => console.error('[DB] init error:', e.message));

// ── Static assets ─────────────────────────────────────────────────────────────
app.get('/index.html', (_, res) => res.redirect(301, '/'));
app.get('/robots.txt', (_, res) => {
  res.set({'Content-Type':'text/plain;charset=utf-8','Cache-Control':'public,max-age=3600,s-maxage=86400'});
  res.sendFile(path.join(publicDir,'robots.txt'));
});
app.get(['/sitemap.xml','/sitemap'], (_, res) => {
  res.set({'Content-Type':'application/xml;charset=utf-8','Cache-Control':'public,max-age=3600,s-maxage=86400'});
  res.sendFile(path.join(publicDir,'sitemap.xml'));
});
app.get('/favicon.ico', (_, res) => {
  const f = path.join(publicDir,'favicon.ico');
  fs.existsSync(f) ? res.type('image/x-icon').sendFile(f) : res.status(204).end();
});
app.get('/styles.css', (_, res) => {
  const f = path.join(__dirname,'styles.css');
  res.setHeader('Content-Type','text/css;charset=UTF-8');
  res.setHeader('Cache-Control','public,max-age=86400,stale-while-revalidate=604800');
  res.sendFile(f);
});
app.get('/app.js', (_, res) => {
  res.setHeader('Content-Type','application/javascript;charset=UTF-8');
  res.setHeader('Cache-Control','public,max-age=86400,stale-while-revalidate=604800');
  res.sendFile(path.join(__dirname,'app.js'));
});
app.get('/config.js', (_, res) => {
  res.setHeader('Content-Type','application/javascript;charset=UTF-8');
  res.sendFile(path.join(__dirname,'config.js'));
});
app.use('/assets', express.static(path.join(__dirname,'assets'), {
  maxAge:'1d',
  setHeaders: r => r.setHeader('Cache-Control','public,max-age=86400,stale-while-revalidate=604800')
}));

// ── Clean URL routes ──────────────────────────────────────────────────────────
const cleanRoutes = ['pricing','how-it-works','faq','order-status','contact','about',
  'free-likes','privacy-policy','terms-of-service','refund-policy','blog','guild-glory','profile'];
app.get(['/privacy','/privacy.html'], (_, res) => res.redirect(301,'/privacy-policy'));
app.get(['/terms','/terms.html'], (_, res) => res.redirect(301,'/terms-of-service'));
cleanRoutes.forEach(r => {
  app.get(`/${r}.html`, (_, res) => res.redirect(301,`/${r}`));
  app.get(`/${r}`, (req, res) => {
    const f = path.join(publicDir,`${r}.html`);
    fs.existsSync(f) ? res.sendFile(f) : res.redirect(301,'/');
  });
});
app.get('/blog/:slug', (req, res) => {
  const slug = req.params.slug.replace(/[^a-z0-9-]/gi,'');
  const f = path.join(publicDir,'blog',`${slug}.html`);
  fs.existsSync(f) ? res.sendFile(f) : res.redirect(301,'/blog');
});

app.use(express.static(publicDir));

// ── Upload config ─────────────────────────────────────────────────────────────
const upload = multer({
  dest: proofDir,
  limits: { fileSize: 8*1024*1024 },
  fileFilter: (_, file, cb) => {
    const ok = ['image/jpeg','image/png','image/webp'].includes(file.mimetype);
    cb(ok ? null : new Error('Only JPG, PNG or WEBP allowed'), ok);
  }
});

// ── Helpers ───────────────────────────────────────────────────────────────────
function readOrders() { try { return JSON.parse(fs.readFileSync(ordersFile,'utf8')); } catch { return []; } }
function writeOrders(l) { fs.writeFileSync(ordersFile,JSON.stringify(l,null,2)); }
function safeId() { return `FF-${Date.now().toString(36).toUpperCase()}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`; }
function publicConfig() {
  return {
    brand: { name: process.env.STORE_NAME || 'FREE FIRE AUTO LIKE' },
    contact: {
      adminTelegram: process.env.ADMIN_TELEGRAM || 'riyaznx',
      adminTelegramUrl: `https://t.me/${String(process.env.ADMIN_TELEGRAM||'riyaznx').replace(/^@/,'')}`,
      community: process.env.COMMUNITY_TELEGRAM || 'AutoLikeGrp',
      communityUrl: `https://t.me/${String(process.env.COMMUNITY_TELEGRAM||'AutoLikeGrp').replace(/^@/,'')}`
    },
    payment: {
      qrPath: process.env.PAYMENT_QR_PATH || '/assets/payment-qr.png',
      upiId: process.env.UPI_ID || 'riyaznxx@nyes',
      accountName: process.env.PAYMENT_ACCOUNT_NAME || 'Mohhamad Riyaz',
      note: 'Pay the exact amount shown, then submit the UTR/reference and payment screenshot.'
    }
  };
}

// ── Auth Middleware wrapper (waits for DB init) ───────────────────────────────
function withDb(fn) {
  return async (req, res, next) => {
    try { await db.initDb(); fn(req, res, next); } catch (e) { res.status(503).json({ error: 'DB not ready' }); }
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
//  NEW ROUTES
// ═══════════════════════════════════════════════════════════════════════════════

// ── Auth ──────────────────────────────────────────────────────────────────────
app.post('/api/auth/telegram', async (req, res) => {
  try {
    await db.initDb();
    const data = req.body;
    verifyTelegramLogin(data); // throws on invalid/expired
    const telegramId = String(data.id);
    const name = [data.first_name, data.last_name].filter(Boolean).join(' ') || 'User';
    const user = db.upsertUser({ telegram_id: telegramId, name, username: data.username || null, photo_url: data.photo_url || null });
    if (req.body.ref_code) {
      try {
        const referrer = db.getUser(req.body.ref_code); // try by referral_code
        if (!referrer) {
          // try finding user whose referral_code matches
        }
      } catch (_) {}
    }
    setSessionCookie(res, user.id);
    const { referral_code, credits, channels_verified, name: uName, username, photo_url, telegram_id, created_at } = user;
    res.json({ ok: true, user: { id: user.id, telegram_id, name: uName, username, photo_url, credits: Number(credits), channels_verified: Number(channels_verified), referral_code, created_at } });
  } catch (e) {
    console.error('[Auth]', e.message);
    res.status(401).json({ error: 'Authentication failed: ' + e.message });
  }
});

app.post('/api/auth/quick-connect', async (req, res) => {
  try {
    await db.initDb();
    const raw = String(req.body.telegram_id || req.body.username || req.body.telegram || '').trim().replace(/^@/, '');
    if (!raw) return res.status(400).json({ error: 'Please enter your numeric Telegram ID' });
    if (!/^\d{5,15}$/.test(raw)) {
      return res.status(400).json({ error: 'Telegram ID must be numeric (5-15 digits, e.g. 7932057377). Send /start to @fflike_sbsbot to see your ID.' });
    }
    const telegramId = raw;
    const name = req.body.name || `User ${telegramId.slice(-4)}`;
    const user = db.upsertUser({
      telegram_id: String(telegramId),
      name: name,
      username: req.body.username || null,
      photo_url: null
    });
    if (req.body.ref_code) {
      try {
        const referrer = db.getUser(req.body.ref_code) || db.getUserById(req.body.ref_code);
        if (referrer && String(referrer.telegram_id) !== String(user.telegram_id)) {
          db.createReferral(referrer.id, user.id);
        }
      } catch (_) {}
    }
    setSessionCookie(res, user.id);
    const { referral_code, credits, channels_verified, name: uName, photo_url, telegram_id: tId, created_at } = user;
    res.json({ ok: true, user: { id: user.id, telegram_id: tId, name: uName, username: user.username, photo_url, credits: Number(credits), channels_verified: Number(channels_verified), referral_code, created_at } });
  } catch (e) {
    console.error('[Auth Quick]', e.message);
    res.status(500).json({ error: 'Connection failed: ' + e.message });
  }
});

app.post('/api/auth/token-login', async (req, res) => {
  try {
    await db.initDb();
    const token = String(req.body?.token || '').trim();
    if (!token) return res.status(400).json({ error: 'Token missing' });
    const payload = verifyLoginToken(token);
    if (!payload || !payload.id) return res.status(401).json({ error: 'Login link expired. Send /start to @fflike_sbsbot again.' });
    const telegramId = String(payload.id);
    const name = payload.name || 'Telegram User';
    const username = payload.username || null;
    const user = db.upsertUser({ telegram_id: telegramId, name, username, photo_url: null });
    if (req.body.ref_code) {
      try {
        const referrer = db.getUser(req.body.ref_code) || db.getUserById(req.body.ref_code);
        if (referrer && String(referrer.telegram_id) !== telegramId) {
          db.createReferral(referrer.id, user.id);
        }
      } catch (_) {}
    }
    setSessionCookie(res, user.id);
    const { id, telegram_id, name: uName, username: uUser, photo_url, credits, channels_verified, referral_code, created_at } = user;
    res.json({ ok: true, user: { id, telegram_id, name: uName, username: uUser, photo_url, credits: Number(credits), channels_verified: Number(channels_verified), referral_code, created_at } });
  } catch (e) {
    res.status(500).json({ error: 'Login failed: ' + e.message });
  }
});

app.get('/api/auth/me', optionalAuth, async (req, res) => {
  if (!req.userId) return res.json({ user: null });
  try {
    await db.initDb();
    const user = db.getUserById(req.userId);
    if (!user) return res.json({ user: null });
    // Invalidate non-numeric legacy test accounts
    if (!/^\d{5,15}$/.test(String(user.telegram_id || ''))) {
      clearSessionCookie(res);
      return res.json({ user: null });
    }
    const { id, telegram_id, name, username, photo_url, credits, channels_verified, referral_code, created_at } = user;
    res.json({ user: { id, telegram_id, name, username, photo_url, credits: Number(credits), channels_verified: Number(channels_verified), referral_code, created_at } });
  } catch (e) { res.status(500).json({ error: 'Failed' }); }
});

app.post('/api/auth/logout', (req, res) => {
  clearSessionCookie(res);
  res.json({ ok: true });
});

// ── Telegram Deep-Link Auth ───────────────────────────────────────────────────
app.post('/api/auth/start-connect', async (req, res) => {
  try {
    await db.initDb();
    const refCode = req.body?.ref_code || null;
    const token = createPendingAuthToken(refCode);
    const botUser = 'fflike_sbsbot';
    res.json({ ok: true, token, botUsername: botUser, connectUrl: `https://t.me/${botUser}?start=auth_${token}` });
  } catch (e) {
    res.status(500).json({ error: 'Failed to start connection' });
  }
});

app.get('/api/auth/poll-connect', async (req, res) => {
  try {
    const token = String(req.query.token || '').trim();
    if (!token) return res.status(400).json({ error: 'Missing token' });
    const user = consumePendingAuthToken(token);
    if (user) {
      setSessionCookie(res, user.id);
      const { id, telegram_id, name, username, photo_url, credits, channels_verified, referral_code, created_at } = user;
      return res.json({ completed: true, ok: true, user: { id, telegram_id, name, username, photo_url, credits: Number(credits), channels_verified: Number(channels_verified), referral_code, created_at } });
    }
    const entry = getPendingAuthToken(token);
    if (!entry) return res.status(404).json({ error: 'Session expired or invalid' });
    return res.json({ completed: false });
  } catch (e) {
    res.status(500).json({ error: 'Poll failed' });
  }
});

// ── Telegram Webhook (for Vercel serverless) ──────────────────────────────────
app.post(['/api/telegram-webhook', '/api/bot/webhook'], async (req, res) => {
  res.sendStatus(200);
  try {
    if (req.body) await processTelegramUpdate(req.body);
  } catch (e) {
    console.error('[Webhook] Error processing update:', e.message);
  }
});

// ── Membership Verify ─────────────────────────────────────────────────────────
app.post('/api/membership/verify', authMiddleware, async (req, res) => {
  try {
    await db.initDb();
    const user = db.getUserById(req.userId);
    if (!user) return res.status(404).json({ error: 'User not found' });

    if (!/^\d{5,15}$/.test(String(user.telegram_id || ''))) {
      clearSessionCookie(res);
      return res.status(400).json({ error: 'Your account was connected with an invalid Telegram ID. Please reconnect with your real Telegram account.', reconnect: true });
    }

    const results = await Promise.all(
      REQUIRED_CHANNELS.map(async ch => {
        try {
          const joined = await checkChannelMembership(user.telegram_id, ch);
          return { name: `@${ch}`, joined };
        } catch (_) {
          return { name: `@${ch}`, joined: false, error: true };
        }
      })
    );

    const allVerified = results.every(r => r.joined);
    let creditGranted = false;

    if (allVerified) {
      const fresh = db.getUserById(user.id);
      if (!fresh.channels_verified) db.updateUser(user.telegram_id, { channels_verified: 1, channels_verified_at: new Date().toISOString() });
      if (!fresh.initial_reward_claimed) {
        try {
          db.updateUserCredits(user.id, 1, 'reward', 'Initial channel verification reward', null);
          db.updateUser(user.telegram_id, { initial_reward_claimed: 1 });
          creditGranted = true;
          // Complete referral if exists
          try {
            const refRow = db.completeReferral(user.id);
            if (refRow) db.updateUserCredits(refRow.referrer_id, 1, 'referral', 'Referral reward', String(user.id));
          } catch (_) {}
        } catch (_) {}
      }
    }

    res.json({ verified: allVerified, channels: results, creditGranted });
  } catch (e) {
    console.error('[Membership]', e.message);
    res.status(500).json({ error: 'Verification failed: ' + e.message });
  }
});

// ── Free Likes ────────────────────────────────────────────────────────────────
app.post('/api/likes/request', authMiddleware, async (req, res) => {
  try {
    await db.initDb();
    const { uid, region } = req.body || {};
    if (!/^\d{5,15}$/.test(String(uid||''))) return res.status(400).json({ error: 'Invalid UID (5-15 digits)' });
    if (!SERVERS.includes(String(region||''))) return res.status(400).json({ error: 'Invalid region' });

    const user = db.getUserById(req.userId);
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (!user.channels_verified) return res.status(403).json({ error: 'Please verify channel membership first' });
    if (user.credits < 1) return res.status(402).json({ error: 'No credits. Purchase credits to continue.' });

    // Deduct credit
    try { db.updateUserCredits(user.id, -1, 'spend', 'Likes request', String(uid)); }
    catch (_) { return res.status(402).json({ error: 'Insufficient credits' }); }

    const apiRegion = REGION_MAP[region] || region.toLowerCase();
    let apiResult = null, likesGiven = 0;

    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 15000);
      const r = await fetch(`https://all-server-eight.vercel.app/like?uid=${encodeURIComponent(uid)}&region=${encodeURIComponent(apiRegion)}`, { signal: ctrl.signal });
      clearTimeout(t);
      apiResult = await r.json();
      likesGiven = Number(apiResult.LikesGivenByAPI || apiResult.likes_given || 0);
    } catch (e) {
      try { db.updateUserCredits(user.id, 1, 'refund', 'API error refund', String(uid)); } catch (_) {}
      return res.status(502).json({ error: 'Likes API unavailable. Credit refunded.' });
    }

    if (likesGiven <= 0) {
      try { db.updateUserCredits(user.id, 1, 'refund', 'No likes given — refund', String(uid)); } catch (_) {}
    }

    db.createLikesRequest({
      user_id: user.id, uid: String(uid), region,
      likes_before: Number(apiResult.LikesBefore||0), likes_after: Number(apiResult.LikesAfter||0),
      likes_given: likesGiven,
      nickname: String(apiResult.PlayerNickname||'Unknown'),
      level: Number(apiResult.Level||0),
      status: likesGiven > 0 ? 'success' : 'no_likes',
      credit_charged: likesGiven > 0 ? 1 : 0
    });

    const fresh = db.getUserById(user.id);
    res.json({
      ok: true, likesGiven, uid: String(uid), region,
      nickname: apiResult.PlayerNickname||'Unknown', level: apiResult.Level||0,
      likesBefore: apiResult.LikesBefore||0, likesAfter: apiResult.LikesAfter||0,
      credits: Number(fresh.credits),
      message: likesGiven > 0 ? `✅ ${likesGiven} likes sent!` : '⚠️ No likes sent. Credit refunded.'
    });
  } catch (e) {
    console.error('[Likes]', e.message);
    res.status(500).json({ error: 'Request failed. Please try again.' });
  }
});

app.get('/api/likes/history', authMiddleware, async (req, res) => {
  try {
    await db.initDb();
    res.json({ history: db.getLikesHistory(req.userId) });
  } catch (_) { res.status(500).json({ error: 'Failed' }); }
});

// ── Credits / Razorpay ────────────────────────────────────────────────────────
app.post('/api/credits/order', authMiddleware, async (req, res) => {
  try {
    await db.initDb();
    const credits = parseInt(req.body.credits, 10);
    if (!credits || credits < 1 || credits > 1000) return res.status(400).json({ error: 'Credits must be 1–1000' });
    const amountPaise = credits * 500;

    if (!process.env.RAZORPAY_KEY_ID || !process.env.RAZORPAY_KEY_SECRET)
      return res.json({ error: 'Payment not configured', setup: true });

    const Razorpay = require('razorpay');
    const rzp = new Razorpay({ key_id: process.env.RAZORPAY_KEY_ID, key_secret: process.env.RAZORPAY_KEY_SECRET });
    const rzpOrder = await rzp.orders.create({ amount: amountPaise, currency: 'INR', receipt: `cr_${req.userId}_${Date.now()}` });
    db.createCreditOrder({ user_id: req.userId, razorpay_order_id: rzpOrder.id, credits, amount_paise: amountPaise });
    res.json({ ok: true, orderId: rzpOrder.id, amount: amountPaise, currency: 'INR', credits, keyId: process.env.RAZORPAY_KEY_ID });
  } catch (e) {
    console.error('[Credits]', e.message);
    res.status(500).json({ error: 'Failed to create payment order' });
  }
});

app.post('/api/credits/verify', authMiddleware, async (req, res) => {
  try {
    await db.initDb();
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;
    if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature)
      return res.status(400).json({ error: 'Missing fields' });
    const secret = process.env.RAZORPAY_KEY_SECRET;
    if (!secret) return res.status(503).json({ error: 'Payment not configured' });
    const expected = crypto.createHmac('sha256', secret).update(`${razorpay_order_id}|${razorpay_payment_id}`).digest('hex');
    if (expected !== razorpay_signature) return res.status(400).json({ error: 'Invalid signature' });

    const order = db.getCreditOrder(razorpay_order_id);
    if (!order) return res.status(404).json({ error: 'Order not found' });
    if (order.user_id !== req.userId) return res.status(403).json({ error: 'Forbidden' });
    if (order.fulfilled) return res.json({ ok: true, credits: db.getUserById(req.userId).credits, already: true });

    db.fulfillCreditOrder(razorpay_order_id, razorpay_payment_id);
    const newBal = db.updateUserCredits(req.userId, order.credits, 'purchase', 'Razorpay credit purchase', razorpay_payment_id);
    res.json({ ok: true, credits: newBal });
  } catch (e) {
    console.error('[Credits verify]', e.message);
    res.status(500).json({ error: 'Verification failed' });
  }
});

app.post('/api/webhooks/razorpay', async (req, res) => {
  try {
    await db.initDb();
    const webhookSec = process.env.RAZORPAY_WEBHOOK_SECRET;
    if (webhookSec) {
      const sig = req.headers['x-razorpay-signature'];
      const exp = crypto.createHmac('sha256', webhookSec).update(req.body).digest('hex');
      if (sig !== exp) return res.status(400).json({ error: 'Invalid signature' });
    }
    const payload = JSON.parse(req.body.toString());
    const eventId = payload.id || `evt_${Date.now()}`;
    if (db.isWebhookProcessed(eventId)) return res.json({ ok: true, skipped: true });
    db.markWebhookProcessed(eventId);
    if (payload.event === 'payment.captured') {
      const payment = payload.payload?.payment?.entity;
      if (payment) {
        const order = db.getCreditOrder(payment.order_id);
        if (order && !order.fulfilled) {
          db.fulfillCreditOrder(payment.order_id, payment.id);
          db.updateUserCredits(order.user_id, order.credits, 'purchase', 'Razorpay webhook', payment.id);
        }
      }
    }
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'Webhook failed' }); }
});

// ── Guild Glory ───────────────────────────────────────────────────────────────
app.get('/api/guild-glory/packages', (_, res) => res.json({ packages: GG_PACKAGES }));

app.post('/api/guild-glory/orders', optionalAuth, async (req, res) => {
  try {
    await db.initDb();
    const { packageKey, currency, telegram, guild_uid, utr } = req.body || {};
    const pkg = GG_PACKAGES[packageKey];
    if (!pkg) return res.status(400).json({ error: 'Invalid package' });
    if (!['INR','USDT'].includes(String(currency||''))) return res.status(400).json({ error: 'Currency must be INR or USDT' });
    if (!guild_uid || !String(guild_uid).trim()) return res.status(400).json({ error: 'Guild UID is required' });
    if (!utr || !String(utr).trim()) return res.status(400).json({ error: currency === 'INR' ? 'UTR number is required' : 'Transaction/Order ID is required' });
    const amount = currency === 'INR' ? `₹${pkg.inr}` : `$${pkg.usd} USDT`;
    const orderRef = safeId();
    const order = db.createGuildGloryOrder({
      user_id: req.userId || null, order_ref: orderRef,
      package_key: packageKey, package_name: pkg.name,
      currency, amount,
      guild_uid: String(guild_uid).trim().slice(0,32),
      utr: String(utr).trim().slice(0,64),
      telegram: String(telegram||'').trim().slice(0,64)
    });
    try { await notifyGuildGloryOrder(order); } catch (_) {}
    res.json({ ok: true, order });
  } catch (e) {
    console.error('[GuildGlory]', e.message);
    res.status(500).json({ error: 'Failed to create order' });
  }
});

app.get('/api/guild-glory/orders', optionalAuth, async (req, res) => {
  try {
    await db.initDb();
    if (req.query.ref) {
      const order = db.getGuildGloryOrderByRef(req.query.ref);
      return res.json({ order: order || null });
    }
    if (!req.userId) return res.json({ orders: [] });
    res.json({ orders: db.getGuildGloryOrders(req.userId) });
  } catch (_) { res.status(500).json({ error: 'Failed' }); }
});

// Guild Glory proof submit
app.post('/api/guild-glory/orders/:ref/proof', upload.single('proof'), async (req, res) => {
  try {
    await db.initDb();
    const order = db.getGuildGloryOrderByRef(req.params.ref);
    if (!order) {
      if (req.file) try { fs.unlinkSync(req.file.path); } catch (_) {}
      return res.status(404).json({ error: 'Order not found' });
    }
    const utr = String(req.body.utr||order.utr||'').trim().slice(0,64);
    if (!req.file) return res.status(400).json({ error: 'Screenshot required' });
    const ext = req.file.mimetype === 'image/png' ? '.png' : '.jpg';
    const finalName = `GG-${req.params.ref}${ext}`;
    const finalPath = path.join(proofDir, finalName);
    try { fs.renameSync(req.file.path, finalPath); } catch (_) { return res.status(500).json({ error: 'Save failed' }); }
    const relativePath = path.join('data', 'proofs', finalName);
    db.updateGuildGloryOrder(req.params.ref, { payment_status: 'proof_submitted', fulfillment_status: 'under_review', utr, proof: relativePath });
    const updated = db.getGuildGloryOrderByRef(req.params.ref);
    if (updated) {
      try { await notifyGuildGloryOrder(updated); } catch (_) {}
    }
    res.json({ ok: true, order: updated });
  } catch (e) { res.status(500).json({ error: 'Failed' }); }
});

// ── Referral ──────────────────────────────────────────────────────────────────
app.get('/api/referral', authMiddleware, async (req, res) => {
  try {
    await db.initDb();
    const user = db.getUserById(req.userId);
    if (!user) return res.status(404).json({ error: 'User not found' });
    const info = db.getReferralInfo(req.userId);
    const siteUrl = process.env.SITE_URL || 'https://fflike.sbs';
    res.json({
      referralCode: user.referral_code,
      referralLink: `${siteUrl}/free-likes?ref=${user.referral_code}`,
      ...info
    });
  } catch (_) { res.status(500).json({ error: 'Failed' }); }
});

// ── History ───────────────────────────────────────────────────────────────────
app.get('/api/history', authMiddleware, async (req, res) => {
  try {
    await db.initDb();
    res.json({
      likes: db.getLikesHistory(req.userId),
      credits: db.getCreditHistory(req.userId),
      guildGlory: db.getGuildGloryOrders(req.userId),
      referrals: db.getReferralInfo(req.userId)?.referrals || []
    });
  } catch (_) { res.status(500).json({ error: 'Failed' }); }
});

// ═══════════════════════════════════════════════════════════════════════════════
//  EXISTING ROUTES (preserved)
// ═══════════════════════════════════════════════════════════════════════════════
app.get(['/api/config','/config'], (_, res) => res.json(publicConfig()));

app.post(['/api/orders','/orders'], (req, res) => {
  const { plan, uid, server, telegram } = req.body || {};
  const p = PLANS[plan];
  if (!p) return res.status(400).json({ error: 'Invalid plan' });
  if (!/^\d{5,15}$/.test(String(uid||''))) return res.status(400).json({ error: 'Invalid UID' });
  if (!SERVERS.includes(String(server||''))) return res.status(400).json({ error: 'Invalid server' });
  const order = {
    id: safeId(), plan, uid: String(uid).trim(), server: String(server).trim(),
    telegram: String(telegram||'').trim().slice(0,64),
    amount: p.inr, likes: p.likes, days: p.days,
    status: 'awaiting_payment', utr: '', proof: '',
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()
  };
  const orders = readOrders();
  orders.unshift(order);
  writeOrders(orders);
  res.json({ ok: true, order, payment: publicConfig().payment, adminTelegram: publicConfig().contact.adminTelegram });
});

app.post(['/api/orders/:id/proof','/orders/:id/proof'], upload.single('proof'), async (req, res) => {
  const orders = readOrders();
  const idx = orders.findIndex(o => o.id === req.params.id);
  if (idx < 0) {
    if (req.file) try { fs.unlinkSync(req.file.path); } catch (_) {}
    return res.status(404).json({ error: 'Order not found' });
  }
  const utr = String(req.body.utr||'').trim().slice(0,64);
  if (!utr) { if (req.file) try { fs.unlinkSync(req.file.path); } catch (_) {} return res.status(400).json({ error: 'UTR required' }); }
  if (!req.file) return res.status(400).json({ error: 'Screenshot required' });
  const ext = req.file.mimetype === 'image/png' ? '.png' : req.file.mimetype === 'image/webp' ? '.webp' : '.jpg';
  const finalPath = path.join(proofDir, `${req.params.id}${ext}`);
  try { fs.renameSync(req.file.path, finalPath); } catch (_) { return res.status(500).json({ error: 'Save failed' }); }
  orders[idx] = { ...orders[idx], utr, proof: `/data/proofs/${req.params.id}${ext}`, status: 'proof_submitted', updatedAt: new Date().toISOString() };
  writeOrders(orders);
  try { await notifyAdmin(orders[idx]); } catch (e) { console.error('[Telegram notify]', e.message); }
  res.json({ ok: true, order: orders[idx] });
});

app.get(['/api/orders/:id','/orders/:id'], (req, res) => {
  const order = readOrders().find(o => o.id === req.params.id);
  if (!order) return res.status(404).json({ error: 'Order not found' });
  res.json({ order: { id:order.id, plan:order.plan, uid:order.uid, server:order.server, amount:order.amount, status:order.status, utr:order.utr, createdAt:order.createdAt } });
});

function admin(req, res, next) {
  const key = req.headers['x-admin-key'] || req.query.key;
  if (!process.env.ADMIN_KEY || key !== process.env.ADMIN_KEY) return res.status(401).json({ error: 'Unauthorized' });
  next();
}
app.get('/api/admin/orders', admin, (_, res) => res.json({ orders: readOrders() }));
app.post('/api/admin/orders/:id/status', admin, (req, res) => {
  const allowed = ['awaiting_payment','proof_submitted','processing','completed','rejected'];
  const status = String(req.body.status||'');
  if (!allowed.includes(status)) return res.status(400).json({ error: 'Invalid status' });
  const orders = readOrders();
  const idx = orders.findIndex(o => o.id === req.params.id);
  if (idx < 0) return res.status(404).json({ error: 'Order not found' });
  orders[idx] = { ...orders[idx], status, updatedAt: new Date().toISOString() };
  writeOrders(orders);
  res.json({ ok: true, order: orders[idx] });
});

app.get('/health', (_, res) => res.json({ ok: true, service: 'FF Auto Like + Guild Glory' }));
app.use((err, req, res, next) => { if (err) return res.status(400).json({ error: err.message || 'Request failed' }); next(err); });

// ── Server Start ──────────────────────────────────────────────────────────────
function startServer(port) {
  const server = app.listen(port, () => console.log(`\n🎮 FF AUTO LIKE running on http://localhost:${server.address().port}\n`));
  server.on('error', err => {
    if (err.code === 'EADDRINUSE') startServer(port + 1);
    else throw err;
  });
  return server;
}

if (!isVercel) {
  db.initDb().then(() => {
    startServer(REQUESTED_PORT);
    const pingUrl = process.env.RENDER_EXTERNAL_URL || 'https://fflike.sbs/robots.txt';
    setInterval(() => fetch(pingUrl).catch(() => {}), 10 * 60 * 1000);
  }).catch(e => { console.error('[DB] Fatal:', e.message); process.exit(1); });
}

module.exports = app;
