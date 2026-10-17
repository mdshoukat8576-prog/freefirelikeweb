/**
 * cloudStore.js — Persistent Cloud Storage for Vercel Serverless
 * Uses keyvalue.immanuel.co cloud KV engine with Base64 encoding.
 * Ensures user state, verified status, credits, and orders persist
 * across lambda cold starts, restarts, logouts, and multi-region deployments.
 */

const APP_KEY = process.env.KV_APP_KEY || 'caicrp1u';
const BASE_URL = 'https://keyvalue.immanuel.co/api/KeyVal';

async function fetchWithTimeout(url, opts = {}, timeoutMs = 3500) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...opts, signal: ctrl.signal });
    clearTimeout(t);
    return res;
  } catch (err) {
    clearTimeout(t);
    throw err;
  }
}

async function getVal(key) {
  try {
    const r = await fetchWithTimeout(`${BASE_URL}/GetValue/${APP_KEY}/${encodeURIComponent(key)}`, {}, 3000);
    if (!r.ok) return null;
    const data = await r.json();
    if (!data || typeof data !== 'string' || !data.trim()) return null;
    const jsonStr = Buffer.from(data, 'base64').toString('utf8');
    return JSON.parse(jsonStr);
  } catch (e) {
    // Fail silently, caller can fallback to local SQLite
    return null;
  }
}

async function setVal(key, obj) {
  try {
    const b64 = Buffer.from(JSON.stringify(obj)).toString('base64');
    const r = await fetchWithTimeout(
      `${BASE_URL}/UpdateValue/${APP_KEY}/${encodeURIComponent(key)}/${encodeURIComponent(b64)}`,
      { method: 'POST' },
      3000
    );
    return r.ok;
  } catch (e) {
    return false;
  }
}

// ── User State Management ───────────────────────────────────────────────────

/**
 * Get user profile and state from cloud KV.
 * Returns null if user has never been recorded.
 */
async function getUser(telegramId) {
  const tid = String(telegramId || '').trim();
  if (!tid) return null;
  return await getVal(`u_${tid}`);
}

/**
 * Save / update user in cloud KV.
 */
async function saveUser(telegramId, data) {
  const tid = String(telegramId || '').trim();
  if (!tid) return false;
  const existing = (await getUser(tid)) || {};
  const merged = {
    ...existing,
    ...data,
    telegram_id: tid,
    updated_at: new Date().toISOString()
  };
  return await setVal(`u_${tid}`, merged);
}

/**
 * Check if a telegram user has EVER claimed the free initial channel reward.
 * Uses both dedicated claim flag and user record.
 */
async function hasClaimedInitialReward(telegramId) {
  const tid = String(telegramId || '').trim();
  if (!tid) return false;
  // 1. Check dedicated immutable claimed flag
  const flag = await getVal(`claimed_${tid}`);
  if (flag === 1 || flag === '1' || flag === true) return true;
  // 2. Check user profile state
  const u = await getUser(tid);
  if (u && (u.initial_reward_claimed === 1 || u.initial_reward_claimed === true)) {
    // Ensure flag is also set
    setVal(`claimed_${tid}`, 1).catch(() => {});
    return true;
  }
  return false;
}

/**
 * Permanently mark the initial reward as claimed for this telegram user.
 * This can NEVER be reset by logout or container restarts.
 */
async function markInitialRewardClaimed(telegramId) {
  const tid = String(telegramId || '').trim();
  if (!tid) return false;
  await setVal(`claimed_${tid}`, 1);
  const u = (await getUser(tid)) || {};
  u.initial_reward_claimed = 1;
  u.channels_verified = 1;
  u.claimed_at = new Date().toISOString();
  await saveUser(tid, u);
  return true;
}

/**
 * Atomically update credits in cloud KV.
 */
async function updateCredits(telegramId, delta, type = 'credit', reason = '', ref = '') {
  const tid = String(telegramId || '').trim();
  if (!tid) return 0;
  const u = (await getUser(tid)) || { telegram_id: tid, credits: 0 };
  const current = Number(u.credits || 0);
  const newBalance = Math.max(0, current + delta);
  u.credits = newBalance;
  await saveUser(tid, u);

  // Append to transaction log
  try {
    const txLog = (await getVal(`tx_${tid}`)) || [];
    txLog.unshift({
      delta,
      balance_after: newBalance,
      type,
      reason,
      ref,
      time: new Date().toISOString()
    });
    // Keep last 30 transactions
    await setVal(`tx_${tid}`, txLog.slice(0, 30));
  } catch (_) {}

  return newBalance;
}

// ── Likes History ───────────────────────────────────────────────────────────

async function addLikesHistory(telegramId, item) {
  const tid = String(telegramId || '').trim();
  if (!tid) return;
  try {
    const history = (await getVal(`likes_${tid}`)) || [];
    history.unshift({
      ...item,
      created_at: new Date().toISOString()
    });
    await setVal(`likes_${tid}`, history.slice(0, 30));
  } catch (_) {}
}

async function getLikesHistory(telegramId) {
  const tid = String(telegramId || '').trim();
  if (!tid) return [];
  return (await getVal(`likes_${tid}`)) || [];
}

// ── Orders Management ───────────────────────────────────────────────────────

async function saveCreditOrder(orderId, orderData) {
  const oid = String(orderId || '').trim();
  if (!oid) return false;
  return await setVal(`ord_${oid}`, { ...orderData, updated_at: new Date().toISOString() });
}

async function getCreditOrder(orderId) {
  const oid = String(orderId || '').trim();
  if (!oid) return null;
  return await getVal(`ord_${oid}`);
}

async function saveCreditPurchaseOrder(orderRef, orderData) {
  const ref = String(orderRef || '').trim();
  if (!ref) return false;
  const existing = (await getCreditPurchaseOrder(ref)) || {};
  const merged = { ...existing, ...orderData, order_ref: ref, updated_at: new Date().toISOString() };
  await setVal(`cpo_${ref}`, merged);

  if (merged.telegram_id) {
    try {
      const list = (await getVal(`cpos_${merged.telegram_id}`)) || [];
      const idx = list.findIndex(o => o.order_ref === ref);
      if (idx >= 0) list[idx] = { ...list[idx], ...merged };
      else list.unshift(merged);
      await setVal(`cpos_${merged.telegram_id}`, list.slice(0, 30));
    } catch (_) {}
  }
  return true;
}

async function getCreditPurchaseOrder(orderRef) {
  const ref = String(orderRef || '').trim();
  if (!ref) return null;
  return await getVal(`cpo_${ref}`);
}

async function getUserCreditPurchaseOrders(telegramId) {
  const tid = String(telegramId || '').trim();
  if (!tid) return [];
  return (await getVal(`cpos_${tid}`)) || [];
}

module.exports = {
  getUser,
  saveUser,
  hasClaimedInitialReward,
  markInitialRewardClaimed,
  updateCredits,
  addLikesHistory,
  getLikesHistory,
  saveCreditOrder,
  getCreditOrder,
  saveCreditPurchaseOrder,
  getCreditPurchaseOrder,
  getUserCreditPurchaseOrders
};
