// ─────────────────────────────────────────────────────────────
//  ui.js  —  Presentation layer for Alethea
//  Imports all logic from core.js
//  Manages DOM, navigation, rendering, event listeners
//  Includes PIN setup and unlock flows
// ─────────────────────────────────────────────────────────────

import {
  auth, database, onAuthStateChanged,
  signInWithEmailAndPassword, createUserWithEmailAndPassword, signOut, updateProfile,
  ref, get, set, update, push, remove, onValue,
  getUserWalletAddress,
  generateECDSAKeyPair, deriveWalletAddress, importPrivateKey, signMessage,
  encryptPrivateKey, decryptPrivateKey,
  getLiquidBalance, getChunkData, getTotalBalance, loadJarNodeAddresses, getUserPreferences,
  createRealtimeListeners
} from "./core.js";

// ---------- UI State ----------
let currentUser = null;
let currentWalletAddress = null;
let userCryptoKey = null;
let jarNodesEnabled = false;
let jarDistributionMode = 'manual';
let allJarNodeAddresses = [];
let _lastKnownLiquid = null;
let _isSendingTx = false;
let _unsubscribeRealtime = null;

// Market simulation
let volume = 124.5, marketCap = 2.84, priceHistory = [], currentPrice = 0.0845;
let chartCtx = null, chartCanvas = null, marketInterval = null;

// Validator
let _validatorUser = null;
let _pendingUnsub = null;

// ---------- Helpers ----------
function toast(msg, isError = false) {
  const el = document.getElementById('toastMsg');
  if (!el) return;
  el.textContent = msg;
  el.style.background = isError ? 'rgba(224,85,85,0.15)' : 'rgba(200,255,0,0.08)';
  el.style.borderLeft = `3px solid ${isError ? '#e05555' : '#c8ff00'}`;
  el.style.display = 'block';
  clearTimeout(el._t);
  el._t = setTimeout(() => el.style.display = 'none', 6000);
}

function _setText(id, val) {
  const el = document.getElementById(id);
  if (el) el.textContent = val;
}

function showAuthError(msg) {
  const el = document.getElementById('auth-error');
  if (!el) return;
  el.textContent = msg;
  el.style.display = 'block';
  setTimeout(() => el.style.display = 'none', 6000);
}

function clearAuthError() {
  const el = document.getElementById('auth-error');
  if (el) el.style.display = 'none';
}

function setAuthLoading(loading) {
  const signinBtn = document.getElementById('signin-btn');
  const signupBtn = document.getElementById('signup-btn');
  const tabBtns = document.querySelectorAll('.auth-tab');
  [signinBtn, signupBtn, ...tabBtns].forEach(b => { if (b) b.disabled = loading; });
  const isSignup = document.querySelector('.auth-tab.active')?.dataset.tab === 'signup';
  const btn = isSignup ? signupBtn : signinBtn;
  if (!btn) return;
  btn.querySelector('.btn-text').style.display = loading ? 'none' : 'inline';
  btn.querySelector('.btn-loading').style.display = loading ? 'inline' : 'none';
}

function setLoading(btnId, loading) {
  const btn = document.getElementById(btnId);
  if (!btn) return;
  btn.disabled = loading;
  btn.querySelector('.btn-text').style.display = loading ? 'none' : 'inline';
  btn.querySelector('.btn-loading').style.display = loading ? 'inline' : 'none';
}

// ---------- PIN Modal (Promise‑based) ----------
// ---------- PIN Modal (Promise‑based, dynamically created) ----------
function ensurePinModalExists() {
  if (document.getElementById('pin-modal-overlay')) return;
  const overlay = document.createElement('div');
  overlay.id = 'pin-modal-overlay';
  overlay.innerHTML = `
    <div class="pin-modal-card">
      <div id="pin-modal-title">Enter PIN</div>
      <input type="password" id="pin-input" maxlength="6" inputmode="numeric" pattern="\\d*" placeholder="······" />
      <div id="pin-error" style="display:none"></div>
      <div class="pin-actions">
        <button id="pin-cancel">Cancel</button>
        <button id="pin-submit">Unlock</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);
}

function promptForPin(titleText = 'Enter PIN') {
  ensurePinModalExists(); // ← creates modal once

  return new Promise((resolve) => {
    const overlay = document.getElementById('pin-modal-overlay');
    const titleEl = document.getElementById('pin-modal-title');
    const inputEl = document.getElementById('pin-input');
    const errorEl = document.getElementById('pin-error');
    const submitBtn = document.getElementById('pin-submit');
    const cancelBtn = document.getElementById('pin-cancel');

    titleEl.textContent = titleText;
    inputEl.value = '';
    errorEl.style.display = 'none';
    overlay.classList.add('open');
    inputEl.focus();

    const cleanup = () => {
      overlay.classList.remove('open');
      submitBtn.removeEventListener('click', onSubmit);
      cancelBtn.removeEventListener('click', onCancel);
      inputEl.removeEventListener('keypress', onKeyPress);
    };

    const onSubmit = () => {
      const pin = inputEl.value.trim();
      if (!/^\d{6}$/.test(pin)) {
        errorEl.textContent = 'PIN must be exactly 6 digits.';
        errorEl.style.display = 'block';
        return;
      }
      cleanup();
      resolve(pin);
    };

    const onCancel = () => {
      cleanup();
      resolve(null);
    };

    const onKeyPress = (e) => {
      if (e.key === 'Enter') onSubmit();
      if (e.key === 'Escape') onCancel();
    };

    submitBtn.addEventListener('click', onSubmit);
    cancelBtn.addEventListener('click', onCancel);
    inputEl.addEventListener('keypress', onKeyPress);
  });
}

// ---------- Confirmation Modal (Promise‑based, dynamically created) ----------
function ensureConfirmModalExists() {
  if (document.getElementById('confirm-modal-overlay')) return;
  const overlay = document.createElement('div');
  overlay.id = 'confirm-modal-overlay';
  overlay.className = 'qr-overlay'; // reuse existing overlay class for positioning
  overlay.innerHTML = `
    <div class="confirm-modal-card">
      <div id="confirm-modal-message">Are you sure?</div>
      <div class="confirm-actions">
        <button id="confirm-cancel">Cancel</button>
        <button id="confirm-ok">OK</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);
}

function showConfirmDialog(message) {
  ensureConfirmModalExists();
  return new Promise((resolve) => {
    const overlay = document.getElementById('confirm-modal-overlay');
    const messageEl = document.getElementById('confirm-modal-message');
    const okBtn = document.getElementById('confirm-ok');
    const cancelBtn = document.getElementById('confirm-cancel');

    messageEl.textContent = message;
    overlay.classList.add('open');

    const cleanup = (result) => {
      overlay.classList.remove('open');
      okBtn.removeEventListener('click', onOk);
      cancelBtn.removeEventListener('click', onCancel);
      resolve(result);
    };

    const onOk = () => cleanup(true);
    const onCancel = () => cleanup(false);

    okBtn.addEventListener('click', onOk);
    cancelBtn.addEventListener('click', onCancel);

    // Close on overlay click (backdrop)
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) cleanup(false);
    }, { once: true });

    // Optional: Escape key cancels
    const onKey = (e) => {
      if (e.key === 'Escape') cleanup(false);
    };
    window.addEventListener('keydown', onKey, { once: true });
  });
}

// ---------- Navigation ----------
const PAGES = {
  wallet:       { title: 'Wallet',       sub: 'Your ALE balance and activity' },
  transactions: { title: 'Transactions', sub: 'Pending and confirmed activity' },
  blockchain:   { title: 'Blockchain',   sub: 'Immutable ledger of all mined blocks' },
  jarnodes:     { title: 'Jar Nodes',    sub: 'Distributed chunk storage across the network' },
  validator:    { title: 'Validator',    sub: 'Review · Approve · Mine' },
  market:       { title: 'Market',       sub: 'ALETHEA / ETH · simulated price feed' },
};

function navigateTo(page) {
  document.querySelectorAll('.nav-item').forEach(el => el.classList.toggle('active', el.dataset.page === page));
  document.querySelectorAll('.page').forEach(el => el.classList.toggle('active', el.id === `page-${page}`));
  const cfg = PAGES[page] || {};
  _setText('topbar-title', cfg.title || page);
  _setText('topbar-subtitle', cfg.sub || '');
  if (page === 'blockchain') loadBlockchainPage();
  if (page === 'jarnodes') loadJarPage();
  if (page === 'validator') initValidatorPanel();
  if (page === 'market') setTimeout(drawChart, 20);
  closeSidebar();
}

function openSidebar() {
  document.getElementById('sidebar')?.classList.add('open');
  document.getElementById('sidebar-overlay')?.classList.add('open');
}
function closeSidebar() {
  document.getElementById('sidebar')?.classList.remove('open');
  document.getElementById('sidebar-overlay')?.classList.remove('open');
}

// ---------- Wallet & Balance ----------
async function updateWalletDisplay() {
  if (!currentWalletAddress) return;
  const { liquid, stored, total } = await getTotalBalance(currentWalletAddress, allJarNodeAddresses);
  _setText('walletBalance', total.toFixed(4));
  const bdEl = document.getElementById('balanceBreakdown');
  if (bdEl) bdEl.textContent = stored > 0
    ? `${liquid.toFixed(4)} liquid  ·  ${stored.toFixed(4)} in jars`
    : `${liquid.toFixed(4)} liquid`;
  _setText('stat-liquid', liquid.toFixed(4));
  _setText('stat-stored', stored.toFixed(4));
  const short = currentWalletAddress.slice(0,6) + '…' + currentWalletAddress.slice(-4);
  _setText('walletAddressShort', short);
  _setText('topbar-addr-text', short);

  const pendingSnap = await get(ref(database, 'blockchain/pending_transactions'));
  const pendingCount = pendingSnap.exists()
    ? Object.values(pendingSnap.val()).filter(t => !t.rejected && !t.claimed &&
        (t.sender === currentWalletAddress || t.receiver === currentWalletAddress)).length
    : 0;
  _setText('stat-pending', String(pendingCount));

  const blocksSnap = await get(ref(database, 'blockchain/blocks'));
  const height = blocksSnap.exists() ? Object.keys(blocksSnap.val()).length : 0;
  _setText('stat-blocks', String(height));
}

async function loadTransactionHistory() {
  const container = document.getElementById('txHistoryList');
  if (!container || !currentWalletAddress) return;
  const [pendingSnap, blocksSnap] = await Promise.all([
    get(ref(database, 'blockchain/pending_transactions')),
    get(ref(database, 'blockchain/blocks'))
  ]);
  const allTxs = [];
  if (pendingSnap.exists()) {
    for (const [id, tx] of Object.entries(pendingSnap.val())) {
      if (tx.sender === currentWalletAddress || tx.receiver === currentWalletAddress) {
        allTxs.push({ ...tx, status: tx.approved ? 'approved · mining' : 'pending', id });
      }
    }
  }
  if (blocksSnap.exists()) {
    for (const block of Object.values(blocksSnap.val())) {
      for (const tx of block.transactions || []) {
        if (tx.sender === currentWalletAddress || tx.receiver === currentWalletAddress) {
          allTxs.push({ ...tx, status: `confirmed · block ${block.index}` });
        }
      }
    }
  }
  allTxs.sort((a, b) => b.timestamp - a.timestamp);
  if (allTxs.length === 0) {
    container.innerHTML = '<div class="empty-state"><p>No transactions yet.</p></div>';
    return;
  }
  container.innerHTML = allTxs.slice(0, 20).map(tx => {
    const out = tx.sender === currentWalletAddress;
    const peer = out ? tx.receiver : tx.sender;
    const sign = out ? '−' : '+';
    const cls = out ? 'out' : 'in';
    return `<div class="tx-row">
      <div class="tx-sign ${cls}">${sign}</div>
      <div class="tx-body"><div class="tx-line-1">${out ? 'to' : 'from'} ${peer.slice(0,14)}…</div>
      <div class="tx-line-2">${new Date(tx.timestamp).toLocaleString()} · <span style="color:var(--text-dim)">${tx.status}</span></div></div>
      <div><div class="tx-amount ${cls}">${sign} ${Number(tx.amount).toFixed(4)} ALE</div></div>
    </div>`;
  }).join('');
}

// ---------- Send Transaction ----------
async function handleSend() {
  const receiver = document.getElementById('sendTo')?.value.trim() ?? '';
  const amount = parseFloat(document.getElementById('sendAmount')?.value ?? '0');
  const btn = document.getElementById('sendBtn');
  if (!receiver || !amount) return;

  if (receiver === currentWalletAddress) {
    toast('Cannot send ALE to your own wallet.', true); return;
  }
  if (!/^0x[a-fA-F0-9]{64}$/.test(receiver)) {
    toast('Invalid address — must be 0x + 64 hex characters.', true); return;
  }
  if (isNaN(amount) || amount <= 0) {
    toast('Amount must be a positive number.', true); return;
  }
  const amt = parseFloat(amount.toFixed(6));

  const rxSnap = await get(ref(database, `wallets/${receiver}`));
  if (!rxSnap.exists()) {
    toast('Recipient wallet not found on the network.', true); return;
  }

  const liquid = await getLiquidBalance(currentWalletAddress);
  if (amt > liquid) {
    const { stored } = await getTotalBalance(currentWalletAddress, allJarNodeAddresses);
    toast(`Insufficient liquid (${liquid.toFixed(4)} ALE)${stored > 0 ? ` · ${stored.toFixed(4)} in jars — reclaim first` : ''}.`, true);
    return;
  }

  const timestamp = Date.now();
  const tx = { sender: currentWalletAddress, receiver, amount: amt, timestamp, approved: false };
  tx.signature = await signMessage(userCryptoKey, `${tx.sender}:${tx.receiver}:${tx.amount}:${tx.timestamp}`);

  _isSendingTx = true;
  if (btn) { btn.querySelector('.btn-text').style.display = 'none'; btn.querySelector('.btn-loading').style.display = 'inline'; btn.disabled = true; }
  const txRef = push(ref(database, 'blockchain/pending_transactions'));
  await set(txRef, tx);
  setTimeout(() => { _isSendingTx = false; }, 4000);
  if (btn) { btn.querySelector('.btn-text').style.display = 'inline'; btn.querySelector('.btn-loading').style.display = 'none'; btn.disabled = false; }
  toast(`${amt.toFixed(4)} ALE submitted — awaiting validator approval.`);
  document.getElementById('sendTo').value = '';
  document.getElementById('sendAmount').value = '';
}

// ---------- Blockchain Page ----------
async function loadBlockchainPage() {
  const container = document.getElementById('blockListContainer');
  if (!container) return;
  try {
    const resp = await fetch('https://alethea-miner-1.onrender.com/supply');
    if (resp.ok) {
      const data = await resp.json();
      _setText('bc-height', String(data.block_height ?? '—'));
      _setText('bc-minted', data.total_minted != null ? Number(data.total_minted).toFixed(0) : '—');
      _setText('bc-remaining', data.remaining != null ? Number(data.remaining).toFixed(0) : '—');
      _setText('bc-reward', String(data.next_reward ?? '—'));
    }
  } catch {}
  const snap = await get(ref(database, 'blockchain/blocks'));
  if (!snap.exists()) {
    container.innerHTML = '<div class="empty-state"><p>No blocks mined yet.</p></div>';
    return;
  }
  const blocks = Object.values(snap.val()).sort((a, b) => b.index - a.index);
  _setText('bc-height', String(blocks[0]?.index ?? '—'));
  container.innerHTML = `<table class="block-table"><thead><tr><th>#</th><th>Hash</th><th>Txs</th><th>Nonce</th><th>Time</th></tr></thead><tbody>
    ${blocks.map(b => `<tr><td class="block-index">${b.index}</td><td class="block-hash">${b.hash ? b.hash.slice(0,20)+'…' : '—'}</td><td>${(b.transactions || []).length}</td><td style="color:var(--text-3)">${b.nonce ?? '—'}</td><td class="block-time">${new Date((b.timestamp || 0)*1000).toLocaleTimeString()}</td></tr>`).join('')}
  </tbody></table>`;
}

// ---------- Jar Nodes Page ----------
async function loadJarPage() {
  allJarNodeAddresses = await loadJarNodeAddresses();
  const prefs = await getUserPreferences(currentUser.uid);
  jarNodesEnabled = prefs.jarNodesEnabled ?? false;
  jarDistributionMode = prefs.jarDistributionMode ?? 'manual';

  const grid = document.getElementById('jarNodeGrid');
  const actions = document.getElementById('jar-action-card');
  if (!jarNodesEnabled) {
    if (grid) grid.innerHTML = '<div class="empty-state"><p>Jar nodes not enabled. Enable during wallet setup.</p></div>';
    if (actions) actions.style.display = 'none';
  } else {
    if (actions) actions.style.display = 'block';
    await _renderOwnNode(grid);
  }
  await _renderPeerGrid();
}

async function _renderOwnNode(grid) {
  const ownSnap = await get(ref(database, `jarnodes/${currentWalletAddress}`));
  const { total: stored, chunks } = await getChunkData(currentWalletAddress, allJarNodeAddresses);
  let hostedCount = 0;
  if (ownSnap.exists()) {
    const chSnap = await get(ref(database, `jarnodes/${currentWalletAddress}/chunks`));
    if (chSnap.exists()) {
      hostedCount = Object.values(chSnap.val()).reduce((acc, byDep) => acc + Object.keys(byDep).length, 0);
    }
  }
  const chunksHtml = chunks.length ? chunks.map(c => `<div class="node-row" style="padding-left:0.6rem"><span>↳ ${c.nodeAddr.slice(0,14)}…</span><span>${c.amount.toFixed(4)} ALE</span></div>`).join('') : '';
  if (grid) grid.innerHTML = `<div class="node-card">
    <div class="node-card-title">Your Jar Node</div>
    <div class="node-row"><span>address</span><span>${currentWalletAddress.slice(0,14)}…</span></div>
    <div class="node-row"><span>status</span><span class="${ownSnap.exists() ? 'active' : ''}">${ownSnap.exists() ? 'active' : 'not registered'}</span></div>
    <div class="node-row"><span>mode</span><span>${jarDistributionMode}</span></div>
    <div class="node-row"><span>hosting</span><span>${hostedCount} chunk(s) for others</span></div>
    <div class="node-row"><span>stored out</span><span>${chunks.length} chunk(s) · ${stored.toFixed(4)} ALE</span></div>
    ${chunksHtml}
  </div>`;
}

async function _renderPeerGrid() {
  const container = document.getElementById('peerGrid');
  const countEl = document.getElementById('peer-count');
  if (!container) return;
  const others = allJarNodeAddresses.filter(a => a !== currentWalletAddress);
  if (countEl) countEl.textContent = `${others.length} active`;
  if (others.length === 0) {
    container.innerHTML = '<div class="empty-state"><p>No other jar nodes on the network.</p></div>';
    return;
  }
  container.innerHTML = `<div class="peer-grid">${others.map(addr => `<div class="peer-card"><div class="peer-addr"><span class="peer-dot"></span>${addr.slice(0,16)}…</div></div>`).join('')}</div>`;
}

function shuffled(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

async function distributeToJarNodes() {
  if (!jarNodesEnabled) { toast('Jar nodes not enabled.', true); return; }
  allJarNodeAddresses = await loadJarNodeAddresses();
  const others = allJarNodeAddresses.filter(a => a !== currentWalletAddress);
  const liquid = await getLiquidBalance(currentWalletAddress);
  if (liquid < 0.0001) { toast('No liquid balance to distribute.', true); return; }
  if (others.length === 0) { toast('No other jar nodes on the network.', true); return; }
  const chunkSize = parseFloat((liquid * 0.25).toFixed(6));
  const chunksWanted = Math.floor(liquid / chunkSize);
  if (others.length < chunksWanted) {
    toast(`Not enough jar nodes (${others.length} available, ${chunksWanted} needed).`, true);
    return;
  }
  const selected = shuffled(others).slice(0, chunksWanted);
  const total = parseFloat((chunkSize * chunksWanted).toFixed(6));
  const writes = [];
  for (const node of selected) {
    const ts = Date.now();
    const sig = await signMessage(userCryptoKey, `${currentWalletAddress}:${node}:${chunkSize}:${ts}`);
    const cr = push(ref(database, `jarnodes/${node}/chunks/${currentWalletAddress}`));
    writes.push({ ref: cr, data: { depositor: currentWalletAddress, amount: chunkSize, signature: sig, timestamp: new Date(ts).toISOString() } });
  }
  await Promise.all(writes.map(w => set(w.ref, w.data)));
  await update(ref(database, `wallets/${currentWalletAddress}`), { balance: parseFloat((liquid - total).toFixed(6)) });
  toast(`Stored ${total.toFixed(4)} ALE across ${selected.length} jar node(s).`);
  await updateWalletDisplay();
  await loadJarPage();
}

async function autoReclaimAll() {
  if (!jarNodesEnabled) { toast('Jar nodes not enabled.', true); return; }
  allJarNodeAddresses = await loadJarNodeAddresses();
  const { total: stored, chunks } = await getChunkData(currentWalletAddress, allJarNodeAddresses);
  if (chunks.length === 0) { toast('No chunks to reclaim.', false); return; }
  const liquid = await getLiquidBalance(currentWalletAddress);
  const newLiquid = parseFloat((liquid + stored).toFixed(6));
  await update(ref(database, `wallets/${currentWalletAddress}`), { balance: newLiquid });
  await Promise.all(chunks.map(c => remove(c.ref)));
  toast(`Reclaimed ${stored.toFixed(4)} ALE from ${chunks.length} chunk(s).`);
  await updateWalletDisplay();
  await loadJarPage();
}

// ---------- Validator ----------
async function initValidatorPanel() {
  _validatorUser = currentUser;
  if (!_validatorUser) return;
  const snap = await get(ref(database, `users/${_validatorUser.uid}`));
  const isValidator = snap.exists() && snap.val().isValidator === true;
  const gateEl = document.getElementById('gateScreen');
  const dashEl = document.getElementById('dashScreen');
  if (!gateEl || !dashEl) return;
  if (isValidator) {
    gateEl.style.display = 'none';
    dashEl.style.display = 'block';
    _startPendingListener();
  } else {
    gateEl.style.display = 'block';
    dashEl.style.display = 'none';
  }
  // Wake up the miner
fetch('https://alethea-miner-1.onrender.com/health', { method: 'GET' })
  .catch(() => { /* ignore – just pinging */ });
}

function _startPendingListener() {
  if (_pendingUnsub) _pendingUnsub();
  _pendingUnsub = onValue(ref(database, 'blockchain/pending_transactions'), _renderPending);
}

function _renderPending(snap) {
  const container = document.getElementById('pendingList');
  const countEl = document.getElementById('pending-count');
  if (!container) return;
  const val = snap.val();
  const open = val ? Object.entries(val).filter(([,tx]) => !tx.approved && !tx.claimed && !tx.rejected) : [];
  if (countEl) countEl.textContent = `${open.length} waiting`;
  if (open.length === 0) {
    container.innerHTML = '<div class="empty-state"><p>No transactions awaiting approval.</p></div>';
    return;
  }
  container.innerHTML = open.map(([txId, tx]) => `
    <div class="vtx-row" id="vtx-${txId}">
      <div><span class="vtx-label">from</span> <span class="vtx-value">${tx.sender.slice(0,18)}…</span></div>
      <div><span class="vtx-label">to</span>   <span class="vtx-value">${tx.receiver.slice(0,18)}…</span></div>
      <div><span class="vtx-label">amount</span> <span class="vtx-amount">${Number(tx.amount).toFixed(4)} ALE</span></div>
      <div><span class="vtx-label">time</span> <span style="font-size:0.65rem;color:var(--text-3)">${new Date(tx.timestamp).toLocaleString()}</span></div>
      <div class="vtx-actions"><button class="btn-primary" style="height:34px;font-size:0.65rem" data-txid="${txId}" data-sender="${tx.sender}" data-amount="${tx.amount}">Approve &amp; Mine</button></div>
      <div class="vtx-warn" id="vwarn-${txId}"></div>
      <div class="vtx-ok" id="vok-${txId}"></div>
    </div>`).join('');
  container.querySelectorAll('.btn-primary[data-txid]').forEach(btn => btn.addEventListener('click', () => _approveTx(btn)));
}

async function _approveTx(btn) {
  const txId = btn.dataset.txid;
  const sender = btn.dataset.sender;
  const amount = parseFloat(btn.dataset.amount);
  const warnEl = document.getElementById(`vwarn-${txId}`);
  const okEl = document.getElementById(`vok-${txId}`);
  btn.disabled = true;
  btn.textContent = 'Checking…';
  const sSnap = await get(ref(database, `wallets/${sender}`));
  const sLiquid = sSnap.exists() ? (sSnap.val().balance || 0) : 0;
  if (sLiquid < amount) {
    if (warnEl) warnEl.textContent = `⚠ Sender balance insufficient (${sLiquid.toFixed(4)} ALE). Rejected.`;
    await set(ref(database, `blockchain/pending_transactions/${txId}/rejected`), true);
    btn.textContent = 'Rejected';
    return;
  }
  btn.textContent = 'Approved · mining…';
  await set(ref(database, `blockchain/pending_transactions/${txId}/approved`), true);
  await set(ref(database, `blockchain/pending_transactions/${txId}/approvedBy`), _validatorUser.uid);
  try {
    const resp = await fetch('https://alethea-miner-1.onrender.com/mine', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ miner_address: currentWalletAddress || 'unassigned' })
    });
    const result = await resp.json();
    if (result.error) {
      if (warnEl) warnEl.textContent = `⚠ ${result.error}`;
      btn.textContent = 'Mine failed';
      toast('Mining error: ' + result.error, true);
    } else {
      if (okEl) { okEl.textContent = `✓ Block #${result.block?.index} mined · +${result.reward_paid ?? 10} ALE reward`; okEl.style.display = 'block'; }
      btn.textContent = 'Mined ✓';
      toast(`Block #${result.block?.index} mined. +${result.reward_paid ?? 10} ALE reward.`);
    }
  } catch {
    if (warnEl) warnEl.textContent = '⚠ Miner unreachable — is app.py running?';
    btn.textContent = 'Miner offline';
    toast('Cannot reach miner — is app.py running?', true);
  }
}

// ---------- Market Simulation ----------
function initMarket() {
  priceHistory = [];
  let base = 0.082;
  for (let i = 0; i < 30; i++) {
    base = Math.max(0.05, base + (Math.random() - 0.5) * 0.008);
    priceHistory.push(base);
  }
  currentPrice = priceHistory[priceHistory.length - 1];
  updateMarketStats();
  drawChart();
}

function updateMarketStats() {
  const old = priceHistory[priceHistory.length - 2] || currentPrice;
  const change = ((currentPrice - old) / old) * 100;
  volume = parseFloat((volume + (Math.random() - 0.5) * 5).toFixed(1));
  marketCap = parseFloat((marketCap + (Math.random() - 0.5) * 0.12).toFixed(2));
  _setText('marketPrice', `$${currentPrice.toFixed(4)}`);
  _setText('priceChange', `${change >= 0 ? '+' : ''}${change.toFixed(2)}%`);
  _setText('volume', `$${volume.toFixed(1)}K`);
  _setText('marketCap', `$${marketCap.toFixed(2)}M`);
  const chEl = document.getElementById('priceChange');
  if (chEl) chEl.style.color = change >= 0 ? 'var(--acid)' : '#e05555';
}

function addPricePoint() {
  currentPrice = Math.max(0.045, Math.min(0.25, currentPrice * (1 + (Math.random() - 0.48) * 0.03)));
  priceHistory.push(currentPrice);
  if (priceHistory.length > 40) priceHistory.shift();
  updateMarketStats();
  drawChart();
}

function drawChart() {
  if (!chartCanvas || !chartCtx) return;
  const w = chartCanvas.clientWidth;
  const h = chartCanvas.clientHeight;
  chartCanvas.width = w;
  chartCanvas.height = h;
  chartCtx.clearRect(0, 0, w, h);
  if (priceHistory.length < 2) return;
  const minP = Math.min(...priceHistory) * 0.97;
  const maxP = Math.max(...priceHistory) * 1.03;
  const stepX = w / (priceHistory.length - 1);
  chartCtx.beginPath();
  chartCtx.strokeStyle = '#c8ff00';
  chartCtx.lineWidth = 1.5;
  priceHistory.forEach((p, i) => {
    const x = i * stepX;
    const y = h - ((p - minP) / (maxP - minP)) * h;
    i === 0 ? chartCtx.moveTo(x, y) : chartCtx.lineTo(x, y);
  });
  chartCtx.stroke();
  chartCtx.lineTo(w, h); chartCtx.lineTo(0, h);
  chartCtx.fillStyle = 'rgba(200,255,0,0.04)';
  chartCtx.fill();
}

// ---------- PIN‑unlock helper ----------
async function unlockPrivateKey(uid) {
  const snap = await get(ref(database, `users/${uid}/encryptedKey`));
  if (!snap.exists()) {
    toast('No encrypted key found. Please complete setup.', true);
    return null;
  }
  const encryptedBlob = snap.val();

  const pin = await promptForPin('Enter your 6‑digit PIN to unlock');
  if (!pin) return null;

  try {
    const privateJWK = await decryptPrivateKey(encryptedBlob, pin);
    return await importPrivateKey(privateJWK);
  } catch (e) {
    toast('Incorrect PIN. Please try again.', true);
    return null;
  }
}

// ---------- App Initialisation ----------
async function initialiseApp(user) {
  if (_unsubscribeRealtime) { _unsubscribeRealtime(); _unsubscribeRealtime = null; }
  if (_pendingUnsub) { _pendingUnsub(); _pendingUnsub = null; }
  if (marketInterval) { clearInterval(marketInterval); marketInterval = null; }

  currentWalletAddress = await getUserWalletAddress(user.uid);
  if (!currentWalletAddress) return;

  // 🔐 Unlock with PIN – no localStorage
  userCryptoKey = await unlockPrivateKey(user.uid);
  if (!userCryptoKey) {
    await signOut(auth);
    return;
  }

  const prefs = await getUserPreferences(user.uid);
  jarNodesEnabled = prefs.jarNodesEnabled ?? false;
  jarDistributionMode = prefs.jarDistributionMode ?? 'manual';

  const name = user.displayName || user.email.split('@')[0];
  _setText('user-name', name);
  _setText('user-email', user.email);
  const avatarEl = document.getElementById('user-avatar');
  if (avatarEl) avatarEl.textContent = name[0].toUpperCase();
  const hour = new Date().getHours();
  const greet = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';
  _setText('wallet-greeting', `${greet}, ${name.split(' ')[0]}.`);
  _validatorUser = user;

  // Update QR receive address
  if (window.aletheaQR) window.aletheaQR.setAddress(currentWalletAddress);

  allJarNodeAddresses = await loadJarNodeAddresses();
  await updateWalletDisplay();
  await loadTransactionHistory();

  _unsubscribeRealtime = createRealtimeListeners(
    currentWalletAddress,
    (snap) => {
      if (!snap.exists()) return;
      const newLiquid = snap.val().balance || 0;
      if (_lastKnownLiquid !== null) {
        const delta = newLiquid - _lastKnownLiquid;
        if (delta > 0 && !_isSendingTx) toast(`+ ${delta.toFixed(4)} ALE received.`);
        if (delta < 0) loadTransactionHistory();
      }
      _lastKnownLiquid = newLiquid;
      updateWalletDisplay();
    },
    () => loadTransactionHistory(),
    () => { loadTransactionHistory(); updateWalletDisplay(); }
  );

  chartCanvas = document.getElementById('priceChart');
  if (chartCanvas) chartCtx = chartCanvas.getContext('2d');
  initMarket();
  marketInterval = setInterval(addPricePoint, 12000);
  window.addEventListener('resize', drawChart);

  document.getElementById('setup-page').style.display = 'none';
  document.getElementById('app').classList.add('visible');
  document.getElementById('jar-action-card').style.display = jarNodesEnabled ? 'block' : 'none';
}

// ---------- Auth Observer ----------
onAuthStateChanged(auth, async (user) => {
  const splashEl = document.getElementById('splash-page');
  const loginEl = document.getElementById('login-page');
  const setupEl = document.getElementById('setup-page');
  const appEl = document.getElementById('app');

  if (user) {
    currentUser = user;
    loginEl.style.display = 'none';
    const hasWallet = await getUserWalletAddress(user.uid);
    if (hasWallet) {
      setupEl.style.display = 'none';
      await initialiseApp(user);
    } else {
      setupEl.style.display = 'flex';
      appEl.classList.remove('visible');
    }
    if (splashEl) splashEl.classList.add('hide');
  } else {
    currentUser = null;
    if (splashEl) splashEl.classList.add('hide');
    loginEl.style.display = 'flex';
    setupEl.style.display = 'none';
    appEl.classList.remove('visible');
    if (_unsubscribeRealtime) { _unsubscribeRealtime(); _unsubscribeRealtime = null; }
    if (_pendingUnsub) { _pendingUnsub(); _pendingUnsub = null; }
    if (marketInterval) { clearInterval(marketInterval); marketInterval = null; }
  }
});

// ---------- Wire Event Listeners (DOMContentLoaded) ----------
document.addEventListener('DOMContentLoaded', () => {
  // Navigation
  document.querySelectorAll('.nav-item[data-page]').forEach(item =>
    item.addEventListener('click', () => navigateTo(item.dataset.page)));
  document.getElementById('hamburger')?.addEventListener('click', openSidebar);
  document.getElementById('sidebar-overlay')?.addEventListener('click', closeSidebar);
  document.getElementById('topbar-addr')?.addEventListener('click', () => {
    if (!currentWalletAddress) return;
    navigator.clipboard.writeText(currentWalletAddress).then(() => {
      const el = document.getElementById('topbar-addr-text');
      const orig = el.textContent;
      el.textContent = 'copied!';
      setTimeout(() => el.textContent = orig, 1200);
    });
  });

  // Auth tabs
  document.querySelectorAll('.auth-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.auth-tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      clearAuthError();
      const isSignup = tab.dataset.tab === 'signup';
      document.getElementById('signin-fields').style.display = isSignup ? 'none' : 'flex';
      document.getElementById('signup-fields').style.display = isSignup ? 'flex' : 'none';
      document.getElementById('signin-btn').style.display = isSignup ? 'none' : 'inline-flex';
      document.getElementById('signup-btn').style.display = isSignup ? 'inline-flex' : 'none';
    });
  });

  // Sign In
  document.getElementById('signin-btn')?.addEventListener('click', async () => {
    const email = document.getElementById('signin-email')?.value.trim();
    const password = document.getElementById('signin-password')?.value;
    clearAuthError();
    if (!email) return showAuthError('Please enter your email.');
    if (!password) return showAuthError('Please enter your password.');
    setAuthLoading(true);
    try {
      await signInWithEmailAndPassword(auth, email, password);
    } catch (e) {
      setAuthLoading(false);
      showAuthError(_friendlyError(e.code));
    }
  });

  // Sign Up
  document.getElementById('signup-btn')?.addEventListener('click', async () => {
    const name = document.getElementById('signup-name')?.value.trim();
    const email = document.getElementById('signup-email')?.value.trim();
    const password = document.getElementById('signup-password')?.value;
    const confirm = document.getElementById('signup-confirm')?.value;
    clearAuthError();
    if (!name) return showAuthError('Please enter your name.');
    if (!email) return showAuthError('Please enter your email.');
    if (!password) return showAuthError('Please enter a password.');
    if (password.length < 8) return showAuthError('Password must be at least 8 characters.');
    if (password !== confirm) return showAuthError('Passwords do not match.');
    setAuthLoading(true);
    try {
      const cred = await createUserWithEmailAndPassword(auth, email, password);
      await updateProfile(cred.user, { displayName: name });
      await set(ref(database, `users/${cred.user.uid}/profile`), { name, email, createdAt: new Date().toISOString() });
    } catch (e) {
      setAuthLoading(false);
      showAuthError(_friendlyError(e.code));
    }
  });

  function _friendlyError(code) {
    const map = {
      'auth/invalid-email': 'Invalid email address.',
      'auth/user-not-found': 'No account found with that email.',
      'auth/wrong-password': 'Incorrect password.',
      'auth/invalid-credential': 'Incorrect email or password.',
      'auth/email-already-in-use': 'That email is already registered.',
      'auth/weak-password': 'Password must be at least 6 characters.',
      'auth/too-many-requests': 'Too many attempts. Please wait.',
      'auth/network-request-failed': 'Network error — check your connection.',
    };
    return map[code] || `Authentication error (${code}).`;
  }

  // Sign Out
  document.getElementById('signout-btn')?.addEventListener('click', async () => {
  const confirmed = await showConfirmDialog('Sign out of Alethea?');
  if (confirmed) await signOut(auth);
});

  // Setup Page – with PIN encryption
  let _privateJWK = null, _publicJWK = null, _cryptoKeyPair = null, _walletAddress = null;
  document.getElementById('generateKeysBtn')?.addEventListener('click', async () => {
    setLoading('generateKeysBtn', true);
    try {
      const { privateJWK, publicJWK, keyPair } = await generateECDSAKeyPair();
      _privateJWK = privateJWK; _publicJWK = publicJWK; _cryptoKeyPair = keyPair;
      _walletAddress = await deriveWalletAddress(publicJWK);
      document.getElementById('walletAddressValue').textContent = _walletAddress;
      document.getElementById('walletDisplay').style.display = 'block';
      const backup = { walletAddress: _walletAddress, privateKeyJWK: privateJWK, publicKeyJWK: publicJWK, createdAt: new Date().toISOString(), warning: 'Keep this file safe.' };
      const blob = new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = `alethea_keys_${Date.now()}.json`;
      document.body.appendChild(a); a.click(); document.body.removeChild(a); URL.revokeObjectURL(url);
      document.getElementById('jar-option').style.display = 'block';
      document.getElementById('finalize-area').style.display = 'block';
      document.getElementById('generateKeysBtn').querySelector('.btn-text').textContent = 'Keys Generated ✓';
    } catch (err) {
      document.getElementById('setup-error').textContent = 'Key generation failed: ' + err.message;
      document.getElementById('setup-error').style.display = 'block';
      setLoading('generateKeysBtn', false);
    }
  });

  document.getElementById('completeSetupBtn')?.addEventListener('click', async () => {
    if (!_cryptoKeyPair || !_walletAddress) {
      document.getElementById('setup-error').textContent = 'Please generate a wallet first.';
      document.getElementById('setup-error').style.display = 'block';
      return;
    }
    const user = currentUser;
    if (!user) {
      document.getElementById('setup-page').style.display = 'none';
      document.getElementById('login-page').style.display = 'flex';
      return;
    }

    // 🔐 Ask for PIN and encrypt private key
    const pin = await promptForPin('Create a 6‑digit PIN to secure your wallet');
    if (!pin || pin.length !== 6 || !/^\d+$/.test(pin)) {
      document.getElementById('setup-error').textContent = 'PIN must be exactly 6 digits.';
      document.getElementById('setup-error').style.display = 'block';
      return;
    }

    const jarEnabled = document.getElementById('enableJarNodes')?.checked ?? false;
    const distMode = document.querySelector('input[name="distMode"]:checked')?.value ?? 'manual';
    setLoading('completeSetupBtn', true);
    try {
      // Encrypt and store in Firebase (no localStorage)
      const encryptedBlob = await encryptPrivateKey(_privateJWK, pin);
      await set(ref(database, `users/${user.uid}/encryptedKey`), encryptedBlob);

      await set(ref(database, `wallets/${_walletAddress}`), {
        email: user.email, displayName: user.displayName || '', balance: 100,
        publicKeyJWK: _publicJWK, status: 'active', createdAt: new Date().toISOString()
      });
      await set(ref(database, `users/${user.uid}/wallet`), _walletAddress);
      await set(ref(database, `users/${user.uid}/prefs`), { jarNodesEnabled: jarEnabled, jarDistributionMode: distMode });
      if (jarEnabled) await set(ref(database, `jarnodes/${_walletAddress}/enabled`), true);

      // Re‑initialise app (will prompt for PIN again – acceptable for now)
      await initialiseApp(user);
    } catch (err) {
      document.getElementById('setup-error').textContent = 'Setup failed: ' + err.message;
      document.getElementById('setup-error').style.display = 'block';
      setLoading('completeSetupBtn', false);
    }
  });

  // App Buttons
  document.getElementById('sendBtn')?.addEventListener('click', handleSend);
  document.getElementById('copyAddressBtn')?.addEventListener('click', () => {
    if (!currentWalletAddress) return;
    navigator.clipboard.writeText(currentWalletAddress).then(() => {
      const btn = document.getElementById('copyAddressBtn');
      const orig = btn.textContent;
      btn.textContent = 'copied!';
      setTimeout(() => btn.textContent = orig, 1200);
    });
  });
  document.getElementById('refreshBlocksBtn')?.addEventListener('click', loadBlockchainPage);
  document.getElementById('refresh-tx-btn')?.addEventListener('click', loadTransactionHistory);
  document.getElementById('refreshNodesBtn')?.addEventListener('click', loadJarPage);
  document.getElementById('distributeBtn')?.addEventListener('click', distributeToJarNodes);
  document.getElementById('autoReclaimBtn')?.addEventListener('click', autoReclaimAll);
  document.getElementById('becomeValidatorBtn')?.addEventListener('click', async () => {
    const btn = document.getElementById('becomeValidatorBtn');
    const statusEl = document.getElementById('becomeStatus');
    btn.disabled = true;
    btn.querySelector('.btn-text').style.display = 'none';
    btn.querySelector('.btn-loading').style.display = 'inline';
    try {
      if (!currentUser) throw new Error('Not authenticated.');
      await update(ref(database, `users/${currentUser.uid}`), { isValidator: true });
      if (statusEl) statusEl.textContent = 'Validator status granted.';
      setTimeout(initValidatorPanel, 600);
    } catch (err) {
      btn.disabled = false;
      btn.querySelector('.btn-text').style.display = 'inline';
      btn.querySelector('.btn-loading').style.display = 'none';
      if (statusEl) statusEl.textContent = 'Error: ' + err.message;
    }
  });

  // Wire QR scan button (already handled by inline script)
  // Receive QR button opens modal via window.aletheaQR.openReceive
  document.getElementById('openReceiveQR')?.addEventListener('click', () => {
    if (!currentWalletAddress) {
      toast('Wallet address not loaded yet.', true);
      return;
    }
    if (window.aletheaQR) {
      window.aletheaQR.openReceive(currentWalletAddress);
    } else {
      toast('QR module not ready.', true);
    }
  });
});