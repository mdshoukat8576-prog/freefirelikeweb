/**
 * db.js — Async SQLite database using sql.js (pure JS, no native compilation)
 * Persists to disk as binary file. Must call initDb() before use.
 */
const path   = require('path');
const fs     = require('fs');
const crypto = require('crypto');
const cloudStore = require('./cloudStore');

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
      if (isVercel && !fs.existsSync(DB_FILE)) {
        const seed = path.join(__dirname, 'data', 'fflike.db');
        if (fs.existsSync(seed)) {
          try { fs.copyFileSync(seed, DB_FILE); } catch (_) {}
        }
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
  db.run(`CREATE TABLE IF NOT EXISTS webhook_events (
    event_id TEXT PRIMARY KEY,
    processed_at TEXT DEFAULT (datetime('now'))
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS credit_purchase_orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_ref TEXT UNIQUE NOT NULL,
    user_id INTEGER NOT NULL,
    telegram_id TEXT NOT NULL,
    name TEXT,
    username TEXT,
    credits INTEGER NOT NULL,
    currency TEXT NOT NULL,
    amount TEXT NOT NULL,
    utr TEXT NOT NULL,
    telegram TEXT,
    proof TEXT,
    status TEXT DEFAULT 'pending',
    admin_note TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
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
async function syncUserFromCloud(telegramId) {
  const tid = String(telegramId || '').trim();
  if (!tid) return null;
  try {
    const cloudUser = await cloudStore.getUser(tid);
    const hasClaimed = await cloudStore.hasClaimedInitialReward(tid);
    if (!cloudUser && !hasClaimed) return getUser(tid);

    let local = dbGet('SELECT * FROM users WHERE telegram_id = ?', [tid]);
    const photoUrl = cloudUser?.photo_url || local?.photo_url || `/api/avatar/${tid}`;
    if (!local) {
      let code = cloudUser?.referral_code || makeReferralCode();
      while (dbGet('SELECT id FROM users WHERE referral_code = ?', [code])) code = makeReferralCode();
      dbRun(
        'INSERT INTO users (telegram_id,name,username,photo_url,referral_code,credits,channels_verified,initial_reward_claimed) VALUES (?,?,?,?,?,?,?,?)',
        [
          tid,
          cloudUser?.name || 'User',
          cloudUser?.username || null,
          photoUrl,
          code,
          cloudUser?.credits !== undefined ? Number(cloudUser.credits) : 0,
          (cloudUser?.channels_verified || hasClaimed) ? 1 : 0,
          hasClaimed ? 1 : 0
        ]
      );
    } else {
      const fieldsToUpdate = {};
      if (hasClaimed && !local.initial_reward_claimed) {
        fieldsToUpdate.initial_reward_claimed = 1;
      }
      if ((cloudUser?.channels_verified || hasClaimed) && !local.channels_verified) {
        fieldsToUpdate.channels_verified = 1;
      }
      if (!local.photo_url && photoUrl) {
        fieldsToUpdate.photo_url = photoUrl;
      }
      if (Object.keys(fieldsToUpdate).length > 0) {
        updateUser(tid, fieldsToUpdate);
      }
      if (cloudUser?.credits !== undefined && Number(cloudUser.credits) !== Number(local.credits)) {
        dbRun('UPDATE users SET credits=? WHERE telegram_id=?', [Number(cloudUser.credits), tid]);
      }
    }
    return dbGet('SELECT * FROM users WHERE telegram_id = ?', [tid]);
  } catch (err) {
    console.warn('[DB] syncUserFromCloud error:', err.message);
    return getUser(tid);
  }
}

function getUser(telegramId) {
  return dbGet('SELECT * FROM users WHERE telegram_id = ?', [String(telegramId)]);
}
function getUserById(id) {
  return dbGet('SELECT * FROM users WHERE id = ?', [id]);
}
function createUser({ telegram_id, name, username, photo_url }) {
  let code = makeReferralCode();
  while (dbGet('SELECT id FROM users WHERE referral_code = ?', [code])) code = makeReferralCode();
  const finalPhoto = photo_url || `/api/avatar/${telegram_id}`;
  dbRun(
    'INSERT INTO users (telegram_id,name,username,photo_url,referral_code,credits) VALUES (?,?,?,?,?,0)',
    [String(telegram_id), name, username || null, finalPhoto, code]
  );
  cloudStore.saveUser(telegram_id, { name, username, photo_url: finalPhoto, referral_code: code, credits: 0 }).catch(() => {});
  return getUser(telegram_id);
}
function upsertUser({ telegram_id, name, username, photo_url }) {
  const existing = getUser(telegram_id);
  const finalPhoto = photo_url || existing?.photo_url || `/api/avatar/${telegram_id}`;
  if (existing) {
    dbRun('UPDATE users SET name=?,username=?,photo_url=? WHERE telegram_id=?',
      [name, username || null, finalPhoto, String(telegram_id)]);
    cloudStore.saveUser(telegram_id, { name, username, photo_url: finalPhoto }).catch(() => {});
    return getUser(telegram_id);
  }
  return createUser({ telegram_id, name, username, photo_url: finalPhoto });
}
function updateUser(telegramId, fields) {
  const allowed = ['name','username','photo_url','channels_verified','channels_verified_at','initial_reward_claimed'];
  const keys = Object.keys(fields).filter(k => allowed.includes(k) && fields[k] !== null && fields[k] !== undefined);
  if (!keys.length) return;
  const sets = keys.map(k => `${k}=?`).join(',');
  dbRun(`UPDATE users SET ${sets} WHERE telegram_id=?`, [...keys.map(k => fields[k]), String(telegramId)]);
  cloudStore.saveUser(telegramId, fields).catch(() => {});
  if (fields.initial_reward_claimed) {
    cloudStore.markInitialRewardClaimed(telegramId).catch(() => {});
  }
}

/**
 * Atomically change credits + record transaction
 * delta > 0 = credit, delta < 0 = debit
 */
function updateUserCredits(userId, delta, type, reason = '', ref = '') {
  let user = getUserById(userId);
  if (!user) user = getUser(userId);
  if (!user) throw new Error('User not found: ' + userId);
  const newBalance = Math.max(0, (user.credits || 0) + delta);
  dbRun('UPDATE users SET credits=? WHERE id=?', [newBalance, user.id]);
  try {
    dbRun('INSERT INTO credit_transactions(user_id,type,amount,balance_after,reason,ref) VALUES(?,?,?,?,?,?)',
      [user.id, type, delta, newBalance, reason, ref]);
  } catch (_) {}
  if (user.telegram_id) {
    cloudStore.updateCredits(user.telegram_id, delta, type, reason, ref).catch(() => {});
  }
  return newBalance;
}

// ─── Likes ───────────────────────────────────────────────────────────────────
function getLikesHistory(userId, limit = 50) {
  return dbAll('SELECT * FROM likes_requests WHERE user_id=? ORDER BY created_at DESC LIMIT ?', [userId, limit]);
}
async function getLikesHistoryAsync(userId, telegramId, limit = 50) {
  let local = [];
  try {
    if (userId) local = dbAll('SELECT * FROM likes_requests WHERE user_id=? ORDER BY created_at DESC LIMIT ?', [userId, limit]) || [];
  } catch (_) {}
  let cloud = [];
  if (telegramId) {
    try {
      cloud = (await cloudStore.getLikesHistory(telegramId)) || [];
    } catch (_) {}
  }
  const map = new Map();
  local.forEach(r => {
    const k = `${r.uid}_${r.created_at || r.id}`;
    map.set(k, r);
  });
  cloud.forEach(r => {
    const k = `${r.uid}_${r.created_at || r.time || ''}`;
    if (!map.has(k)) {
      map.set(k, {
        ...r,
        created_at: r.created_at || r.time || new Date().toISOString()
      });
    }
  });
  const list = Array.from(map.values()).sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0));
  return list.slice(0, limit);
}
function createLikesRequest(d) {
  const now = d.created_at || new Date().toISOString();
  dbRun(
    'INSERT INTO likes_requests(user_id,uid,region,likes_before,likes_after,likes_given,nickname,level,status,credit_charged,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)',
    [d.user_id, d.uid, d.region, d.likes_before||0, d.likes_after||0, d.likes_given||0, d.nickname||'', d.level||0, d.status||'success', d.credit_charged||0, now]
  );
  const u = getUserById(d.user_id);
  if (u && u.telegram_id) {
    cloudStore.addLikesHistory(u.telegram_id, { ...d, created_at: now }).catch(() => {});
  }
  return dbGet('SELECT * FROM likes_requests WHERE user_id=? ORDER BY id DESC LIMIT 1', [d.user_id]);
}

// ─── Credits ─────────────────────────────────────────────────────────────────
function getCreditHistory(userId, limit = 50) {
  return dbAll('SELECT * FROM credit_transactions WHERE user_id=? ORDER BY created_at DESC LIMIT ?', [userId, limit]);
}
async function getCreditHistoryAsync(userId, telegramId, limit = 50) {
  let local = [];
  try {
    if (userId) local = dbAll('SELECT * FROM credit_transactions WHERE user_id=? ORDER BY created_at DESC LIMIT ?', [userId, limit]) || [];
  } catch (_) {}
  let cloud = [];
  if (telegramId) {
    try {
      cloud = (await cloudStore.getVal(`tx_${telegramId}`)) || [];
    } catch (_) {}
  }
  const map = new Map();
  local.forEach(t => {
    const k = t.ref ? `${t.type}_${t.ref}` : `${t.type}_${t.amount}_${t.created_at}`;
    map.set(k, t);
  });
  cloud.forEach(t => {
    const amt = t.delta !== undefined ? t.delta : t.amount;
    const time = t.time || t.created_at || new Date().toISOString();
    const k = t.ref ? `${t.type}_${t.ref}` : `${t.type}_${amt}_${time}`;
    if (!map.has(k)) {
      map.set(k, {
        created_at: time,
        type: t.type || 'credit',
        amount: amt,
        balance_after: t.balance_after,
        reason: t.reason || '',
        ref: t.ref || ''
      });
    }
  });
  const list = Array.from(map.values()).sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0));
  return list.slice(0, limit);
}
function createCreditOrder(d) {
  dbRun('INSERT INTO credit_orders(user_id,razorpay_order_id,credits,amount_paise,status) VALUES(?,?,?,?,?)',
    [d.user_id, d.razorpay_order_id, d.credits, d.amount_paise, 'created']);
  cloudStore.saveCreditOrder(d.razorpay_order_id, d).catch(() => {});
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
  cloudStore.saveCreditOrder(rpOrderId, { status: 'paid', fulfilled: 1, razorpay_payment_id: paymentId }).catch(() => {});
  return getCreditOrder(rpOrderId);
}

// ─── Manual Credit Purchase Orders ──────────────────────────────────────────
function createCreditPurchaseOrder(d) {
  dbRun(
    'INSERT INTO credit_purchase_orders (order_ref, user_id, telegram_id, name, username, credits, currency, amount, utr, telegram, proof, status) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
    [
      d.order_ref,
      d.user_id,
      String(d.telegram_id || ''),
      d.name || '',
      d.username || '',
      d.credits,
      d.currency,
      d.amount,
      d.utr,
      d.telegram || '',
      d.proof || '',
      'pending'
    ]
  );
  cloudStore.saveCreditPurchaseOrder(d.order_ref, d).catch(() => {});
  return getCreditPurchaseOrderByRef(d.order_ref);
}

function getCreditPurchaseOrderByRef(orderRef) {
  return dbGet('SELECT * FROM credit_purchase_orders WHERE order_ref = ?', [orderRef]);
}

function getCreditPurchaseOrders(userId, limit = 30) {
  return dbAll('SELECT * FROM credit_purchase_orders WHERE user_id = ? ORDER BY id DESC LIMIT ?', [userId, limit]);
}

function getCreditPurchaseOrdersByTid(telegramId, limit = 30) {
  return dbAll('SELECT * FROM credit_purchase_orders WHERE telegram_id = ? ORDER BY id DESC LIMIT ?', [String(telegramId), limit]);
}

function updateCreditPurchaseOrder(orderRef, fields) {
  const allowed = ['status', 'admin_note', 'proof', 'utr', 'updated_at'];
  const keys = Object.keys(fields).filter(k => allowed.includes(k));
  if (!keys.length) return;
  const sets = keys.map(k => `${k}=?`).join(',');
  dbRun(`UPDATE credit_purchase_orders SET ${sets} WHERE order_ref=?`, [...keys.map(k => fields[k]), orderRef]);
  cloudStore.saveCreditPurchaseOrder(orderRef, fields).catch(() => {});
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
  syncUserFromCloud,
  getLikesHistory, getLikesHistoryAsync, createLikesRequest,
  getCreditHistory, getCreditHistoryAsync, createCreditOrder, getCreditOrder, fulfillCreditOrder,
  createCreditPurchaseOrder, getCreditPurchaseOrderByRef, getCreditPurchaseOrders, getCreditPurchaseOrdersByTid, updateCreditPurchaseOrder,
  getGuildGloryOrders, getGuildGloryOrderByRef, createGuildGloryOrder, updateGuildGloryOrder,
  getReferralInfo, createReferral, completeReferral,
  isWebhookProcessed, markWebhookProcessed,
  saveDb
};
