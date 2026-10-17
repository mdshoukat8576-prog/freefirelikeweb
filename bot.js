const fs = require('fs');
const path = require('path');

const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_CHAT_ID = String(process.env.ADMIN_CHAT_ID || '').trim();
const BOT_POLL_MS = Number(process.env.BOT_POLL_MS || 1000);
const ordersFile = path.join(__dirname, 'data', 'orders.json');
const proofDir = path.join(__dirname, 'data', 'proofs');

if (!BOT_TOKEN || !ADMIN_CHAT_ID) {
  console.warn('[Telegram] DISABLED: BOT_TOKEN or ADMIN_CHAT_ID is missing. Check .env in the same folder as server.js.');
} else {
  console.log(`[Telegram] Config loaded. Admin chat: ${ADMIN_CHAT_ID}`);
}

const api = (method, body) => fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, {
  method: 'POST',
  headers: {'content-type':'application/json'},
  body: JSON.stringify(body)
}).then(async r => {
  const data = await r.json();
  if (!data.ok) throw new Error(data.description || `Telegram ${method} failed`);
  return data.result;
});

function readOrders(){ try { return JSON.parse(fs.readFileSync(ordersFile,'utf8')); } catch { return []; } }
function writeOrders(list){ fs.writeFileSync(ordersFile, JSON.stringify(list, null, 2)); }
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
    `<b>Created:</b> ${esc(new Date(order.createdAt).toLocaleString('en-IN'))}`
  ].join('\n');
  const keyboard = {inline_keyboard:[[
    {text:'✅ ACCEPT',callback_data:`order:accept:${order.id}`},
    {text:'❌ REJECT',callback_data:`order:reject:${order.id}`}
  ],[
    {text:'🔄 PROCESSING',callback_data:`order:processing:${order.id}`},
    {text:'🏁 COMPLETED',callback_data:`order:completed:${order.id}`}
  ]]};

  if (order.proof) {
    const filePath = path.join(__dirname, order.proof.replace(/^\/?data[\\/]?/, 'data/'));
    if (fs.existsSync(filePath)) {
      const form = new FormData();
      form.append('chat_id', ADMIN_CHAT_ID);
      form.append('caption', text);
      form.append('parse_mode', 'HTML');
      form.append('reply_markup', JSON.stringify(keyboard));
      form.append('photo', new Blob([fs.readFileSync(filePath)]), path.basename(filePath));
      const r = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendPhoto`, {method:'POST', body:form});
      const data = await r.json();
      if (!data.ok) throw new Error(data.description || 'Could not send proof photo');
      return;
    }
  }
  await api('sendMessage',{chat_id:ADMIN_CHAT_ID,text,parse_mode:'HTML',reply_markup:keyboard});
}

async function answerCallback(id, text){
  try { await api('answerCallbackQuery',{callback_query_id:id,text,show_alert:false}); } catch {}
}

async function handleCallback(q){
  const parts = String(q.data || '').split(':');
  if (parts.length !== 3 || parts[0] !== 'order') return answerCallback(q.id,'Unknown action');
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

let offset=0, pollBackoff=2000, pollStopped=false;
async function poll(){
  if (pollStopped) return;
  try {
    const updates=await api('getUpdates',{timeout:25,offset,allowed_updates:['message','callback_query']});
    pollBackoff=2000; // reset on success
    for(const u of updates){
      offset=u.update_id+1;
      if(u.callback_query){ await handleCallback(u.callback_query); continue; }
      const m=u.message;
      if(!m || !m.text) continue;
      if(m.text.startsWith('/start')) {
        await api('sendMessage',{chat_id:m.chat.id,text:`<b>FF Auto Like Admin Bot</b>\n\nYour chat ID is:\n<code>${m.chat.id}</code>\n\nUse this chat ID as <code>ADMIN_CHAT_ID</code> in your website .env.`,parse_mode:'HTML'});
      } else if(m.text === '/orders') {
        const recent=readOrders().slice(0,8);
        const text=recent.length?recent.map(o=>`<code>${esc(o.id)}</code> · ${esc(o.plan)} · ${esc(o.uid)} · ${esc(o.status)}`).join('\n'):'No orders yet.';
        await api('sendMessage',{chat_id:m.chat.id,text:`<b>Recent orders</b>\n\n${text}`,parse_mode:'HTML'});
      }
    }
  } catch (e) {
    // If Unauthorized, bot token is revoked/invalid — stop polling, don't spam logs
    if (e.message && (e.message.includes('Unauthorized') || e.message.includes('401'))) {
      if (!pollStopped) {
        console.error('[Telegram] Bot token invalid/revoked — polling DISABLED. Update BOT_TOKEN in .env to re-enable.');
        pollStopped = true;
      }
      return;
    }
    pollBackoff = Math.min(pollBackoff * 2, 60000); // exponential backoff up to 60s
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
  // Send a one-time startup message so configuration problems are obvious.
  try {
    await api('sendMessage',{chat_id:ADMIN_CHAT_ID,text:'<b>FF Auto Like Bot connected ✓</b>\n\nPayment-proof notifications are active.',parse_mode:'HTML'});
    console.log('[Telegram] Startup test message sent.');
  } catch (e) {
    console.error('[Telegram] Startup test failed:', e.message);
  }
  try { await api('deleteWebhook',{drop_pending_updates:false}); } catch {}
  try { await api('setMyCommands',{commands:[{command:'start',description:'Show admin chat ID / setup'},{command:'orders',description:'Show recent orders'}]}); } catch {}
  console.log('[Telegram] Admin bot connected.');
  poll();
}

module.exports = { notifyAdmin, notifyGuildGloryOrder, checkChannelMembership };
start();

async function checkChannelMembership(telegramId, channelUsername) {
  if (!BOT_TOKEN) return false;
  try {
    const channel = channelUsername.startsWith('@') ? channelUsername : `@${channelUsername}`;
    const r = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/getChatMember?chat_id=${encodeURIComponent(channel)}&user_id=${encodeURIComponent(telegramId)}`);
    const data = await r.json();
    if (!data.ok) return false;
    const status = data.result && data.result.status;
    return ['member', 'administrator', 'creator'].includes(status);
  } catch (e) {
    console.error('[Telegram] checkChannelMembership error:', e.message);
    return false;
  }
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
    `<b>${order.currency === 'INR' ? 'UTR' : 'Txn/Order ID'}:</b> <code>${esc2(order.utr || 'Not provided')}</code>`,
    `<b>Telegram:</b> ${esc2(order.telegram || 'Not provided')}`,
    `<b>Status:</b> ${esc2(order.payment_status || 'pending')}`,
    `<b>Created:</b> ${esc2(new Date(order.created_at || Date.now()).toLocaleString('en-IN'))}`
  ].join('\n');

  if (order.proof) {
    const filePath = path.join(__dirname, order.proof.replace(/^\/?data[\\/]?/, 'data/'));
    if (fs.existsSync(filePath)) {
      try {
        const form = new FormData();
        form.append('chat_id', ADMIN_CHAT_ID);
        form.append('caption', text);
        form.append('parse_mode', 'HTML');
        form.append('photo', new Blob([fs.readFileSync(filePath)]), path.basename(filePath));
        const r = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendPhoto`, {method:'POST', body:form});
        const data = await r.json();
        if (data.ok) return;
      } catch (err) {
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
