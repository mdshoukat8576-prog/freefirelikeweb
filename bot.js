const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const NOTIFY_BOT_TOKEN = '8430101695:AAGx_Et9LWDBtKIFiwDBxjxnRrjaiZVitdM';
const LOGIN_BOT_TOKEN  = '8994422473:AAG8iknKl0eK41Lf9V0gYa7qB9eW3QmPlOE';
const DEFAULT_ADMIN_ID = '7932057377';

function getBotToken() {
  const t = (process.env.BOT_TOKEN || '').trim();
  // Reject stale / known unauthorized tokens from previous commits
  if (!t || t.startsWith('8979787188') || t.startsWith('8423545031') || t.startsWith('8829167111')) {
    return NOTIFY_BOT_TOKEN;
  }
  return t;
}

const BOT_TOKEN = getBotToken();
const ADMIN_CHAT_ID = String(process.env.ADMIN_CHAT_ID || DEFAULT_ADMIN_ID).trim();
const BOT_POLL_MS = Number(process.env.BOT_POLL_MS || 1000);

const isVercel = Boolean(process.env.VERCEL);
const dataDir = isVercel ? '/tmp/data' : path.join(__dirname, 'data');
const ordersFile = path.join(dataDir, 'orders.json');
const proofDir = path.join(dataDir, 'proofs');
try { fs.mkdirSync(dataDir, { recursive: true }); } catch (_) {}
try { fs.mkdirSync(proofDir, { recursive: true }); } catch (_) {}

console.log(`[Telegram] Bot active: ${BOT_TOKEN.slice(0, 10)}... Admin chat: ${ADMIN_CHAT_ID}`);

const api = async (method, body, tokenOverride = null) => {
  const token = tokenOverride || BOT_TOKEN;
  const r = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST',
    headers: {'content-type':'application/json'},
    body: JSON.stringify(body)
  });
  const data = await r.json();
  if (!data.ok) {
    if ((data.error_code === 401 || r.status === 401) && token !== NOTIFY_BOT_TOKEN) {
      console.warn(`[Telegram] ${method} got 401 with token, retrying with NOTIFY_BOT_TOKEN`);
      return api(method, body, NOTIFY_BOT_TOKEN);
    }
    throw new Error(data.description || `Telegram ${method} failed`);
  }
  return data.result;
};

function resolveProofPath(proof) {
  if (!proof) return null;
  const filename = path.basename(proof);
  const candidates = [
    proof,
    path.join(__dirname, proof.replace(/^\/?data[\\/]?/, 'data/')),
    path.join(dataDir, 'proofs', filename),
    path.join('/tmp/data/proofs', filename),
    path.join(__dirname, 'data', 'proofs', filename)
  ];
  for (const c of candidates) {
    try { if (fs.existsSync(c)) return c; } catch (_) {}
  }
  return null;
}

function readOrders() {
  try {
    if (fs.existsSync(ordersFile)) return JSON.parse(fs.readFileSync(ordersFile, 'utf8'));
    const seed = path.join(__dirname, 'data', 'orders.json');
    if (fs.existsSync(seed)) return JSON.parse(fs.readFileSync(seed, 'utf8'));
    return [];
  } catch {
    return [];
  }
}
function writeOrders(list) {
  try {
    fs.writeFileSync(ordersFile, JSON.stringify(list, null, 2));
  } catch (e) {
    console.error('[Orders] writeOrders error:', e.message);
  }
}
function esc(s){return String(s ?? '').replace(/[&<>]/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));}
function orderById(id){ return readOrders().find(o=>o.id===id); }

async function notifyAdmin(order){
  if (!BOT_TOKEN || !ADMIN_CHAT_ID) return;
  const text = [
    '🛒 <b>NEW AUTO LIKE PAYMENT</b>', '',
    `<b>Order:</b> <code>${esc(order.id)}</code>`,
    `<b>Plan:</b> ${esc(order.plan)}`,
    `<b>Amount:</b> ₹${esc(order.amount)}`,
    `<b>UID:</b> <code>${esc(order.uid)}</code>`,
    `<b>Server:</b> ${esc(order.server)}`,
    `<b>Telegram:</b> ${esc(order.telegram || 'Not provided')}`,
    `<b>UTR:</b> <code>${esc(order.utr || 'Not provided')}</code>`,
    `<b>Status:</b> ${esc(order.status)}`,
    `<b>Created:</b> ${esc(new Date(order.createdAt || Date.now()).toLocaleString('en-IN'))}`
  ].join('\n');
  const keyboard = {inline_keyboard:[[
    {text:'✅ ACCEPT',callback_data:`order:accept:${order.id}`},
    {text:'❌ REJECT',callback_data:`order:reject:${order.id}`}
  ],[
    {text:'🔄 PROCESSING',callback_data:`order:processing:${order.id}`},
    {text:'🏁 COMPLETED',callback_data:`order:completed:${order.id}`}
  ]]};

  if (order.proof) {
    const filePath = resolveProofPath(order.proof);
    if (filePath) {
      const sendWithToken = async (tok) => {
        const form = new FormData();
        form.append('chat_id', ADMIN_CHAT_ID);
        form.append('caption', text);
        form.append('parse_mode', 'HTML');
        form.append('reply_markup', JSON.stringify(keyboard));
        form.append('photo', new Blob([fs.readFileSync(filePath)]), path.basename(filePath));
        const r = await fetch(`https://api.telegram.org/bot${tok}/sendPhoto`, {method:'POST', body:form});
        return r.json();
      };
      try {
        let data = await sendWithToken(BOT_TOKEN);
        if (!data.ok && (data.error_code === 401 || BOT_TOKEN !== NOTIFY_BOT_TOKEN)) {
          data = await sendWithToken(NOTIFY_BOT_TOKEN);
        }
        if (data.ok) return;
        console.error('[Telegram] notifyAdmin sendPhoto failed:', data.description);
      } catch (err) {
        try {
          const retryData = await sendWithToken(NOTIFY_BOT_TOKEN);
          if (retryData.ok) return;
        } catch (_) {}
        console.error('[Telegram] notifyAdmin sendPhoto exception:', err.message);
      }
    }
  }
  try {
    await api('sendMessage', {chat_id:ADMIN_CHAT_ID, text, parse_mode:'HTML', reply_markup:keyboard});
  } catch (err) {
    console.error('[Telegram] notifyAdmin sendMessage failed:', err.message);
  }
}

async function answerCallback(id, text){
  try { await api('answerCallbackQuery',{callback_query_id:id,text,show_alert:false}); } catch {}
}

async function handleCallback(q){
  const parts = String(q.data || '').split(':');
  if (parts.length !== 3) return answerCallback(q.id,'Unknown action');

  // Credit Purchase Orders: credit:accept:REF or credit:reject:REF
  if (parts[0] === 'credit') {
    const action = parts[1];
    const orderRef = parts[2];
    const db = require('./db');
    const cloudStore = require('./cloudStore');
    try { await db.initDb(); } catch (_) {}

    let order = db.getCreditPurchaseOrderByRef(orderRef) || await cloudStore.getCreditPurchaseOrder(orderRef);
    if (!order) return answerCallback(q.id, 'Credit order not found: ' + orderRef);
    if (order.status && order.status !== 'pending') return answerCallback(q.id, 'Already ' + order.status);

    if (action === 'accept') {
      db.updateCreditPurchaseOrder(orderRef, { status: 'accepted', updated_at: new Date().toISOString() });
      await cloudStore.saveCreditPurchaseOrder(orderRef, { ...order, status: 'accepted' });
      db.updateUserCredits(order.user_id, order.credits, 'purchase', 'Credit purchase approved: ' + orderRef, order.utr);
      const newBal = await cloudStore.updateCredits(order.telegram_id, order.credits, 'purchase', 'Credit purchase approved: ' + orderRef, order.utr);

      try {
        await api('editMessageReplyMarkup', {
          chat_id: q.message.chat.id,
          message_id: q.message.message_id,
          reply_markup: JSON.stringify({
            inline_keyboard: [[ { text: `✅ ACCEPTED · +${order.credits} Credits Added`, callback_data: 'noop' } ]]
          })
        });
      } catch (_) {}

      // Notify User directly on Telegram
      if (order.telegram_id) {
        const userMsg = [
          '🎉 <b>CREDIT PURCHASE APPROVED!</b>', '',
          `Your payment for <b>+${order.credits} Credits</b> has been verified and added to your balance!`,
          `💳 <b>New Credits Balance:</b> ${newBal} Credits`,
          `<b>Order Ref:</b> <code>${esc(orderRef)}</code>`, '',
          'You can now use your credits to send Free Fire likes instantly: https://fflike.sbs/free-likes',
          'Thank you for your purchase! 🚀'
        ].join('\n');
        try {
          await api('sendMessage', { chat_id: order.telegram_id, text: userMsg, parse_mode: 'HTML' });
        } catch (e) {
          console.error('[Telegram] Failed to message user on accept:', e.message);
        }
      }
      return answerCallback(q.id, `✅ Added +${order.credits} credits to user!`);
    }

    if (action === 'reject') {
      db.updateCreditPurchaseOrder(orderRef, { status: 'rejected', updated_at: new Date().toISOString() });
      await cloudStore.saveCreditPurchaseOrder(orderRef, { ...order, status: 'rejected' });

      try {
        await api('editMessageReplyMarkup', {
          chat_id: q.message.chat.id,
          message_id: q.message.message_id,
          reply_markup: JSON.stringify({
            inline_keyboard: [[ { text: `❌ REJECTED · ${orderRef}`, callback_data: 'noop' } ]]
          })
        });
      } catch (_) {}

      // Notify User with warning on Telegram
      if (order.telegram_id) {
        const warnMsg = [
          '⚠️ <b>CREDIT PURCHASE REJECTED</b>', '',
          `Your credit purchase request (Ref: <code>${esc(orderRef)}</code>) for <b>${order.credits} Credits</b> was rejected by admin.`,
          '<b>Reason:</b> Payment UTR / screenshot could not be verified or was not received.', '',
          'If you have already paid or believe this is an error, please message support: @riyaznx'
        ].join('\n');
        try {
          await api('sendMessage', { chat_id: order.telegram_id, text: warnMsg, parse_mode: 'HTML' });
        } catch (e) {
          console.error('[Telegram] Failed to message user on reject:', e.message);
        }
      }
      return answerCallback(q.id, '❌ Order marked as rejected');
    }
  }

  // Standard like orders
  if (parts[0] === 'order') {
    const action = parts[1], orderId = parts[2];
    const map = {accept:'processing',reject:'rejected',processing:'processing',completed:'completed'};
    const status = map[action];
    if (!status) return answerCallback(q.id,'Invalid action');
    const orders=readOrders(); const idx=orders.findIndex(o=>o.id===orderId);
    if(idx<0) return answerCallback(q.id,'Order not found');
    orders[idx].status=status; orders[idx].updatedAt=new Date().toISOString(); writeOrders(orders);
    await answerCallback(q.id, status==='processing'?'Order accepted and moved to processing':status==='rejected'?'Order rejected':'Order marked completed');
    const updated=orders[idx];
    const statusLabel = {processing:'⚙️ PROCESSING',rejected:'❌ REJECTED',completed:'🏁 COMPLETED'}[status] || status;
    try {
      await api('editMessageReplyMarkup',{chat_id:q.message.chat.id,message_id:q.message.message_id,reply_markup:JSON.stringify({inline_keyboard:[[ {text:`${statusLabel} · ${orderId}`,callback_data:'noop'} ]]})});
    } catch {}
    try { await api('sendMessage',{chat_id:ADMIN_CHAT_ID,text:`<b>${statusLabel}</b>\nOrder <code>${esc(updated.id)}</code>\nUID <code>${esc(updated.uid)}</code> · ${esc(updated.server)}\nPlan: ${esc(updated.plan)}`,parse_mode:'HTML'}); } catch {}
  }
}

async function notifyCreditPurchaseOrder(order) {
  if (!BOT_TOKEN || !ADMIN_CHAT_ID) return;
  const esc = s => String(s ?? '').replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  const text = [
    '💳 <b>NEW CREDIT PURCHASE REQUEST</b>', '',
    `<b>Order Ref:</b> <code>${esc(order.order_ref)}</code>`,
    `<b>User:</b> ${esc(order.name || 'User')} ${order.username ? '(@' + esc(order.username) + ')' : ''}`,
    `<b>Telegram ID:</b> <code>${esc(order.telegram_id)}</code>`,
    `<b>Credits Requested:</b> <b>+${order.credits} CREDITS</b>`,
    `<b>Currency:</b> ${esc(order.currency)}`,
    `<b>Amount:</b> ${esc(order.amount)}`,
    `<b>${order.currency === 'INR' ? 'UTR Number' : 'Transaction ID'}:</b> <code>${esc(order.utr)}</code>`,
    `<b>Telegram Contact:</b> ${esc(order.telegram || 'Not provided')}`,
    `<b>Status:</b> ⏳ Pending Approval`,
    `<b>Time:</b> ${esc(new Date(order.created_at || Date.now()).toLocaleString('en-IN'))}`
  ].join('\n');

  const keyboard = {
    inline_keyboard: [
      [
        { text: '✅ ACCEPT / ADD CREDITS', callback_data: `credit:accept:${order.order_ref}` },
        { text: '❌ REJECT', callback_data: `credit:reject:${order.order_ref}` }
      ]
    ]
  };

  if (order.proof) {
    const filePath = resolveProofPath(order.proof);
    if (filePath) {
      const sendWithToken = async tok => {
        const form = new FormData();
        form.append('chat_id', ADMIN_CHAT_ID);
        form.append('caption', text);
        form.append('parse_mode', 'HTML');
        form.append('reply_markup', JSON.stringify(keyboard));
        form.append('photo', new Blob([fs.readFileSync(filePath)]), path.basename(filePath));
        const r = await fetch(`https://api.telegram.org/bot${tok}/sendPhoto`, { method: 'POST', body: form });
        return r.json();
      };
      try {
        let data = await sendWithToken(BOT_TOKEN);
        if (!data.ok && (data.error_code === 401 || BOT_TOKEN !== NOTIFY_BOT_TOKEN)) {
          data = await sendWithToken(NOTIFY_BOT_TOKEN);
        }
        if (data.ok) return;
      } catch (_) {}
    }
  }

  try {
    await api('sendMessage', { chat_id: ADMIN_CHAT_ID, text, parse_mode: 'HTML', reply_markup: keyboard });
  } catch (err) {
    console.error('[Telegram] notifyCreditPurchaseOrder failed:', err.message);
  }
}

const pendingAuthTokens = new Map();

function createPendingAuthToken(refCode = null) {
  const token = crypto.randomBytes(16).toString('hex');
  pendingAuthTokens.set(token, {
    createdAt: Date.now(),
    refCode,
    user: null
  });
  return token;
}

function getPendingAuthToken(token) {
  return pendingAuthTokens.get(token);
}

function setPendingAuthToken(token, data) {
  pendingAuthTokens.set(token, data);
}

function consumePendingAuthToken(token) {
  const entry = pendingAuthTokens.get(token);
  if (entry && entry.user) {
    pendingAuthTokens.delete(token);
    return entry.user;
  }
  return null;
}

setInterval(() => {
  const now = Date.now();
  for (const [k, v] of pendingAuthTokens.entries()) {
    if (now - v.createdAt > 10 * 60 * 1000) pendingAuthTokens.delete(k);
  }
}, 5 * 60 * 1000);

async function processTelegramUpdate(u) {
  if (!u) return;
  if (u.callback_query) {
    await handleCallback(u.callback_query);
    return;
  }
  const m = u.message;
  if (!m || !m.text) return;

  // Deep-link Telegram Auth: /start auth_<token>
  if (m.text.startsWith('/start auth_')) {
    const token = m.text.replace('/start auth_', '').trim();
    const entry = getPendingAuthToken(token);
    const from = m.from || m.chat;
    if (entry && from) {
      const telegramId = String(from.id);
      const name = [from.first_name, from.last_name].filter(Boolean).join(' ') || from.username || 'User';
      const username = from.username || null;
      const db = require('./db');
      await db.initDb();
      const user = db.upsertUser({
        telegram_id: telegramId,
        name,
        username,
        photo_url: null
      });
      if (entry.refCode) {
        try {
          const referrer = db.getUser(entry.refCode) || db.getUserById(entry.refCode);
          if (referrer && String(referrer.telegram_id) !== telegramId) {
            db.createReferral(referrer.id, user.id);
          }
        } catch (_) {}
      }
      entry.user = user;
      setPendingAuthToken(token, entry);
      await api('sendMessage', {
        chat_id: m.chat.id,
        text: `<b>✅ Connected to FFLike!</b>\n\nWelcome, <b>${esc(name)}</b>! Your Telegram account has been linked successfully.\n\n👉 Return to your browser window to claim your <b>Free Daily Likes</b>!`,
        parse_mode: 'HTML'
      });
      return;
    }
  }

  if (m.text.startsWith('/start')) {
    const from = m.from || m.chat;
    const telegramId = String(from.id);
    const name = [from.first_name, from.last_name].filter(Boolean).join(' ') || from.username || 'User';
    const username = from.username || null;
    let loginUrl = 'https://www.fflike.sbs/free-likes';
    try {
      const { signLoginToken } = require('./auth');
      const token = signLoginToken({ id: telegramId, name, username });
      loginUrl = `https://www.fflike.sbs/free-likes?token=${token}`;
    } catch (_) {}

    await api('sendMessage', {
      chat_id: m.chat.id,
      text: `<b>🎮 Welcome to FFLike Official Bot!</b>\n\n👤 <b>Account:</b> ${esc(name)}\n🆔 <b>Your Telegram ID:</b> <code>${telegramId}</code>\n\nTap below to login directly to FFLike and claim your <b>Free Daily Likes</b>! 👇`,
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: [
          [{ text: '🚀 Login to FFLike (Free Likes)', url: loginUrl }]
        ]
      }
    });
  } else if (m.text === '/orders') {
    const recent = readOrders().slice(0, 8);
    const text = recent.length ? recent.map(o => `<code>${esc(o.id)}</code> · ${esc(o.plan)} · ${esc(o.uid)} · ${esc(o.status)}`).join('\n') : 'No orders yet.';
    await api('sendMessage', { chat_id: m.chat.id, text: `<b>Recent orders</b>\n\n${text}`, parse_mode: 'HTML' });
  }
}

let offset=0, pollBackoff=2000, pollStopped=false;
async function poll(){
  if (pollStopped) return;
  try {
    const updates=await api('getUpdates',{timeout:25,offset,allowed_updates:['message','callback_query']});
    pollBackoff=2000;
    for(const u of updates){
      offset=u.update_id+1;
      await processTelegramUpdate(u);
    }
  } catch (e) {
    if (e.message && (e.message.includes('Unauthorized') || e.message.includes('401'))) {
      if (!pollStopped) {
        console.error('[Telegram] Bot token invalid/revoked — polling DISABLED. Update BOT_TOKEN in .env to re-enable.');
        pollStopped = true;
      }
      return;
    }
    pollBackoff = Math.min(pollBackoff * 2, 60000);
    console.error('[Telegram] poll error (retry in', Math.round(pollBackoff/1000), 's):', e.message);
    await new Promise(r=>setTimeout(r, pollBackoff));
  }
  if (!pollStopped) setImmediate(poll);
}

async function start(){
  if (process.env.VERCEL) {
    console.log('[Telegram] Running on Vercel Serverless — Telegram polling loop disabled.');
    return;
  }
  if (!BOT_TOKEN || !ADMIN_CHAT_ID) return;
  try {
    await api('sendMessage',{chat_id:ADMIN_CHAT_ID,text:'<b>FF Auto Like Bot connected ✓</b> (@fflike_sbsbot)\n\nPayment-proof notifications are active.',parse_mode:'HTML'});
    console.log('[Telegram] Startup test message sent.');
  } catch (e) {
    console.error('[Telegram] Startup test failed:', e.message);
  }
  try {
    const info = await api('getWebhookInfo', {});
    if (info && info.url) {
      console.log('[Telegram] Webhook is active on ' + info.url + ' — leaving webhook active.');
      return;
    }
    await api('deleteWebhook', { drop_pending_updates: false });
  } catch {}
  try { await api('setMyCommands',{commands:[{command:'start',description:'Show admin chat ID / setup'},{command:'orders',description:'Show recent orders'}]}); } catch {}
  console.log('[Telegram] Admin bot connected.');
  poll();
}

module.exports = {
  notifyAdmin,
  notifyAdminMessage,
  notifyGuildGloryOrder,
  notifyCreditPurchaseOrder,
  checkChannelMembership,
  processTelegramUpdate,
  createPendingAuthToken,
  getPendingAuthToken,
  consumePendingAuthToken
};
start();

async function checkChannelMembership(telegramId, channelUsername) {
  const channel = channelUsername.startsWith('@') ? channelUsername : `@${channelUsername}`;
  const tokensToTry = [
    NOTIFY_BOT_TOKEN,
    LOGIN_BOT_TOKEN,
    BOT_TOKEN,
    process.env.LOGIN_BOT_TOKEN
  ].filter(Boolean);

  for (const token of tokensToTry) {
    try {
      const url = `https://api.telegram.org/bot${token}/getChatMember?chat_id=${encodeURIComponent(channel)}&user_id=${encodeURIComponent(telegramId)}`;
      const r = await fetch(url);
      const data = await r.json();
      if (data.ok && data.result) {
        const status = data.result.status;
        if (['member', 'administrator', 'creator', 'restricted'].includes(status)) {
          return true;
        }
      }
    } catch (e) {
      console.error(`[Telegram] checkChannelMembership (${channel}) error:`, e.message);
    }
  }
  return false;
}

async function notifyGuildGloryOrder(order) {
  if (!BOT_TOKEN || !ADMIN_CHAT_ID) return;
  const esc2 = s => String(s ?? '').replace(/[&<>]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));
  const text = [
    '🏆 <b>NEW GUILD GLORY ORDER</b>', '',
    `<b>Ref:</b> <code>${esc2(order.order_ref)}</code>`,
    `<b>Package:</b> ${esc2(order.package_name)}`,
    `<b>Currency:</b> ${esc2(order.currency)}`,
    `<b>Amount:</b> ${esc2(order.amount)}`,
    `<b>Guild UID:</b> <code>${esc2(order.guild_uid || 'Not provided')}</code>`,
    `<b>Server/Region:</b> <code>${esc2(order.region || 'India (IND)')}</code>`,
    `<b>${order.currency === 'INR' ? 'UTR' : 'Txn/Order ID'}:</b> <code>${esc2(order.utr || 'Not provided')}</code>`,
    `<b>Telegram:</b> ${esc2(order.telegram || 'Not provided')}`,
    `<b>Status:</b> ${esc2(order.payment_status || 'pending')}`,
    `<b>Created:</b> ${esc2(new Date(order.created_at || Date.now()).toLocaleString('en-IN'))}`
  ].join('\n');

  if (order.proof) {
    const filePath = resolveProofPath(order.proof);
    if (filePath) {
      const sendWithToken = async (tok) => {
        const form = new FormData();
        form.append('chat_id', ADMIN_CHAT_ID);
        form.append('caption', text);
        form.append('parse_mode', 'HTML');
        form.append('photo', new Blob([fs.readFileSync(filePath)]), path.basename(filePath));
        const r = await fetch(`https://api.telegram.org/bot${tok}/sendPhoto`, {method:'POST', body:form});
        return r.json();
      };
      try {
        let data = await sendWithToken(BOT_TOKEN);
        if (!data.ok && (data.error_code === 401 || BOT_TOKEN !== NOTIFY_BOT_TOKEN)) {
          data = await sendWithToken(NOTIFY_BOT_TOKEN);
        }
        if (data.ok) return;
        console.error('[Telegram] notifyGuildGloryOrder sendPhoto failed:', data.description);
      } catch (err) {
        try {
          const retryData = await sendWithToken(NOTIFY_BOT_TOKEN);
          if (retryData.ok) return;
        } catch (_) {}
        console.error('[Telegram] notifyGuildGloryOrder photo send failed:', err.message);
      }
    }
  }

  try {
    await api('sendMessage', { chat_id: ADMIN_CHAT_ID, text, parse_mode: 'HTML' });
  } catch (e) {
    console.error('[Telegram] notifyGuildGloryOrder error:', e.message);
  }
}

async function notifyAdminMessage(text) {
  if (!BOT_TOKEN || !ADMIN_CHAT_ID) return;
  try {
    await api('sendMessage', { chat_id: ADMIN_CHAT_ID, text, parse_mode: 'HTML' });
  } catch (e) {
    console.error('[Telegram] notifyAdminMessage error:', e.message);
  }
}
