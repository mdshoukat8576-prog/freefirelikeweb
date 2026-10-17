/**
 * db.js — Async SQLite database using sql.js (pure JS, no native compilation)
 * Persists to disk as binary file. Must call initDb() before use.
 */
const path   = require('path');
const fs     = require('fs');
const crypto = require('crypto');

const isVercel = Boolean(process.env.VERCEL);
const dataDir  = isVercel ? '/tmp/data' : path.join(__dirname, 'data');
const DB_FILE  = path.join(dataDir, 'fflike.db');

try { fs.mkdirSync(dataDir, { recursive: true }); } catch (_) {}

let db   = null;
let SQL  = null;
let _initPromise = null;

async function initDb() {
  if (db) return db;
  if (_initPromise) return _initPromise;
  _initPromise = (async () => {
    try {
      const initSqlJs = require('sql.js');
      const wasmCandidates = [
        path.join(__dirname, 'node_modules', 'sql.js', 'dist', 'sql-wasm.wasm'),
        path.join(process.cwd(), 'node_modules', 'sql.js', 'dist', 'sql-wasm.wasm')
      ];
      const wasmPath = wasmCandidates.find(p => fs.existsSync(p));
      if (wasmPath) {
        SQL = await initSqlJs({ locateFile: () => wasmPath });
      } else {
        SQL = await initSqlJs();
      }
      if (fs.existsSync(DB_FILE)) {
        const buf = fs.readFileSync(DB_FILE);
        db = new SQL.Database(buf);
      } else {
        db = new SQL.Database();
      }
      createSchema();
      saveDb();
      return db;
    } catch (e) {
      console.warn('[DB] initDb fallback:', e.message);
      return null;
    }
  })();
  return _initPromise;
}

function saveDb() {
  if (!db) return;
  try {
    const data = db.export();
    fs.writeFileSync(DB_FILE, Buffer.from(data));
  } catch (e) {
    console.error('[DB] Save error:', e.message);
  }
}

function createSchema() {
  db.run(`CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    telegram_id TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL,
    username TEXT,
    photo_url TEXT,
    referral_code TEXT UNIQUE NOT NULL,
    credits INTEGER DEFAULT 0 NOT NULL,
    channels_verified INTEGER DEFAULT 0,
    channels_verified_at TEXT,
    initial_reward_claimed INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now'))
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS credit_transactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    type TEXT NOT NULL,
    amount INTEGER NOT NULL,
    balance_after INTEGER NOT NULL,
    reason TEXT, ref TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS likes_requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    uid TEXT NOT NULL, region TEXT NOT NULL,
    likes_before INTEGER DEFAULT 0, likes_after INTEGER DEFAULT 0,
    likes_given INTEGER DEFAULT 0, nickname TEXT, level INTEGER DEFAULT 0,
    status TEXT DEFAULT 'pending', credit_charged INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now'))
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS referrals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    referrer_id INTEGER NOT NULL, referred_id INTEGER UNIQUE NOT NULL,
    status TEXT DEFAULT 'pending', reward_claimed INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now'))
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS credit_orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL, razorpay_order_id TEXT UNIQUE,
    razorpay_payment_id TEXT, credits INTEGER NOT NULL,
    amount_paise INTEGER NOT NULL, status TEXT DEFAULT 'created',
    fulfilled INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now'))
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS guild_glory_orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER,
    order_ref TEXT UNIQUE NOT NULL, package_key TEXT NOT NULL,
    package_name TEXT NOT NULL, currency TEXT NOT NULL, amount TEXT NOT NULL,
    guild_uid TEXT, region TEXT,
    payment_status TEXT DEFAULT 'pending', fulfillment_status TEXT DEFAULT 'awaiting_payment',
    utr TEXT, telegram TEXT, proof TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  )`);
  try { db.run(`ALTER TABLE guild_glory_orders ADD COLUMN guild_uid TEXT`); } catch (_) {}
  try { db.run(`ALTER TABLE guild_glory_orders ADD COLUMN region TEXT`); } catch (_) {}
  db.run(`CREATE TABLE IF NOT EXISTS webhook_events (
    event_id TEXT PRIMARY KEY,
    processed_at TEXT DEFAULT (datetime('now'))
  )`);
}

// Low-level helpers
function dbGet(sql, params = []) {
  const stmt = db.prepare(sql);
  stmt.bind(params);
  let row = null;
  if (stmt.step()) row = stmt.getAsObject();
  stmt.free();
  return row;
}
function dbAll(sql, params = []) {
  const rows = [];
  const stmt = db.prepare(sql);
  stmt.bind(params);
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  return rows;
}
function dbRun(sql, params = []) {
  db.run(sql, params);
  saveDb();
}

function makeReferralCode() {
  return crypto.randomBytes(5).toString('hex').toUpperCase();
}

// ─── User helpers ────────────────────────────────────────────────────────────
function getUser(telegramId) {
  return dbGet('SELECT * FROM users WHERE telegram_id = ?', [String(telegramId)]);
}
function getUserById(id) {
  return dbGet('SELECT * FROM users WHERE id = ?', [id]);
}
function createUser({ telegram_id, name, username, photo_url }) {
  let code = makeReferralCode();
  while (dbGet('SELECT id FROM users WHERE referral_code = ?', [code])) code = makeReferralCode();
  dbRun(
    'INSERT INTO users (telegram_id,name,username,photo_url,referral_code,credits) VALUES (?,?,?,?,?,0)',
    [String(telegram_id), name, username || null, photo_url || null, code]
  );
  return getUser(telegram_id);
}
function upsertUser({ telegram_id, name, username, photo_url }) {
  const existing = getUser(telegram_id);
  if (existing) {
    dbRun('UPDATE users SET name=?,username=?,photo_url=? WHERE telegram_id=?',
      [name, username || null, photo_url || null, String(telegram_id)]);
    return getUser(telegram_id);
  }
  return createUser({ telegram_id, name, username, photo_url });
}
function updateUser(telegramId, fields) {
  const allowed = ['name','username','photo_url','channels_verified','channels_verified_at','initial_reward_claimed'];
  const keys = Object.keys(fields).filter(k => allowed.includes(k));
  if (!keys.length) return;
  const sets = keys.map(k => `${k}=?`).join(',');
  dbRun(`UPDATE users SET ${sets} WHERE telegram_id=?`, [...keys.map(k => fields[k]), String(telegramId)]);
}

/**
 * Atomically change credits + record transaction
 * delta > 0 = credit, delta < 0 = debit
 */
function updateUserCredits(userId, delta, type, reason = '', ref = '') {
  const user = getUserById(userId);
  if (!user) throw new Error('User not found');
  const newBalance = (user.credits || 0) + delta;
  if (newBalance < 0) throw new Error('Insufficient credits');
  db.run('UPDATE users SET credits=? WHERE id=?', [newBalance, userId]);
  db.run('INSERT INTO credit_transactions(user_id,type,amount,balance_after,reason,ref) VALUES(?,?,?,?,?,?)',
    [userId, type, delta, newBalance, reason, ref]);
  saveDb();
  return newBalance;
}

// ─── Likes ───────────────────────────────────────────────────────────────────
function getLikesHistory(userId, limit = 30) {
  return dbAll('SELECT * FROM likes_requests WHERE user_id=? ORDER BY created_at DESC LIMIT ?', [userId, limit]);
}
function createLikesRequest(d) {
  dbRun(
    'INSERT INTO likes_requests(user_id,uid,region,likes_before,likes_after,likes_given,nickname,level,status,credit_charged) VALUES(?,?,?,?,?,?,?,?,?,?)',
    [d.user_id, d.uid, d.region, d.likes_before||0, d.likes_after||0, d.likes_given||0, d.nickname||'', d.level||0, d.status||'success', d.credit_charged||0]
  );
  return dbGet('SELECT * FROM likes_requests WHERE user_id=? ORDER BY id DESC LIMIT 1', [d.user_id]);
}

// ─── Credits ─────────────────────────────────────────────────────────────────
function getCreditHistory(userId, limit = 50) {
  return dbAll('SELECT * FROM credit_transactions WHERE user_id=? ORDER BY created_at DESC LIMIT ?', [userId, limit]);
}
function createCreditOrder(d) {
  dbRun('INSERT INTO credit_orders(user_id,razorpay_order_id,credits,amount_paise,status) VALUES(?,?,?,?,?)',
    [d.user_id, d.razorpay_order_id, d.credits, d.amount_paise, 'created']);
  return dbGet('SELECT * FROM credit_orders WHERE razorpay_order_id=?', [d.razorpay_order_id]);
}
function getCreditOrder(rpOrderId) {
  return dbGet('SELECT * FROM credit_orders WHERE razorpay_order_id=?', [rpOrderId]);
}
function fulfillCreditOrder(rpOrderId, paymentId) {
  const order = getCreditOrder(rpOrderId);
  if (!order || order.fulfilled) return null;
  dbRun('UPDATE credit_orders SET status=?,fulfilled=1,razorpay_payment_id=? WHERE razorpay_order_id=?',
    ['paid', paymentId, rpOrderId]);
  return getCreditOrder(rpOrderId);
}

// ─── Guild Glory ─────────────────────────────────────────────────────────────
function getGuildGloryOrders(userId) {
  return dbAll('SELECT * FROM guild_glory_orders WHERE user_id=? ORDER BY created_at DESC', [userId]);
}
function getGuildGloryOrderByRef(ref) {
  return dbGet('SELECT * FROM guild_glory_orders WHERE order_ref=?', [ref]);
}
function createGuildGloryOrder(d) {
  dbRun('INSERT INTO guild_glory_orders(user_id,order_ref,package_key,package_name,currency,amount,guild_uid,region,utr,telegram) VALUES(?,?,?,?,?,?,?,?,?,?)',
    [d.user_id||null, d.order_ref, d.package_key, d.package_name, d.currency, d.amount, d.guild_uid||'', d.region||'IND', d.utr||'', d.telegram||'']);
  return getGuildGloryOrderByRef(d.order_ref);
}
function updateGuildGloryOrder(orderRef, fields) {
  const allowed = ['payment_status','fulfillment_status','utr','proof','guild_uid','region'];
  const keys = Object.keys(fields).filter(k => allowed.includes(k));
  if (!keys.length) return;
  const sets = keys.map(k => `${k}=?`).join(',');
  dbRun(`UPDATE guild_glory_orders SET ${sets} WHERE order_ref=?`, [...keys.map(k => fields[k]), orderRef]);
}

// ─── Referrals ────────────────────────────────────────────────────────────────
function getReferralInfo(userId) {
  const user = getUserById(userId);
  if (!user) return null;
  const refs = dbAll('SELECT * FROM referrals WHERE referrer_id=?', [userId]);
  const completed = refs.filter(r => r.status === 'completed');
  return {
    referral_code: user.referral_code,
    total_referrals: refs.length,
    completed_referrals: completed.length,
    credits_earned: completed.filter(r => r.reward_claimed).length,
    referrals: refs
  };
}
function createReferral(referrerId, referredId) {
  if (referrerId === referredId) return null;
  if (dbGet('SELECT id FROM referrals WHERE referred_id=?', [referredId])) return null;
  dbRun('INSERT INTO referrals(referrer_id,referred_id,status) VALUES(?,?,?)', [referrerId, referredId, 'pending']);
  return dbGet('SELECT * FROM referrals WHERE referred_id=?', [referredId]);
}
function completeReferral(referredId) {
  const ref = dbGet('SELECT * FROM referrals WHERE referred_id=?', [referredId]);
  if (!ref || ref.reward_claimed) return null;
  dbRun('UPDATE referrals SET status=?,reward_claimed=1 WHERE id=?', ['completed', ref.id]);
  return ref;
}

// ─── Webhooks ─────────────────────────────────────────────────────────────────
function isWebhookProcessed(eventId) {
  return !!dbGet('SELECT event_id FROM webhook_events WHERE event_id=?', [eventId]);
}
function markWebhookProcessed(eventId) {
  dbRun('INSERT OR IGNORE INTO webhook_events(event_id) VALUES(?)', [eventId]);
}

module.exports = {
  initDb,
  getUser, getUserById, createUser, upsertUser, updateUser, updateUserCredits,
  getLikesHistory, createLikesRequest,
  getCreditHistory, createCreditOrder, getCreditOrder, fulfillCreditOrder,
  getGuildGloryOrders, getGuildGloryOrderByRef, createGuildGloryOrder, updateGuildGloryOrder,
  getReferralInfo, createReferral, completeReferral,
  isWebhookProcessed, markWebhookProcessed,
  saveDb
};
