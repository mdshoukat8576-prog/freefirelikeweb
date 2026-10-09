(() => {
  const C = window.STORE_CONFIG;
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const merge = (base, extra) => {
    if (!extra) return base;
    base.brand = { ...base.brand, ...(extra.brand || {}) };
    base.contact = { ...base.contact, ...(extra.contact || {}) };
    base.payment = { ...base.payment, ...(extra.payment || {}) };
    return base;
  };
  const safeConfig = async () => {
    try {
      return await (await fetch('/api/config', { cache: 'no-store' })).json();
    } catch {
      return null;
    }
  };
  const esc = s => String(s ?? '').replace(/[&<>'"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[c]));

  function header() {
    const cleanPath = (location.pathname.replace(/^\/+/, '').split('/').pop() || 'index.html');
    const isHome = cleanPath === '' || cleanPath === 'index.html';
    const links = [
      ['/', 'Home', isHome],
      ['pricing.html', 'Plans', cleanPath === 'pricing.html'],
      ['how-it-works.html', 'How It Works', cleanPath === 'how-it-works.html'],
      ['faq.html', 'FAQ', cleanPath === 'faq.html'],
      ['order-status.html', 'Status', cleanPath === 'order-status.html'],
      ['contact.html', 'Support', cleanPath === 'contact.html']
    ];
    const linkHtml = links.map(([p, t, active]) => `<a class="${active ? 'active' : ''}" href="${p}">${t}</a>`).join('');
    return `<nav class="nav" aria-label="Main Navigation"><a class="brand" href="/" aria-label="FFLike Home"><img src="${C.brand.logo}" alt="${esc(C.brand.name)} logo" width="48" height="48"><span>${esc(C.brand.shortName)}</span></a><div class="navlinks">${linkHtml}</div><div class="nav-actions"><button class="icon-btn" id="themeBtn" aria-label="Toggle light or dark theme" type="button">◐</button><a class="primary nav-order" href="pricing.html">Buy Likes <span>↗</span></a><button class="icon-btn menu-btn" id="menuBtn" aria-label="Open menu" aria-expanded="false" type="button">☰</button></div></nav><div class="mobile-menu" id="mobileMenu" aria-hidden="true"><div class="mobile-menu-head"><span>MENU</span><button class="close" id="menuClose" aria-label="Close menu" type="button">×</button></div><div class="mobile-menu-links">${linkHtml}</div><a class="primary full mobile-buy" href="pricing.html">Buy Auto Likes <span>↗</span></a></div>`;
  }

  function footer() {
    return `<footer><div class="wrap footer-row"><div><div>© ${new Date().getFullYear()} ${esc(C.brand.name)} — FFLike</div><div class="footer-disclaimer" style="margin-top:6px;font-size:10px;opacity:.7">Disclaimer: FFLike is an independent service providing profile likes. Not affiliated with or endorsed by Garena.</div></div><div class="footer-links"><a href="/">Home</a><a href="pricing.html">Plans</a><a href="how-it-works.html">How It Works</a><a href="faq.html">FAQ</a><a href="order-status.html">Order Status</a><a href="about.html">About</a><a href="free-likes.html">Auto Likes</a><a href="contact.html">Support</a><a href="terms.html">Terms</a><a href="privacy.html">Privacy</a><a href="${C.contact.adminTelegramUrl}" target="_blank" rel="noopener">Telegram</a></div></div></footer>`;
  }

  function setupTheme() {
    const b = $('#themeBtn');
    if (!b) return;
    const saved = localStorage.getItem('store-theme');
    if (saved === 'light') document.body.classList.add('light');
    const paint = () => b.textContent = document.body.classList.contains('light') ? '☾' : '◐';
    paint();
    b.onclick = () => {
      document.body.classList.toggle('light');
      localStorage.setItem('store-theme', document.body.classList.contains('light') ? 'light' : 'dark');
      paint();
    };
    const menu = $('#mobileMenu'), open = $('#menuBtn'), close = $('#menuClose');
    if (menu && open && close) {
      const set = (v) => {
        menu.classList.toggle('open', v);
        menu.setAttribute('aria-hidden', String(!v));
        open.setAttribute('aria-expanded', String(v));
        document.body.classList.toggle('menu-open', v);
      };
      open.onclick = () => set(true);
      close.onclick = () => set(false);
      $$('.mobile-menu-links a,.mobile-buy', menu).forEach(a => a.addEventListener('click', () => set(false)));
      menu.addEventListener('click', e => {
        if (e.target === menu) set(false);
      });
    }
  }

  function mountChrome() {
    document.body.insertAdjacentHTML('afterbegin', header());
    document.body.insertAdjacentHTML('beforeend', footer());
    document.body.insertAdjacentHTML('beforeend', '<button class="scroll-top-btn" id="scrollTopBtn" aria-label="Scroll to top" title="Scroll to top">↑</button>');
    
    // Mobile Quick Action Bar with Circular Icons on EVERY page
    const curPath = location.pathname.split('/').pop() || 'index.html';
    const isPricing = curPath === 'pricing.html';
    const isStatus = curPath === 'order-status.html';
    
    document.body.insertAdjacentHTML('beforeend', `
      <div class="mobile-quick-bar" id="mobileQuickBar" role="navigation" aria-label="Quick Actions">
        <a class="primary quick-buy ${isPricing ? 'active-quick' : ''}" href="${isPricing ? '#plans' : 'pricing.html'}" aria-label="Buy Free Fire Auto Likes">
          <span class="quick-icon-circle" aria-hidden="true">
            <svg class="quick-svg" width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><path d="M13 2L3 14h7v8l10-12h-7l0-8z"/></svg>
          </span>
          <span class="quick-label">Buy Likes</span>
        </a>
        <a class="glass-btn quick-status ${isStatus ? 'active-quick' : ''}" href="${isStatus ? '#statusForm' : 'order-status.html'}" aria-label="Check Order Status">
          <span class="quick-icon-circle" aria-hidden="true">
            <svg class="quick-svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/></svg>
          </span>
          <span class="quick-label">Track Order</span>
        </a>
      </div>
    `);

    // In-page smooth scroll handlers
    const qb = $('#mobileQuickBar .quick-buy');
    if (qb && isPricing) {
      qb.onclick = (e) => {
        const p = $('#plans');
        if (p) {
          e.preventDefault();
          p.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }
      };
    }
    const qs = $('#mobileQuickBar .quick-status');
    if (qs && isStatus) {
      qs.onclick = (e) => {
        const inp = $('#statusId');
        if (inp) {
          e.preventDefault();
          inp.focus();
          inp.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
      };
    }

    setupTheme();
  }

  function reveal() {
    if (!('IntersectionObserver' in window)) {
      $$('.reveal').forEach(x => x.classList.add('visible'));
      return;
    }
    const obs = new IntersectionObserver(es => es.forEach(e => {
      if (e.isIntersecting) obs.unobserve(e.target) || e.target.classList.add('visible');
    }), { threshold: .08 });
    $$('.reveal').forEach(x => obs.observe(x));
  }

  function scrollBack() {
    let last = scrollY;
    const btn = $('#scrollTopBtn');
    addEventListener('scroll', () => {
      const y = scrollY;
      const isUp = y < last && y > 120;
      const isDown = y > last && y > 120;
      document.body.classList.toggle('scroll-up', isUp);
      document.body.classList.toggle('scroll-down', isDown);
      if (btn) {
        btn.classList.toggle('show', y > 350);
      }
      last = y;
    }, { passive: true });
    if (btn) {
      btn.onclick = () => window.scrollTo({ top: 0, behavior: 'smooth' });
    }
  }

  function tilt() {
    if (!matchMedia('(pointer:fine)').matches) return;
    $$('[data-tilt]').forEach(el => {
      el.addEventListener('pointerenter', () => {
        el.style.transition = 'transform .08s ease-out, box-shadow .3s ease';
      });
      el.addEventListener('pointermove', e => {
        const r = el.getBoundingClientRect(), x = (e.clientX - r.left) / r.width - .5, y = (e.clientY - r.top) / r.height - .5;
        el.style.transform = `perspective(1000px) rotateX(${(-y * 7).toFixed(2)}deg) rotateY(${(x * 8).toFixed(2)}deg) translateY(-6px)`;
      });
      el.addEventListener('pointerleave', () => {
        el.style.transition = 'transform .45s cubic-bezier(.2,.8,.2,1), box-shadow .45s ease';
        el.style.transform = '';
      });
    });
  }

  function toast(msg) {
    let t = $('#toast');
    if (!t) {
      document.body.insertAdjacentHTML('beforeend', '<div id="toast" role="status" aria-live="polite"></div>');
      t = $('#toast');
      t.className = 'toast';
    }
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(t._x);
    t._x = setTimeout(() => t.classList.remove('show'), 3400);
  }

  function servers() {
    return C.servers.map(s => `<span class="server"><span>${esc(s[0])}</span><b>${esc(s[1])}</b></span>`).join('');
  }

  function cards() {
    return C.plans.map((p, i) => `<article class="card reveal ${p.badge === 'Popular' ? 'featured' : ''}" data-tilt>${p.badge ? `<span class="badge">${esc(p.badge)}</span>` : ''}<div class="plan-top"><span class="plan-icon">${String(i + 1).padStart(2, '0')}</span><span class="plan-days">${p.days} ${p.days === 1 ? 'DAY' : 'DAYS'}</span></div><h3>${esc(p.name)}</h3><div class="price">₹${p.inr}<small> / plan</small></div><div class="sub">${p.likes.toLocaleString()} likes total · 200 daily</div><ul class="features"><li>200 likes every day</li><li>Manual QR payment</li><li>Payment proof upload</li><li>Telegram order support</li></ul><button class="primary full order-btn" data-plan="${esc(p.name)}" type="button" aria-label="Buy ${esc(p.name)} auto likes plan">Buy ${esc(p.name)} <span>↗</span></button></article>`).join('');
  }

  function paymentHtml(order) {
    const qr = C.payment.qrPath || 'assets/payment-qr.png';
    const tg = C.contact.adminTelegramUrl;
    const msg = encodeURIComponent(`Hello, I have paid for my Free Fire Auto Like order.\n\nOrder ID: ${order.id}\nPlan: ${order.plan}\nAmount: ₹${order.amount}\nUID: ${order.uid}\nServer: ${order.server}\nUTR: [ADD UTR]\n\nI will attach the payment screenshot here.`);
    return `<div class="payment-stage"><div class="payment-head"><div><span class="eyebrow"><i class="live-dot"></i> Payment</span><h3>Pay ₹${order.amount}</h3><p class="modal-price">${esc(order.plan)} · Order ${esc(order.id)}</p></div><button class="close" id="closePayment" aria-label="Close payment modal" type="button">×</button></div><div class="payment-grid"><div class="qr-box"><div class="qr-wrap"><img src="${qr}" alt="Payment QR Code for Order ${esc(order.id)}"></div><div class="pay-name">${esc(C.payment.accountName || 'Mohhamad Riyaz')}</div><div style="margin-top:10px"><a class="copy-btn qr-dl-btn" href="${qr}" download="FFLike-Payment-QR.png" target="_blank" rel="noopener" style="display:inline-block">Download QR ⤓</a></div></div><div><div class="amount-line"><span>Pay exactly</span><strong>₹${order.amount}</strong></div>${C.payment.upiId ? `<div class="upi-row"><span>UPI ID</span><button class="copy-btn" data-copy="${esc(C.payment.upiId)}" type="button">${esc(C.payment.upiId)} · Copy</button></div>` : ''}<ol class="pay-steps"><li>Scan the QR code or pay to the UPI ID.</li><li>Pay exactly ₹${order.amount}.</li><li>Enter your UTR / transaction reference number.</li><li>Upload the payment screenshot.</li></ol><form id="proofForm" class="form"><div class="field"><label for="utrInput">UTR / Transaction Reference</label><input id="utrInput" name="utr" required placeholder="Enter 12-digit UTR / reference" maxlength="64"></div><div class="field"><label for="proofInput">Payment Screenshot</label><input id="proofInput" name="proof" required type="file" accept="image/png,image/jpeg,image/webp"></div><button class="primary full" type="submit">Submit Payment Proof <span>↗</span></button></form></div></div><div class="order-note" style="margin-top:15px">After proof submission, open Telegram and send the order details with the same screenshot to the owner.</div><div class="payment-actions"><a class="primary" id="tgProof" href="${tg}?text=${msg}" target="_blank" rel="noopener">Open Telegram Support ↗</a><button class="glass-btn" id="copyOrder" data-copy="${esc(order.id)}" type="button">Copy Order ID</button></div></div>`;
  }

  function orderModal() {
    if ($('#orderModal')) return;
    document.body.insertAdjacentHTML('beforeend', `<div class="modal" id="orderModal" aria-hidden="true" role="dialog" aria-modal="true" aria-labelledby="modalTitle"><div class="sheet"><div class="modal-top"><div><span class="eyebrow"><i class="live-dot"></i> New order</span><h2 id="modalTitle">Create Order</h2><p id="modalPrice" class="modal-price"></p></div><button class="close" id="closeModal" aria-label="Close order dialog" type="button">×</button></div><form class="form" id="orderForm"><div class="field"><label for="uid">Free Fire UID</label><input id="uid" name="uid" required inputmode="numeric" placeholder="Enter your Free Fire UID (e.g. 123456789)"></div><div class="field"><label for="server">Free Fire Server</label><select id="server" name="server" required>${C.servers.map(s => `<option value="${esc(s[1])}">${esc(s[0])} ${esc(s[1])}</option>`).join('')}</select></div><div class="field"><label for="tg">Telegram Username (Optional)</label><input id="tg" name="tg" placeholder="@username (optional)"></div><div class="notice"><strong>Before paying:</strong> check your UID and server carefully. Your Order ID and exact payment amount will appear next.</div><button class="primary full" type="submit">Continue to Payment <span>→</span></button></form></div></div>`);
    const modal = $('#orderModal');
    let selected = null;
    const close = () => {
      modal.classList.remove('open');
      modal.setAttribute('aria-hidden', 'true');
      document.body.style.overflow = '';
    };
    $('#closeModal').onclick = close;
    modal.onclick = e => {
      if (e.target === modal) close();
    };
    $$('.order-btn').forEach(btn => btn.onclick = () => {
      selected = C.plans.find(p => p.name === btn.dataset.plan);
      $('#modalTitle').textContent = selected.name;
      $('#modalPrice').textContent = `₹${selected.inr} · ${selected.likes.toLocaleString()} total likes · 200 daily`;
      modal.classList.add('open');
      modal.setAttribute('aria-hidden', 'false');
      document.body.style.overflow = 'hidden';
    });
    $('#orderForm').onsubmit = async e => {
      e.preventDefault();
      const uid = $('#uid').value.trim(), server = $('#server').value, telegram = $('#tg').value.trim();
      if (!/^\d{5,15}$/.test(uid)) return toast('Please enter a valid Free Fire UID.');
      const btn = e.currentTarget.querySelector('button[type=submit]');
      btn.disabled = true;
      btn.innerHTML = 'Creating order <span class="spinner"></span>';
      try {
        const r = await fetch('/api/orders', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ plan: selected.name, uid, server, telegram })
        });
        const out = await r.json();
        if (!r.ok) throw new Error(out.error || 'Could not create order');
        close();
        openPayment(out.order);
      } catch (err) {
        toast(err.message);
      } finally {
        btn.disabled = false;
        btn.innerHTML = 'Continue to Payment <span>→</span>';
      }
    };
  }

  function bindCopy(root = document) {
    $$('[data-copy]', root).forEach(b => b.onclick = () => {
      const val = b.dataset.copy;
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(val).then(() => toast('Copied to clipboard')).catch(() => toast(val));
      } else {
        toast(val);
      }
    });
  }

  function openPayment(order) {
    document.body.insertAdjacentHTML('beforeend', `<div class="modal open" id="paymentModal" role="dialog" aria-modal="true" aria-label="Payment checkout"><div class="sheet">${paymentHtml(order)}</div></div>`);
    const modal = $('#paymentModal');
    document.body.style.overflow = 'hidden';
    $('#closePayment').onclick = () => {
      modal.remove();
      document.body.style.overflow = '';
    };
    modal.onclick = e => {
      if (e.target === modal) {
        modal.remove();
        document.body.style.overflow = '';
      }
    };
    bindCopy(modal);
    $('#proofForm').onsubmit = async e => {
      e.preventDefault();
      const form = e.currentTarget, fd = new FormData(form), submit = form.querySelector('button');
      submit.disabled = true;
      submit.innerHTML = 'Uploading proof <span class="spinner"></span>';
      try {
        const r = await fetch(`/api/orders/${encodeURIComponent(order.id)}/proof`, {
          method: 'POST',
          body: fd
        });
        const out = await r.json();
        if (!r.ok) throw new Error(out.error || 'Proof upload failed');
        order.utr = out.order.utr;
        const msg = encodeURIComponent(`Hello, I have paid for my Free Fire Auto Like order.\n\nOrder ID: ${order.id}\nPlan: ${order.plan}\nAmount: ₹${order.amount}\nUID: ${order.uid}\nServer: ${order.server}\nUTR: ${order.utr}\n\nPayment screenshot has been uploaded on the website. I am attaching the same screenshot here for verification.`);
        $('#tgProof').href = `${C.contact.adminTelegramUrl}?text=${msg}`;
        form.innerHTML = '<div class="success-box"><strong>Payment proof submitted ✓</strong><span>Your order is waiting for manual verification.</span><a class="primary full" id="tgAfterProof" href="' + C.contact.adminTelegramUrl + '?text=' + msg + '" target="_blank" rel="noopener">Send Order to Telegram ↗</a></div>';
        toast('Payment proof submitted — send the order to Telegram');
      } catch (err) {
        toast(err.message);
        submit.disabled = false;
        submit.innerHTML = 'Submit Payment Proof <span>↗</span>';
      }
    };
  }

  function initStatus(form) {
    form.onsubmit = async e => {
      e.preventDefault();
      const id = $('#statusId').value.trim(), box = $('#statusResult');
      box.innerHTML = '<div class="status-loading">Checking order…</div>';
      try {
        const r = await fetch(`/api/orders/${encodeURIComponent(id)}`), out = await r.json();
        if (!r.ok) throw new Error(out.error || 'Order not found');
        box.innerHTML = `<div class="status-card"><div><span class="eyebrow">Order ${esc(out.order.id)}</span><h3>${esc(out.order.plan)}</h3><p>UID ${esc(out.order.uid)} · ${esc(out.order.server)}</p></div><span class="status-pill ${esc(out.order.status)}">${esc(out.order.status.replace('_', ' '))}</span><div class="status-grid"><span>Amount<strong>₹${out.order.amount}</strong></span><span>Created<strong>${new Date(out.order.createdAt).toLocaleString()}</strong></span><span>UTR<strong>${esc(out.order.utr || 'Not submitted')}</strong></span></div></div>`;
      } catch (err) {
        box.innerHTML = `<div class="error-box">${esc(err.message)}</div>`;
      }
    };
  }

  function init() {
    const plans = $('#plans');
    if (plans) {
      plans.innerHTML = cards();
      orderModal();
    }
    const cloud = $('#serverCloud');
    if (cloud) cloud.innerHTML = servers();
    const owner = $('#ownerLink');
    if (owner) owner.href = C.contact.adminTelegramUrl;
    const community = $('#communityLink');
    if (community) community.href = C.contact.communityUrl;
    const form = $('#statusForm');
    if (form) initStatus(form);
    reveal();
    tilt();
  }

  async function boot() {
    merge(C, await safeConfig());
    document.documentElement.style.setProperty('--accent', C.theme.accent);
    mountChrome();
    init();
    scrollBack();
  }

  boot();
})();
