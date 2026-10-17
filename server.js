const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const multer = require('multer');

// Always load env from this project folder, not from the terminal's current directory.
// Prefer .env; for this packaged build, fall back to .env.example so the user's
// existing configuration is detected even if Windows saved it as .env.example.
const envPath = path.join(__dirname, '.env');
const envExamplePath = path.join(__dirname, '.env.example');
const envSource = fs.existsSync(envPath) ? '.env' : (fs.existsSync(envExamplePath) ? '.env.example' : 'none');
if (fs.existsSync(envPath)) {
  require('dotenv').config({ path: envPath });
} else if (fs.existsSync(envExamplePath)) {
  require('dotenv').config({ path: envExamplePath });
}
console.log(`[ENV] Loaded from ${envSource}`);

// Load environment variables BEFORE loading the Telegram bot module.
const { notifyAdmin } = require('./bot');

const app = express();
const REQUESTED_PORT = Number(process.env.PORT || 3000);
const publicDir = path.join(__dirname);
const isVercel = Boolean(process.env.VERCEL);
const dataDir = isVercel ? path.join('/tmp', 'data') : path.join(__dirname, 'data');
const proofDir = path.join(dataDir, 'proofs');
try { fs.mkdirSync(proofDir, { recursive: true }); } catch (e) {}
const ordersFile = path.join(dataDir, 'orders.json');
if (!fs.existsSync(ordersFile)) {
  const seedFile = path.join(__dirname, 'data', 'orders.json');
  try {
    if (fs.existsSync(seedFile)) {
      fs.copyFileSync(seedFile, ordersFile);
    } else {
      fs.writeFileSync(ordersFile, '[]');
    }
  } catch (e) {}
}

const PLANS = {
  '1 Day': { inr: 20, days: 1, likes: 200 },
  '7 Days': { inr: 90, days: 7, likes: 1400 },
  '15 Days': { inr: 190, days: 15, likes: 3000 },
  '30 Days': { inr: 350, days: 30, likes: 6000 },
  '60 Days': { inr: 600, days: 60, likes: 12000 },
  '90 Days': { inr: 800, days: 90, likes: 18000 }
};
const SERVERS = ['IND','BR','US','SG','RU','ID','TW','VN','TH','PK','BD','EUROPE','ME','SAC','NA'];

// Security: Block direct public access to sensitive files and order database
app.use((req, res, next) => {
  const normalized = req.path.toLowerCase();
  if (
    normalized.startsWith('/.env') ||
    normalized === '/package.json' ||
    normalized === '/package-lock.json' ||
    (!process.env.VERCEL && normalized === '/server.js') ||
    normalized === '/bot.js' ||
    normalized === '/data/orders.json' ||
    normalized.startsWith('/.git')
  ) {
    return res.status(403).type('text/plain').send('Access Forbidden');
  }
  next();
});

// Canonical Host Redirect: 301 Redirect old onrender.com URLs to the custom domain https://fflike.sbs
app.use((req, res, next) => {
  const host = req.get('host') || '';
  if (host.includes('onrender.com')) {
    return res.redirect(301, `https://fflike.sbs${req.originalUrl}`);
  }
  next();
});

// SEO: 301 Permanent Redirect from /index.html to / for canonicalization
app.get('/index.html', (req, res) => {
  res.redirect(301, '/');
});

// Clean URLs: 301 redirect .html URLs to extensionless clean URLs and serve clean routes
const cleanRoutes = [
  'pricing',
  'how-it-works',
  'faq',
  'order-status',
  'contact',
  'about',
  'free-likes',
  'privacy-policy',
  'terms-of-service',
  'refund-policy',
  'blog'
];

// Legacy URL 301 redirects to normalized canonical paths
app.get(['/privacy', '/privacy.html'], (req, res) => res.redirect(301, '/privacy-policy'));
app.get(['/terms', '/terms.html'], (req, res) => res.redirect(301, '/terms-of-service'));

cleanRoutes.forEach((route) => {
  app.get(`/${route}.html`, (req, res) => {
    res.redirect(301, `/${route}`);
  });
  app.get(`/${route}`, (req, res) => {
    const file = path.join(publicDir, `${route}.html`);
    if (fs.existsSync(file)) {
      res.sendFile(file);
    } else {
      res.redirect(301, '/');
    }
  });
});

// Blog guide post routing: /blog/:slug
app.get('/blog/:slug', (req, res) => {
  const slug = req.params.slug.replace(/[^a-z0-9-]/gi, '');
  const blogFile = path.join(publicDir, 'blog', `${slug}.html`);
  if (fs.existsSync(blogFile)) {
    res.sendFile(blogFile);
  } else {
    res.redirect(301, '/blog');
  }
});

// Explicit SEO endpoints with edge caching for Googlebot and crawlers
app.get('/robots.txt', (req, res) => {
  res.set({
    'Content-Type': 'text/plain; charset=utf-8',
    'Cache-Control': 'public, max-age=3600, s-maxage=86400, stale-while-revalidate=604800',
    'X-Robots-Tag': 'all'
  });
  res.sendFile(path.join(publicDir, 'robots.txt'));
});

app.get(['/sitemap.xml', '/sitemap'], (req, res) => {
  res.set({
    'Content-Type': 'application/xml; charset=utf-8',
    'Cache-Control': 'public, max-age=3600, s-maxage=86400, stale-while-revalidate=604800',
    'X-Robots-Tag': 'all'
  });
  res.sendFile(path.join(publicDir, 'sitemap.xml'));
});

app.get('/favicon.ico', (req, res) => {
  const ico = path.join(publicDir, 'favicon.ico');
  if (fs.existsSync(ico)) {
    res.type('image/x-icon');
    res.sendFile(ico);
  } else {
    res.status(204).end();
  }
});

// Explicit static routes for critical frontend assets
app.get('/styles.css', (req, res) => {
  const f = fs.existsSync(path.join(__dirname, 'styles.css')) ? path.join(__dirname, 'styles.css') : path.join(process.cwd(), 'styles.css');
  res.setHeader('Content-Type', 'text/css; charset=UTF-8');
  res.setHeader('Cache-Control', 'public, max-age=86400, stale-while-revalidate=604800');
  res.sendFile(f);
});

app.get('/app.js', (req, res) => {
  const f = fs.existsSync(path.join(__dirname, 'app.js')) ? path.join(__dirname, 'app.js') : path.join(process.cwd(), 'app.js');
  res.setHeader('Content-Type', 'application/javascript; charset=UTF-8');
  res.setHeader('Cache-Control', 'public, max-age=86400, stale-while-revalidate=604800');
  res.sendFile(f);
});

app.get('/config.js', (req, res) => {
  const f = fs.existsSync(path.join(__dirname, 'config.js')) ? path.join(__dirname, 'config.js') : path.join(process.cwd(), 'config.js');
  res.setHeader('Content-Type', 'application/javascript; charset=UTF-8');
  res.sendFile(f);
});

// Performance: Cache headers for static assets
app.use('/assets', express.static(path.join(__dirname, 'assets'), {
  maxAge: '1d',
  setHeaders: (res) => {
    res.setHeader('Cache-Control', 'public, max-age=86400, stale-while-revalidate=604800');
  }
}));

app.use(express.json({ limit: '200kb' }));
app.use(express.urlencoded({ extended: true, limit: '200kb' }));
app.use(express.static(publicDir));

const upload = multer({
  dest: proofDir,
  limits: { fileSize: 8 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ok = ['image/jpeg', 'image/png', 'image/webp'].includes(file.mimetype);
    cb(ok ? null : new Error('Only JPG, PNG or WEBP images are allowed'), ok);
  }
});

function readOrders() {
  try { return JSON.parse(fs.readFileSync(ordersFile, 'utf8')); }
  catch { return []; }
}
function writeOrders(list) {
  fs.writeFileSync(ordersFile, JSON.stringify(list, null, 2));
}
function safeId() {
  return `FF-${Date.now().toString(36).toUpperCase()}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
}

function publicConfig() {
  return {
    brand: { name: process.env.STORE_NAME || 'FREE FIRE AUTO LIKE' },
    contact: {
      adminTelegram: process.env.ADMIN_TELEGRAM || 'riyaznx',
      adminTelegramUrl: `https://t.me/${String(process.env.ADMIN_TELEGRAM || 'riyaznx').replace(/^@/, '')}`,
      community: process.env.COMMUNITY_TELEGRAM || 'AutoLikeGrp',
      communityUrl: `https://t.me/${String(process.env.COMMUNITY_TELEGRAM || 'AutoLikeGrp').replace(/^@/, '')}`
    },
    payment: {
      qrPath: process.env.PAYMENT_QR_PATH || '/assets/payment-qr.png',
      upiId: process.env.UPI_ID || 'riyaznxx@nyes',
      accountName: process.env.PAYMENT_ACCOUNT_NAME || 'Mohhamad Riyaz',
      note: 'Pay the exact amount shown, then submit the UTR/reference and payment screenshot.'
    }
  };
}

app.get('/api/config', (req, res) => res.json(publicConfig()));

app.post('/api/orders', (req, res) => {
  const { plan, uid, server, telegram } = req.body || {};
  const p = PLANS[plan];
  if (!p) return res.status(400).json({ error: 'Invalid plan' });
  if (!/^\d{5,15}$/.test(String(uid || ''))) return res.status(400).json({ error: 'Invalid UID' });
  if (!SERVERS.includes(String(server || ''))) return res.status(400).json({ error: 'Invalid server' });
  
  const order = {
    id: safeId(),
    plan,
    uid: String(uid).trim(),
    server: String(server).trim(),
    telegram: String(telegram || '').trim().slice(0, 64),
    amount: p.inr,
    likes: p.likes,
    days: p.days,
    status: 'awaiting_payment',
    utr: '',
    proof: '',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  const orders = readOrders();
  orders.unshift(order);
  writeOrders(orders);
  res.json({
    ok: true,
    order,
    payment: publicConfig().payment,
    adminTelegram: publicConfig().contact.adminTelegram
  });
});

app.post('/api/orders/:id/proof', upload.single('proof'), async (req, res) => {
  const orders = readOrders();
  const idx = orders.findIndex(o => o.id === req.params.id);
  if (idx < 0) {
    if (req.file) { try { fs.unlinkSync(req.file.path); } catch {} }
    return res.status(404).json({ error: 'Order not found' });
  }
  const utr = String(req.body.utr || '').trim().slice(0, 64);
  if (!utr) {
    if (req.file) { try { fs.unlinkSync(req.file.path); } catch {} }
    return res.status(400).json({ error: 'UTR/reference is required' });
  }
  if (!req.file) {
    return res.status(400).json({ error: 'Payment screenshot is required' });
  }
  const ext = req.file.mimetype === 'image/png' ? '.png' : req.file.mimetype === 'image/webp' ? '.webp' : '.jpg';
  const finalName = `${req.params.id}${ext}`;
  const finalPath = path.join(proofDir, finalName);
  try {
    fs.renameSync(req.file.path, finalPath);
  } catch (err) {
    return res.status(500).json({ error: 'Failed to save payment proof image' });
  }
  orders[idx].utr = utr;
  orders[idx].proof = `/data/proofs/${finalName}`;
  orders[idx].status = 'proof_submitted';
  orders[idx].updatedAt = new Date().toISOString();
  writeOrders(orders);
  try {
    await notifyAdmin(orders[idx]);
  } catch (e) {
    console.error('[Telegram notify]', e.message);
  }
  res.json({ ok: true, order: orders[idx] });
});

app.get('/api/orders/:id', (req, res) => {
  const order = readOrders().find(o => o.id === req.params.id);
  if (!order) return res.status(404).json({ error: 'Order not found' });
  res.json({
    order: {
      id: order.id,
      plan: order.plan,
      uid: order.uid,
      server: order.server,
      amount: order.amount,
      status: order.status,
      utr: order.utr,
      createdAt: order.createdAt
    }
  });
});

function admin(req, res, next) {
  const key = req.headers['x-admin-key'] || req.query.key;
  if (!process.env.ADMIN_KEY || key !== process.env.ADMIN_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

app.get('/api/admin/orders', admin, (req, res) => res.json({ orders: readOrders() }));

app.post('/api/admin/orders/:id/status', admin, (req, res) => {
  const allowed = ['awaiting_payment', 'proof_submitted', 'processing', 'completed', 'rejected'];
  const status = String(req.body.status || '');
  if (!allowed.includes(status)) return res.status(400).json({ error: 'Invalid status' });
  const orders = readOrders();
  const idx = orders.findIndex(o => o.id === req.params.id);
  if (idx < 0) return res.status(404).json({ error: 'Order not found' });
  orders[idx].status = status;
  orders[idx].updatedAt = new Date().toISOString();
  writeOrders(orders);
  res.json({ ok: true, order: orders[idx] });
});

app.get('/health', (req, res) => res.json({ ok: true, service: 'FF Auto Like Manual Checkout' }));

app.use((err, req, res, next) => {
  if (err) return res.status(400).json({ error: err.message || 'Request failed' });
  next(err);
});

function startServer(port) {
  const server = app.listen(port, () => console.log(`FF AUTO LIKE running on http://localhost:${server.address().port}`));
  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      const nextPort = port + 1;
      console.warn(`Port ${port} is already in use. Trying ${nextPort}...`);
      startServer(nextPort);
    } else {
      throw err;
    }
  });
  return server;
}

if (!process.env.VERCEL) {
  startServer(REQUESTED_PORT);

  // Keep-Alive: Ping robots.txt every 10 minutes to maintain fast responses on Render
  const pingUrl = process.env.RENDER_EXTERNAL_URL || 'https://fflike.sbs/robots.txt';
  setInterval(() => {
    fetch(pingUrl).catch(() => {});
  }, 10 * 60 * 1000);
}

module.exports = app;
