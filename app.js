// ══════════════════════════════════════════════
//  GAS API 通訊
// ══════════════════════════════════════════════
const GAS_URL = 'https://script.google.com/macros/s/AKfycbxN_zAwK-GI9stX4bgPnx59WnsXAY--kgl3sXOrSeftSUFw3fefSA22VcCQ5SZpE4SQKg/exec';
window.modelMap = [];
window.mmFormHoles = [];
window.lockedHoles = {};
window.mmEditIndex = -1;
window.mmAccounts = [];

// 只有「讀取／不改資料」的動作才會自動重試；送單/儲存等會改資料的絕不重試（避免重複）
const RETRY_SAFE = { login:1, getVersion:1, getMyOrders:1, getAllOrders:1, getModelMap:1, getColorList:1, getTypeColors:1, getLastOrder:1, getAllAccounts:1, heartbeat:1 };
async function gasApi(action, data) {
  // 用 POST 送，資料放 body（text/plain → 不觸發 CORS 預檢），避開 GET 網址長度限制
  const body = JSON.stringify(Object.assign({ action }, data || {}));
  const safe = !!RETRY_SAFE[action];
  const maxTries = safe ? 2 : 1;                 // 讀取類失敗才重試一次；寫入類絕不重試（避免重複送出）
  const perTryTimeout = safe ? 12000 : 20000;    // 每次最多等這麼久；寫入類也給上限，避免卡死轉不停
  let lastErr;
  for (let i = 0; i < maxTries; i++) {
    const ctrl = new AbortController();
    const to = setTimeout(function(){ ctrl.abort(); }, perTryTimeout);
    try {
      const resp = await fetch(GAS_URL, { method: 'POST', body: body, redirect: 'follow', signal: ctrl.signal });
      clearTimeout(to);
      if (!resp.ok) throw new Error('HTTP ' + resp.status);
      return await resp.json();
    } catch (e) {
      clearTimeout(to);
      lastErr = e;
      if (i < maxTries - 1) await new Promise(function(r){ setTimeout(r, 600); });
    }
  }
  throw lastErr;
}

// 小快取：把不常變的參考資料存進 localStorage，登入時先秒開、背景再更新
function cacheGet(key) { try { return JSON.parse(localStorage.getItem(key) || 'null'); } catch (e) { return null; } }
function cacheSet(key, val) { try { localStorage.setItem(key, JSON.stringify(val)); } catch (e) {} }

function authData() {
  return { u: currentUser, p: currentPass };
}

// ══════════════════════════════════════════════
//  全域狀態
// ══════════════════════════════════════════════
let currentUser = '', currentPass = '', currentCustomer = '', currentRole = '';
let allOrders = null, allAdminOrders = null;
let adminPendingView = false;
let _installPrompt = null;
let groupCounter = 0, sizeCounter = 0;
let modalResolve = null;
let _appVersion = null, _versionTimer = null;
let _updatePending = false, _lastActivity = Date.now();
let _hbTimer = null, _accountsTimer = null;

// ══════════════════════════════════════════════
//  初始化
// ══════════════════════════════════════════════
window.addEventListener('load', function () {
  try {
    const saved = JSON.parse(localStorage.getItem('anyi_cred') || '{}');
    if (saved.u && saved.p) {
      document.getElementById('username').value = saved.u;
      document.getElementById('password').value = saved.p;
      document.getElementById('remember-me').checked = true;
      login();
      initInstallUI();
      return;
    }
  } catch (e) {}
  showLoginSection();
  initInstallUI();
});

// Service Worker 註冊 ＋ 前端新版偵測
if ('serviceWorker' in navigator) {
  window.addEventListener('load', function () {
    navigator.serviceWorker.register('./sw.js').then(function (reg) {
      // 偵測到新版 SW（已有舊版在控制 → 是更新而非初次安裝）
      reg.addEventListener('updatefound', function () {
        var nw = reg.installing;
        if (!nw) return;
        nw.addEventListener('statechange', function () {
          if (nw.state === 'installed' && navigator.serviceWorker.controller) markUpdateAvailable();
        });
      });
      // 每 3 分鐘叫瀏覽器去檢查有沒有新版 sw.js
      setInterval(function () { reg.update().catch(function () {}); }, 3 * 60 * 1000);
    }).catch(function () {});
    // 初次安裝時 controller 從無到有不算更新；之後換新 SW 才算
    var hadController = !!navigator.serviceWorker.controller;
    navigator.serviceWorker.addEventListener('controllerchange', function () {
      if (hadController) markUpdateAvailable();
      hadController = true;
    });
  });
}
// 閒置自動更新
window.addEventListener('load', initIdleReload);

// PWA 安裝提示
window.addEventListener('beforeinstallprompt', function (e) {
  e.preventDefault();
  _installPrompt = e;
  const btn = document.getElementById('install-btn');
  if (btn) btn.style.display = 'block';
  // 瀏覽器確實可安裝時才跳橫幅（已裝過/不支援的不會跳）
  try { showInstallBanner(); } catch (e2) {}
});
window.addEventListener('appinstalled', function () {
  _installPrompt = null;
  const btn = document.getElementById('install-btn');
  if (btn) btn.style.display = 'none';
  const done = document.getElementById('install-done');
  if (done) done.style.display = 'block';
  hideInstallBanner();
});

// ── 自動安裝引導橫幅 ──
function ibToday() { return new Date().toISOString().slice(0, 10); }
function installBannerDismissedToday() {
  try { return localStorage.getItem('anyi_install_hide') === ibToday(); } catch (e) { return false; }
}
function getInstallEnv() {
  var ua = navigator.userAgent || '';
  var standalone = window.navigator.standalone === true || window.matchMedia('(display-mode: standalone)').matches;
  if (standalone) return 'installed';
  if (/Line\/|FBAN|FBAV|FB_IAB|Instagram|Messenger|MicroMessenger/i.test(ua)) return 'inapp';
  var isIos = /iPad|iPhone|iPod/.test(ua) && !window.MSStream;
  if (isIos) return (/Safari/.test(ua) && !/CriOS|FxiOS|EdgiOS|OPiOS/.test(ua)) ? 'ios-safari' : 'ios-other';
  return /Android/i.test(ua) ? 'android' : 'desktop';
}
function showInstallBanner() {
  if (installBannerDismissedToday()) return;
  var env = getInstallEnv();
  if (env === 'installed') return;
  // Android／桌機：只有瀏覽器確實提供安裝時才跳（已裝過、不支援的就不跳）
  if ((env === 'android' || env === 'desktop') && !_installPrompt) return;
  var el = document.getElementById('install-banner');
  var body = document.getElementById('install-banner-body');
  if (!el || !body) return;
  var html = '';
  if (env === 'inapp') {
    html = '<div class="ib-title">📲 把訂單系統裝到手機桌面</div>' +
      '<div class="ib-text">目前是用 App 內建瀏覽器（如 LINE）開啟，沒辦法安裝。請點右上角「⋯」→「<b>用預設瀏覽器開啟</b>」，再回來安裝。</div>';
  } else if (env === 'ios-safari') {
    html = '<div class="ib-title">📲 把訂單系統裝到桌面</div>' +
      '<div class="ib-text">點畫面下方的「<b>分享</b>」按鈕（方框加箭頭 ⬆️）→ 往下滑找到「<b>加入主畫面</b>」→ 新增。</div>';
  } else if (env === 'ios-other') {
    html = '<div class="ib-title">📲 想裝到桌面嗎？</div>' +
      '<div class="ib-text">iPhone 請改用 <b>Safari</b> 開啟這個網址，才能「加入主畫面」變成 App。</div>';
  } else if (env === 'desktop') {
    html = '<div class="ib-title">📥 把訂單系統裝成應用程式</div>' +
      '<div class="ib-text">裝到電腦後，下次從桌面/工作列直接開、全螢幕使用，不用每次找網址。</div>' +
      '<button class="ib-install-btn" onclick="doInstallFromBanner()">📥 安裝</button>';
  } else { // android
    html = '<div class="ib-title">📲 把訂單系統裝成 App</div>' +
      '<div class="ib-text">裝到桌面後，下次點圖示直接開、全螢幕使用，不用每次找網址。</div>' +
      '<button class="ib-install-btn" onclick="doInstallFromBanner()">📲 安裝到手機</button>';
  }
  html += '<div class="ib-actions"><a href="#" onclick="dismissInstallBannerToday();return false;">今天不再提醒</a></div>';
  body.innerHTML = html;
  el.style.display = 'block';
}
function hideInstallBanner() {
  var el = document.getElementById('install-banner');
  if (el) el.style.display = 'none';
}
function dismissInstallBannerToday() {
  try { localStorage.setItem('anyi_install_hide', ibToday()); } catch (e) {}
  hideInstallBanner();
}
function doInstallFromBanner() {
  if (_installPrompt) {
    _installPrompt.prompt();
    _installPrompt.userChoice.then(function (r) { if (r.outcome === 'accepted') { _installPrompt = null; hideInstallBanner(); } });
  } else if (getInstallEnv() === 'desktop') {
    showAlert('請點網址列右邊的安裝圖示，或瀏覽器選單 →「安裝此網站為應用程式」');
  } else {
    showAlert('請點瀏覽器選單（⋮）→「安裝應用程式 / 加到主畫面」');
  }
}
// 延遲一點再顯示，讓 beforeinstallprompt 先觸發（Android 一鍵鈕才會生效）
window.addEventListener('load', function () { setTimeout(function () { try { showInstallBanner(); } catch (e) {} }, 800); });

function initInstallUI() {
  const ua = navigator.userAgent;
  const isIos = /iPad|iPhone|iPod/.test(ua) && !window.MSStream;
  const isStandalone = window.navigator.standalone === true || window.matchMedia('(display-mode: standalone)').matches;
  if (isStandalone) { showEl('install-done'); return; }
  if (isIos) { showEl('install-ios'); return; }
  if (!/Android/.test(ua)) showEl('install-desktop');
}

function doInstall() {
  if (!_installPrompt) return;
  _installPrompt.prompt();
  _installPrompt.userChoice.then(function (r) { if (r.outcome === 'accepted') _installPrompt = null; });
}

// ══════════════════════════════════════════════
//  畫面切換
// ══════════════════════════════════════════════
function showEl(id) { const el = document.getElementById(id); if (el) el.style.display = 'block'; }
function hideEl(id) { const el = document.getElementById(id); if (el) el.style.display = 'none'; }

function showLoginSection() {
  document.getElementById('login-section').style.display = 'flex';
  document.getElementById('register-section').style.display = 'none';
  document.getElementById('forgot-section').style.display = 'none';
  document.getElementById('form-section').style.display = 'none';
}
function showRegister() {
  document.getElementById('login-section').style.display = 'none';
  document.getElementById('register-section').style.display = 'flex';
}
function showLogin() {
  document.getElementById('register-section').style.display = 'none';
  document.getElementById('forgot-section').style.display = 'none';
  document.getElementById('login-section').style.display = 'flex';
}
function showForgot() {
  document.getElementById('login-section').style.display = 'none';
  document.getElementById('forgot-section').style.display = 'block';
}

function showTab(name) {
  ['order','query','admin','accounts','modelmap','settings'].forEach(function(t) {
    document.getElementById(t + '-section').style.display = t === name ? 'block' : 'none';
    const tab = document.getElementById('tab-' + t);
    if (tab) tab.classList.toggle('tab-active', t === name);
  });
  if (_accountsTimer) { clearInterval(_accountsTimer); _accountsTimer = null; }
  if (name === 'query' && !allOrders) loadOrders();
  if (name === 'admin' && !allAdminOrders) loadAllOrders();
  if (name === 'accounts') { loadAccounts(); _accountsTimer = setInterval(function(){ loadAccounts(true); }, 20000); }
  if (name === 'modelmap') renderModelMap();
}

// ══════════════════════════════════════════════
//  設定
// ══════════════════════════════════════════════

// ══════════════════════════════════════════════
//  登入 / 登出
// ══════════════════════════════════════════════
async function login() {
  const u = document.getElementById('username').value.trim();
  const p = document.getElementById('password').value.trim();
  if (!u || !p) return;
  hideEl('login-err'); hideEl('login-disabled');
  loading(true);
  try {
    const res = await gasApi('login', { u, p });
    loading(false);
    if (!res.success) {
      if (res.error === 'disabled') showEl('login-disabled');
      else showEl('login-err');
      return;
    }
    currentUser = u; currentPass = p;
    currentCustomer = res.customerName; currentRole = res.role;
    if (document.getElementById('remember-me').checked) {
      localStorage.setItem('anyi_cred', JSON.stringify({ u, p }));
    } else {
      localStorage.removeItem('anyi_cred');
    }
    document.getElementById('name-display').textContent = currentCustomer;
    document.getElementById('login-section').style.display = 'none';
    document.getElementById('form-section').style.display = 'block';
    if (currentRole === 'admin') {
      document.getElementById('tab-admin').style.display = 'flex';
      document.getElementById('tab-accounts').style.display = 'flex';
      document.getElementById('tab-modelmap').style.display = 'flex';
      document.getElementById('proxy-customer-wrap').style.display = 'block';
      loadProxyCustomers();
    }
    loadModelMap();
    loadColorList();
    loadTypeColors();
    const today = new Date().toISOString().slice(0, 10);
    document.getElementById('query-date').value = today;
    document.getElementById('admin-date').value = today;
    allOrders = null; allAdminOrders = null;
    startVersionPolling();
    startHeartbeat();
    initGroups();
  } catch (e) {
    loading(false);
    showAlert('連線失敗，請確認網路或 GAS 網址是否正確');
  }
}

function startVersionPolling() {
  if (_versionTimer) clearInterval(_versionTimer);
  gasApi('getVersion', {}).then(function(r) { if (r && r.version) _appVersion = r.version; });
  _versionTimer = setInterval(function() {
    gasApi('getVersion', {}).then(function(r) {
      if (!r || !r.version) return;
      if (_appVersion && r.version !== _appVersion) {
        markUpdateAvailable();
        clearInterval(_versionTimer);
      }
    }).catch(function(){});
  }, 2 * 60 * 1000);
}

// ── 閒置時自動套用更新 ───────────────────────────────
function markUpdateAvailable() {
  if (_updatePending) return;
  _updatePending = true;
  var b = document.getElementById('update-banner');
  if (b) b.style.display = 'block';
}
function _reloadForUpdate() {
  window.location.href = window.location.href.split('?')[0] + '?_=' + Date.now();
}
// 訂單表單有沒有打到一半（避免自動重整洗掉客人的單；數量預設值不算）
function orderFormHasInput() {
  var gc = document.getElementById('groups-container');
  if (!gc) return false;
  var inputs = gc.querySelectorAll('input[type="text"], input[type="number"]');
  for (var i = 0; i < inputs.length; i++) {
    var el = inputs[i];
    if ((el.id || '').slice(-4) === '-qty') continue;
    if (el.value && el.value.trim() !== '') return true;
  }
  return false;
}
function initIdleReload() {
  ['pointerdown','keydown','touchstart','scroll','mousemove'].forEach(function(ev){
    window.addEventListener(ev, function(){ _lastActivity = Date.now(); }, { passive: true });
  });
  // 每 30 秒檢查：有新版 ＋ 閒置滿 5 分鐘 ＋ 沒打到一半的單 → 自動重整
  setInterval(function(){
    if (!_updatePending) return;
    if (Date.now() - _lastActivity < 5 * 60 * 1000) return;
    if (orderFormHasInput()) return;
    _reloadForUpdate();
  }, 30 * 1000);
}

function logout() {
  currentUser = ''; currentPass = ''; currentCustomer = ''; currentRole = '';
  allOrders = null; allAdminOrders = null;
  if (_versionTimer) { clearInterval(_versionTimer); _versionTimer = null; }
  if (_hbTimer) { clearInterval(_hbTimer); _hbTimer = null; }
  if (_accountsTimer) { clearInterval(_accountsTimer); _accountsTimer = null; }
  _appVersion = null;
  document.getElementById('update-banner').style.display = 'none';
  document.getElementById('form-section').style.display = 'none';
  document.getElementById('tab-admin').style.display = 'none';
  document.getElementById('tab-accounts').style.display = 'none';
  document.getElementById('tab-modelmap').style.display = 'none';
  document.getElementById('proxy-customer-wrap').style.display = 'none';
  window.modelMap = []; window.colorList = []; window.lockedHoles = {}; window.mmFormHoles = []; window.mmEditIndex = -1; window.mmAccounts = [];
  showLoginSection();
}

async function register() {
  const name = document.getElementById('reg-name').value.trim();
  const taxId = document.getElementById('reg-taxid').value.trim();
  const user = document.getElementById('reg-user').value.trim();
  const pass = document.getElementById('reg-pass').value.trim();
  const pass2 = document.getElementById('reg-pass2').value.trim();
  const errEl = document.getElementById('reg-err');
  errEl.style.display = 'none';
  if (!name || !taxId || !user || !pass) { errEl.textContent = '請填寫所有必填欄位'; errEl.style.display = 'block'; return; }
  if (pass !== pass2) { errEl.textContent = '兩次密碼不一致'; errEl.style.display = 'block'; return; }
  loading(true);
  try {
    const res = await gasApi('register', { data: { customerName: name, taxId, username: user, password: pass } });
    loading(false);
    if (!res.success) {
      errEl.textContent = res.error === 'duplicate' ? '此帳號已被使用，請換一個' : '申請失敗：' + (res.error || '');
      errEl.style.display = 'block'; return;
    }
    showAlert('申請成功！歡迎 ' + res.customerName + '，請登入使用。');
    showLogin();
  } catch (e) { loading(false); showAlert('連線失敗'); }
}

async function doForgotPassword() {
  const user = document.getElementById('fgt-user').value.trim();
  const taxId = document.getElementById('fgt-taxid').value.trim();
  const pass = document.getElementById('fgt-pass').value.trim();
  const pass2 = document.getElementById('fgt-pass2').value.trim();
  const errEl = document.getElementById('fgt-err');
  errEl.style.display = 'none';
  if (!user || !taxId || !pass) { errEl.textContent = '請填寫所有欄位'; errEl.style.display = 'block'; return; }
  if (pass !== pass2) { errEl.textContent = '兩次密碼不一致'; errEl.style.display = 'block'; return; }
  loading(true);
  try {
    const res = await gasApi('resetPassword', { username: user, taxId, newPass: pass });
    loading(false);
    if (!res.success) {
      errEl.textContent = res.error === 'wrong_taxid' ? '統一編號不符' : res.error === 'not_found' ? '找不到此帳號' : '重設失敗';
      errEl.style.display = 'block'; return;
    }
    showAlert('密碼已重設，請重新登入。');
    showLogin();
  } catch (e) { loading(false); showAlert('連線失敗'); }
}

async function doChangePassword() {
  const oldP = document.getElementById('pw-old').value.trim();
  const newP = document.getElementById('pw-new').value.trim();
  const newP2 = document.getElementById('pw-new2').value.trim();
  const errEl = document.getElementById('pw-err');
  const okEl = document.getElementById('pw-ok');
  errEl.style.display = 'none'; okEl.style.display = 'none';
  if (!oldP || !newP) { errEl.textContent = '請填寫所有欄位'; errEl.style.display = 'block'; return; }
  if (newP.length < 4) { errEl.textContent = '新密碼至少需要 4 個字元'; errEl.style.display = 'block'; return; }
  if (newP !== newP2) { errEl.textContent = '兩次密碼不一致'; errEl.style.display = 'block'; return; }
  loading(true);
  try {
    const res = await gasApi('changePassword', { ...authData(), oldPass: oldP, newPass: newP });
    loading(false);
    if (!res.success) { errEl.textContent = '舊密碼錯誤'; errEl.style.display = 'block'; return; }
    currentPass = newP;
    localStorage.setItem('anyi_cred', JSON.stringify({ u: currentUser, p: newP }));
    okEl.style.display = 'block';
    document.getElementById('pw-old').value = '';
    document.getElementById('pw-new').value = '';
    document.getElementById('pw-new2').value = '';
  } catch (e) { loading(false); showAlert('連線失敗'); }
}

// ══════════════════════════════════════════════
//  訂單表單
// ══════════════════════════════════════════════
function initGroups() {
  groupCounter = 0; sizeCounter = 0;
  const gc = document.getElementById('groups-container');
  gc.style.display = '';                       // 還原顯示（送單成功後曾被隱藏）
  gc.innerHTML = '';
  document.querySelectorAll('#order-section .content > .btn-outline, #order-section .content > .btn-green')
    .forEach(function(el){ el.style.display = ''; });
  document.getElementById('success-card').style.display = 'none';
  updateCutoffNotice();
  addGroup();
  // 預填上次型式
  gasApi('getLastOrder', authData()).then(function(last) {
    if (!last) return;
    const g = document.querySelector('#groups-container .group-card');
    if (!g) return;
    const gid = g.id.replace('group-','');
    const m = document.getElementById('g'+gid+'-model');
    if (m && last.modelType) { m.value = last.modelType; applyColorRestriction(gid, last.modelType); }
    const c = document.getElementById('g'+gid+'-color');
    if (c && last.color) c.value = last.color;
  }).catch(function(){});
}

function nextOrder() {
  document.getElementById('groups-container').style.display = '';
  document.querySelectorAll('#order-section .content > .btn-outline, #order-section .content > .btn-green')
    .forEach(function(el){ el.style.display = ''; });
  initGroups();
  document.getElementById('success-card').style.display = 'none';
}

function addGroup() {
  const gid = ++groupCounter;
  const wrap = document.getElementById('groups-container');
  const card = document.createElement('div');
  card.className = 'group-card'; card.id = 'group-' + gid;
  card.innerHTML =
    '<div class="group-header">' +
      '<span class="group-num">型式 / 顏色 #' + gid + '</span>' +
      (gid > 1 ? '<button class="btn-remove-row" onclick="removeGroup('+gid+')">✕ 移除</button>' : '') +
    '</div>' +
    '<div class="row-2">' +
      '<div class="field"><label>型式 <span class="req">*</span></label><input type="text" id="g'+gid+'-model" placeholder="如 101" list="model-codes-list" oninput="applyModelCode('+gid+',this.value)" onchange="applyModelCode('+gid+',this.value)"></div>' +
      '<div class="field"><label>顏色 <span class="req">*</span></label><div id="g'+gid+'-color-wrap"><input type="text" id="g'+gid+'-color" placeholder="如 P1" list="color-list"></div></div>' +
    '</div>' +
    '<div id="g'+gid+'-preset-remark" style="display:none;font-size:.8rem;color:#2b6cb0;background:#ebf8ff;border:1px solid #bee3f8;border-radius:6px;padding:6px 10px;margin-bottom:10px"></div>' +
    '<div id="g'+gid+'-doorface" style="display:none;margin-bottom:10px"></div>' +
    '<div class="sizes-container" id="sizes-'+gid+'"></div>' +
    '<button class="btn btn-outline add-size-btn" onclick="addSizeRow('+gid+')">＋ 新增尺寸</button>';
  wrap.appendChild(card);
  addSizeRow(gid);
}

function removeGroup(gid) {
  const el = document.getElementById('group-' + gid);
  if (el) el.remove();
}

function addSizeRow(gid) {
  const sid = ++sizeCounter;
  const container = document.getElementById('sizes-' + gid);
  const num = container.children.length + 1;
  const row = document.createElement('div');
  row.className = 'size-row'; row.id = 'size-' + sid;
  const uOpts = '<option value="公分">公分</option><option value="分">尺</option><option value="寸">寸</option>';
  row.innerHTML =
    '<div class="size-main">' +
      '<span class="size-seq">' + num + '</span>' +
      '<div class="size-field dim-field"><label>上寬</label>' +
        '<div class="dim-wrap"><input type="number" id="s'+sid+'-topW" placeholder="數值" oninput="updateDimUnit(this,\'s'+sid+'-topW-u\',150);autoCalcHole('+sid+');updateHolePreview('+sid+')">' +
        '<span id="s'+sid+'-topW-u" class="dim-u-btn" data-unit="" data-sid="'+sid+'" onclick="toggleDimUnit(this)">—</span></div></div>' +
      '<div class="size-field dim-field" id="s'+sid+'-bottomW-wrap" style="display:none"><label>下寬</label>' +
        '<div class="dim-wrap"><input type="number" id="s'+sid+'-bottomW" placeholder="數值" oninput="updateDimUnit(this,\'s'+sid+'-bottomW-u\',150);autoCalcHole('+sid+');updateHolePreview('+sid+')">' +
        '<span id="s'+sid+'-bottomW-u" class="dim-u-btn" data-unit="" data-sid="'+sid+'" onclick="toggleDimUnit(this)">—</span></div></div>' +
      '<div class="size-field dim-field"><label>高度</label>' +
        '<div class="dim-wrap"><input type="number" id="s'+sid+'-height" placeholder="數值" oninput="updateDimUnit(this,\'s'+sid+'-height-u\',300);autoCalcHole('+sid+');updateHolePreview('+sid+')">' +
        '<span id="s'+sid+'-height-u" class="dim-u-btn" data-unit="" data-sid="'+sid+'" onclick="toggleDimUnit(this)">—</span></div></div>' +
      '<div class="size-field size-field-sm"><label>數量</label><input type="number" id="s'+sid+'-qty" value="1" min="1"></div>' +
      '<button class="btn-remove-size" onclick="removeSizeRow('+sid+')">✕</button>' +
    '</div>' +
    '<div style="display:flex;flex-wrap:wrap;justify-content:space-between;align-items:flex-start;gap:8px;margin-top:10px">' +
      '<label class="size-slant" style="margin-bottom:0"><input type="checkbox" id="s'+sid+'-slant" onchange="toggleSizeSlant('+sid+')"> 斜邊</label>' +
      '<label class="size-slant" style="margin-bottom:0"><input type="checkbox" id="s'+sid+'-hole" onchange="toggleHole('+sid+')"> 挖洞</label>' +
      '<label class="size-slant" style="margin-bottom:0"><input type="checkbox" id="s'+sid+'-bridge"> 橋洞板</label>' +
      '<label class="size-slant" style="margin-bottom:0"><input type="checkbox" id="s'+sid+'-reinforce"> 上下補強</label>' +
      '<label class="size-slant" style="margin-bottom:0"><input type="checkbox" id="s'+sid+'-strip"> 下降壓條</label>' +
    '</div>' +
    '<div class="size-field size-field-grow" style="margin-top:6px;max-width:100%"><label>備註</label>' +
      '<input type="text" id="s'+sid+'-remark" placeholder=""></div>' +
    buildHolePanel(sid);
  container.appendChild(row);
}

function removeSizeRow(sid) {
  const el = document.getElementById('size-' + sid);
  if (el) el.remove();
}

function toggleSizeSlant(sid) {
  const checked = document.getElementById('s'+sid+'-slant').checked;
  const wrap = document.getElementById('s'+sid+'-bottomW-wrap');
  if (wrap) wrap.style.display = checked ? 'flex' : 'none';
  updateHolePreview(sid);
}

function toggleHole(sid) {
  const chk = document.getElementById('s'+sid+'-hole');
  if (chk && chk.dataset.locked) { chk.checked = true; return; }
  const checked = chk ? chk.checked : false;
  const panel = document.getElementById('s'+sid+'-hole-wrap');
  if (panel) panel.style.display = checked ? 'flex' : 'none';
  if (checked) { autoCalcHole(sid); updateHolePreview(sid); }
}

function buildHolePanel(sid) {
  const uCm = '<option value="公分" selected>公分</option><option value="分">尺</option><option value="寸">寸</option>';
  const uCun = '<option value="公分">公分</option><option value="分">尺</option><option value="寸" selected>寸</option>';
  const uPlain = '<option value="公分">公分</option><option value="分">尺</option><option value="寸">寸</option>';
  // 距離欄：改動時清除配對欄的 manual，讓對側自動更新
  function df(key, label, defVal, uOpts) {
    return '<div class="hole-field"><label>'+label+'</label>' +
      '<input type="number" id="s'+sid+'-hole'+key+'" value="'+(defVal||'')+'" placeholder="" oninput="holeDistInput(this,\''+key+'\','+sid+');updateHolePreview('+sid+')">' +
      '<select id="s'+sid+'-hole'+key+'-u" onchange="holeDistUnit('+sid+',\''+key+'\');updateHolePreview('+sid+')">'+(uOpts||uPlain)+'</select></div>';
  }
  // 洞寬/洞高：維持原本邏輯
  function sf(key, label, uOpts) {
    return '<div class="hole-field"><label>'+label+'</label>' +
      '<input type="number" id="s'+sid+'-hole'+key+'" value="" placeholder="" oninput="holeSetManual(this);autoCalcHole('+sid+');updateHolePreview('+sid+')">' +
      '<select id="s'+sid+'-hole'+key+'-u" onchange="autoCalcHole('+sid+');updateHolePreview('+sid+')">'+(uOpts||uPlain)+'</select></div>';
  }
  return '<div class="hole-panel" id="s'+sid+'-hole-wrap" style="display:none">' +
    '<div style="flex:1;min-width:0">' +
      '<div id="s'+sid+'-hole-locked-display" style="display:none;margin-bottom:8px">' +
        '<div style="font-size:.78rem;color:#2b6cb0;font-weight:700;margin-bottom:4px">由型式對照設定（唯讀）</div>' +
        '<div id="s'+sid+'-hole-locked-spec" style="font-size:.78rem;color:#4a5568;line-height:1.9"></div>' +
      '</div>' +
      '<div class="hole-fields-wrap" id="s'+sid+'-hole-fields-wrap">' +
        '<div style="display:flex;gap:16px;margin-bottom:8px;flex-wrap:wrap">' +
          '<label style="display:flex;align-items:center;gap:4px;font-size:.78rem;color:#2b6cb0;cursor:pointer;white-space:nowrap"><input type="checkbox" id="s'+sid+'-holeCH" onchange="toggleHoleCenter('+sid+')"> 左右置中</label>' +
          '<label style="display:flex;align-items:center;gap:4px;font-size:.78rem;color:#2b6cb0;cursor:pointer;white-space:nowrap"><input type="checkbox" id="s'+sid+'-holeCV" onchange="toggleHoleCenter('+sid+')"> 上下置中</label>' +
        '</div>' +
        '<div class="hole-dist-row">' +
          df('T','距高','',uCun) + df('B','距底','',uCm) +
          df('L','距左','',uCun) + df('R','距右','',uCun) +
        '</div>' +
        '<div class="hole-size-row">' + sf('W','洞寬',uPlain) + sf('H','洞高',uPlain) + '</div>' +
      '</div>' +
    '</div>' +
    '<div class="hole-preview" id="s'+sid+'-hole-preview"></div>' +
  '</div>';
}
var holePair = {L:'R',R:'L',B:'T',T:'B'};
function holeDistInput(el, key, sid) {
  el.dataset.manual = '1';
  const opp = document.getElementById('s'+sid+'-hole'+holePair[key]);
  if (opp) delete opp.dataset.manual;
  autoCalcHole(sid);
}
function holeDistUnit(sid, key) {
  const opp = document.getElementById('s'+sid+'-hole'+holePair[key]);
  if (opp) delete opp.dataset.manual;
  autoCalcHole(sid);
}

// ══════════════════════════════════════════════
//  單位工具
// ══════════════════════════════════════════════
function unitToMm(val, unit) {
  const v = parseFloat(val) || 0;
  if (unit === '寸' || unit === '台寸') return v * 100/3.3;   // 寸（台寸）= 1/0.33公分
  if (unit === '分' || unit === '台分' || unit === '尺') return v * 10/3.3;  // 尺（=舊台分）= 1/3.3公分
  return v * 10;   // 公分
}
// 顯示一律「寸 / 尺 / 公分」（吃得下舊的 台寸/台分/分）
function unitLabel(u) {
  if (u === '寸' || u === '台寸') return '寸';
  if (u === '分' || u === '台分' || u === '尺') return '尺';
  return '公分';
}
// 挖洞下拉的內部 value（寸 / 分 / 公分），給設定型式對照帶入時用
function unitValue(u) {
  if (u === '寸' || u === '台寸') return '寸';
  if (u === '分' || u === '台分' || u === '尺') return '分';
  return '公分';
}
// 把一段文字裡的舊單位換成新單位（避開「公分」不誤改）
function normUnitsText(s) {
  return String(s == null ? '' : s).replace(/台寸/g, '寸').replace(/台分/g, '尺').replace(/([\d.])\s*分/g, '$1尺');
}
function updateDimUnit(input, labelId, threshold) {
  const v = parseFloat(input.value);
  const el = document.getElementById(labelId);
  if (!el) return;
  if (!v || v <= 0) { el.dataset.unit = ''; delete el.dataset.manual; el.textContent = '—'; return; }
  if (el.dataset.manual === '1') return;
  const unit = v < threshold ? '公分' : '分';
  el.dataset.unit = unit;
  el.textContent = unit === '分' ? '尺' : '公分';
}
function toggleDimUnit(el) {
  const cur = el.dataset.unit;
  if (!cur) return;
  const next = cur === '分' ? '公分' : '分';
  el.dataset.unit = next;
  el.textContent = next === '分' ? '尺' : '公分';
  el.dataset.manual = '1';
  const sid = el.dataset.sid;
  if (sid) { autoCalcHole(parseInt(sid)); updateHolePreview(parseInt(sid)); }
}
function getFieldUnit(sid, field) {
  const el = document.getElementById('s' + sid + '-' + field + '-u');
  return (el && el.dataset.unit) ? el.dataset.unit : '公分';
}
function dimUnit(val, threshold) {
  return parseFloat(val) >= threshold ? '分' : '公分';
}
function dimDisp(v, threshold) {
  const n = parseFloat(v);
  if (!n) return escHtml(String(v));
  return n < threshold ? n + '公分' : n + '尺';
}

// ── 角材計算 ──
function computeA9(t, tUnit, b, bUnit, sub) {
  const tFen = tUnit === '分' ? t : t * 3.3;
  const bFen = b > 0 ? (bUnit === '分' ? b : b * 3.3) : 0;
  let w = Math.max(tFen, bFen);
  if (w <= 0) return null;
  w = w - (sub || 23);
  const i = Math.floor(w), d = w - i;
  return d < 0.3 ? i : d < 0.8 ? i + 0.5 : i + 1;
}

// ── 挖洞 ──
function holeVal(sid, key) {
  const el = document.getElementById('s'+sid+'-hole'+key);
  return el ? el.value : '';
}
function holeUnit(sid, key) {
  const el = document.getElementById('s'+sid+'-hole'+key+'-u');
  if (!el) return '公分';
  return unitLabel(el.value);
}
function holeValMm(sid, key) {
  const el = document.getElementById('s'+sid+'-hole'+key);
  const uEl = document.getElementById('s'+sid+'-hole'+key+'-u');
  if (!el || el.value === '') return 0;
  return unitToMm(parseFloat(el.value)||0, uEl ? uEl.value : '公分');
}
function getDoorMm(sid, wh) {
  if (wh === 'W') {
    const tW = parseFloat(document.getElementById('s'+sid+'-topW').value)||0;
    const bEl = document.getElementById('s'+sid+'-bottomW');
    const bW = bEl ? (parseFloat(bEl.value)||0) : 0;
    return Math.max(unitToMm(tW, getFieldUnit(sid,'topW')), unitToMm(bW, getFieldUnit(sid,'bottomW')));
  }
  const h = parseFloat(document.getElementById('s'+sid+'-height').value)||0;
  return unitToMm(h, getFieldUnit(sid,'height'));
}
function setHoleAuto(sid, key, mm) {
  const el = document.getElementById('s'+sid+'-hole'+key);
  const uEl = document.getElementById('s'+sid+'-hole'+key+'-u');
  if (!el || el.dataset.manual) return;
  if (mm <= 0) { el.value = ''; el.classList.remove('hole-input-auto'); return; }
  const unit = uEl ? uEl.value.replace('台','') : '公分';
  const v = unit==='寸' ? mm/10*0.33 : unit==='分' ? mm/10*3.3 : mm/10;
  el.value = parseFloat(v.toFixed(2));
  el.classList.add('hole-input-auto');
}
function holeSetManual(el) {
  if (el.value === '') { delete el.dataset.manual; el.classList.remove('hole-input-auto'); }
  else { el.dataset.manual = '1'; el.classList.remove('hole-input-auto'); }
}
function autoCalcHole(sid) {
  if (window.lockedHoles[sid]) { updateHolePreview(sid); return; }
  const dW = getDoorMm(sid,'W'), dH = getDoorMm(sid,'H');
  const chEl=document.getElementById('s'+sid+'-holeCH'), cvEl=document.getElementById('s'+sid+'-holeCV');
  const centerH = chEl && chEl.checked, centerV = cvEl && cvEl.checked;
  // 置中：自動算距離
  if (centerH && dW > 0) { const W=holeValMm(sid,'W'); if (W>0) { const d=(dW-W)/2; forceHole(sid,'L',d); forceHole(sid,'R',d); } }
  if (centerV && dH > 0) { const H=holeValMm(sid,'H'); if (H>0) { const d=(dH-H)/2; forceHole(sid,'T',d); forceHole(sid,'B',d); } }
  // 距左+距右都有 → 自動算洞寬；距高+距底都有 → 自動算洞高（距離永遠不自動補）
  if (!centerH && dW > 0) {
    const lEl=document.getElementById('s'+sid+'-holeL'),rEl=document.getElementById('s'+sid+'-holeR'),wEl=document.getElementById('s'+sid+'-holeW');
    if (lEl&&rEl&&wEl&&lEl.value!==''&&rEl.value!==''&&!wEl.dataset.manual) setHoleAuto(sid,'W', dW-holeValMm(sid,'L')-holeValMm(sid,'R'));
  }
  if (!centerV && dH > 0) {
    const tEl=document.getElementById('s'+sid+'-holeT'),bEl=document.getElementById('s'+sid+'-holeB'),hEl=document.getElementById('s'+sid+'-holeH');
    if (tEl&&bEl&&hEl&&tEl.value!==''&&bEl.value!==''&&!hEl.dataset.manual) setHoleAuto(sid,'H', dH-holeValMm(sid,'T')-holeValMm(sid,'B'));
  }
}
function forceHole(sid, key, mm) {
  const el = document.getElementById('s'+sid+'-hole'+key);
  const uEl = document.getElementById('s'+sid+'-hole'+key+'-u');
  if (!el) return;
  if (mm <= 0) { el.value=''; el.classList.remove('hole-input-auto'); return; }
  const unit = uEl ? uEl.value.replace('台','') : '公分';
  const v = unit==='寸' ? mm/10*0.33 : unit==='分' ? mm/10*3.3 : mm/10;
  el.value = parseFloat(v.toFixed(2));
  el.classList.add('hole-input-auto');
}
function toggleHoleCenter(sid) {
  const cH = document.getElementById('s'+sid+'-holeCH');
  const cV = document.getElementById('s'+sid+'-holeCV');
  ['L','R'].forEach(function(k){ const el=document.getElementById('s'+sid+'-hole'+k); if(el) el.disabled = !!(cH&&cH.checked); });
  ['T','B'].forEach(function(k){ const el=document.getElementById('s'+sid+'-hole'+k); if(el) el.disabled = !!(cV&&cV.checked); });
  autoCalcHole(sid); updateHolePreview(sid);
}
function holeSpecText(sid) {
  if (window.lockedHoles[sid]) {
    const dW = getDoorMm(sid,'W'), dH = getDoorMm(sid,'H');
    return holesSpecText(window.lockedHoles[sid], dW, dH);
  }
  const w=holeVal(sid,'W'),h=holeVal(sid,'H');
  const b=holeVal(sid,'B'),t=holeVal(sid,'T');
  const l=holeVal(sid,'L'),r=holeVal(sid,'R');
  let s='【挖洞】洞寬'+w+holeUnit(sid,'W')+' 洞高'+h+holeUnit(sid,'H');
  if(b) s+=' 距底'+b+holeUnit(sid,'B');
  if(t) s+=' 距高'+t+holeUnit(sid,'T');
  if(l) s+=' 距左'+l+holeUnit(sid,'L');
  if(r) s+=' 距右'+r+holeUnit(sid,'R');
  return s;
}
function valToMm(valWithUnit) {
  if (!valWithUnit) return 0;
  var m = String(valWithUnit).match(/^([\d.]+)(公分|台分|台寸|尺|寸|分)$/);
  if (!m) return 0;
  return unitToMm(parseFloat(m[1]), m[2]);
}
function calcHolesLayout(holes, doorWmm, doorHmm) {
  if (!holes || !holes.length) return [];
  var centerH = !!holes[0].centerH, centerV = !!holes[0].centerV;
  var distL_mm = valToMm(holes[0].distL);
  var hW = holes.map(function(h){ return valToMm(h.holeW); });
  var hH = holes.map(function(h){ return valToMm(h.holeH); });
  var gap = holes.map(function(h,i){ return i===0 ? 0 : valToMm(h.gap); });
  var startTop;
  if (centerV && doorHmm > 0) {
    var stackH = 0;
    for (var k=0;k<holes.length;k++) stackH += hH[k] + gap[k];
    startTop = (doorHmm - stackH) / 2;
  } else {
    startTop = valToMm(holes[0].distT);
  }
  var result = [], curTop = startTop;
  for (var i = 0; i < holes.length; i++) {
    if (i > 0) curTop = result[i-1].distT_mm + result[i-1].holeH_mm + gap[i];
    var dL = (centerH && doorWmm > 0) ? (doorWmm - hW[i]) / 2 : distL_mm;
    result.push({
      distT_mm: curTop, distL_mm: dL, holeW_mm: hW[i], holeH_mm: hH[i],
      distB_mm: doorHmm > 0 ? doorHmm - curTop - hH[i] : 0,
      distR_mm: doorWmm > 0 ? doorWmm - dL - hW[i] : 0
    });
  }
  return result;
}
// ── 門型示意圖（系統畫線，非照片，無版權問題）──────────
var DOOR_FACES = {
  '3v':   { name:'三直線',   lines:[[0.14,0.06,0.14,0.94],[0.20,0.06,0.20,0.94],[0.26,0.06,0.26,0.94]] },
  '1v':   { name:'左直線',   lines:[[0.14,0.06,0.14,0.94]] },
  '6h':   { name:'6+2',      lines:[[0.15,0.05,0.15,0.95],[0.85,0.05,0.85,0.95],[0.15,0.20,0.85,0.20],[0.15,0.35,0.85,0.35],[0.15,0.50,0.85,0.50],[0.15,0.65,0.85,0.65],[0.15,0.80,0.85,0.80]] },
  '2h':   { name:'3+2',      lines:[[0.17,0.05,0.17,0.95],[0.83,0.05,0.83,0.95],[0.17,0.44,0.83,0.44],[0.17,0.50,0.83,0.50],[0.17,0.56,0.83,0.56]] },
  'cv':   { name:'中央直板', lines:[[0.17,0.05,0.17,0.95],[0.83,0.05,0.83,0.95]] },
  'S12':  { name:'S12',      lines:[[0.06,0.12,0.94,0.12],[0.06,0.155,0.94,0.155],[0.06,0.27,0.94,0.27],[0.06,0.305,0.94,0.305],[0.06,0.42,0.94,0.42],[0.06,0.455,0.94,0.455],[0.06,0.57,0.94,0.57],[0.06,0.605,0.94,0.605],[0.06,0.72,0.94,0.72],[0.06,0.755,0.94,0.755],[0.06,0.87,0.94,0.87],[0.06,0.905,0.94,0.905]] },
  '103':  { name:'103',      rects:[[0.12,0.10,0.88,0.90],[0.20,0.55,0.80,0.86]], arches:[[0.20,0.15,0.80,0.48,0.18]] },
  '101':  { name:'101',      rects:[[0.17,0.55,0.83,0.90]], arches:[[0.17,0.11,0.83,0.48,0.18]] },
  '5+1':  { name:'5+1',      lines:[[0.15,0.05,0.15,0.95],[0.15,0.16,0.94,0.16],[0.15,0.33,0.94,0.33],[0.15,0.50,0.94,0.50],[0.15,0.67,0.94,0.67],[0.15,0.84,0.94,0.84]] },
  '4+2':  { name:'4+2',      lines:[[0.17,0.05,0.17,0.95],[0.83,0.05,0.83,0.95],[0.17,0.10,0.83,0.10],[0.17,0.51,0.83,0.51],[0.17,0.59,0.83,0.59],[0.17,0.90,0.83,0.90]] },
  '5h':   { name:'5橫',      lines:[[0.06,0.18,0.94,0.18],[0.06,0.36,0.94,0.36],[0.06,0.54,0.94,0.54],[0.06,0.72,0.94,0.72],[0.06,0.90,0.94,0.90]] }
};
function doorFaceName(code){ return (DOOR_FACES[code]||{}).name || ''; }
function doorFaceOptions(sel){
  var o = '<option value="">無</option>';
  for (var k in DOOR_FACES) o += '<option value="'+k+'"'+(sel===k?' selected':'')+'>'+DOOR_FACES[k].name+'</option>';
  return o;
}
function doorFaceSVG(code, hPx){
  var d = DOOR_FACES[code]; if (!d) return '';
  var h = hPx||140, w = Math.round(h*0.42);
  var sw = Math.max(2.5, w*0.05);
  var body = '';
  (d.lines||[]).forEach(function(L){
    body += '<line x1="'+(L[0]*w).toFixed(1)+'" y1="'+(L[1]*h).toFixed(1)+'" x2="'+(L[2]*w).toFixed(1)+'" y2="'+(L[3]*h).toFixed(1)+'" stroke="#2b6cb0" stroke-width="'+sw.toFixed(1)+'" stroke-linecap="round"/>';
  });
  (d.rects||[]).forEach(function(R){
    body += '<rect x="'+(R[0]*w).toFixed(1)+'" y="'+(R[1]*h).toFixed(1)+'" width="'+((R[2]-R[0])*w).toFixed(1)+'" height="'+((R[3]-R[1])*h).toFixed(1)+'" rx="2" fill="none" stroke="#2b6cb0" stroke-width="'+sw.toFixed(1)+'"/>';
  });
  (d.arches||[]).forEach(function(A){
    var x1=A[0]*w,y1=A[1]*h,x2=A[2]*w,y2=A[3]*h,asY=y1+(A[4]||0.22)*(y2-y1),mx=(x1+x2)/2,cy=2*y1-asY;
    body += '<path d="M '+x1.toFixed(1)+' '+y2.toFixed(1)+' L '+x2.toFixed(1)+' '+y2.toFixed(1)+' L '+x2.toFixed(1)+' '+asY.toFixed(1)+' Q '+mx.toFixed(1)+' '+cy.toFixed(1)+' '+x1.toFixed(1)+' '+asY.toFixed(1)+' Z" fill="none" stroke="#2b6cb0" stroke-width="'+sw.toFixed(1)+'"/>';
  });
  return '<svg width="'+w+'" height="'+h+'" style="display:block;border:1.5px solid #2b6cb0;border-radius:4px;background:#f7fafc">'+body+'</svg>';
}
function doorFaceCanvas(ctx, code, cx, topY, hPx){
  var d = DOOR_FACES[code]; if (!d) return 0;
  var h = hPx, w = Math.round(h*0.42), x = Math.round(cx - w/2), y = topY;
  ctx.fillStyle='#f7fafc'; ctx.fillRect(x,y,w,h);
  ctx.strokeStyle='#2b6cb0'; ctx.lineWidth=1.5; ctx.strokeRect(x,y,w,h);
  ctx.strokeStyle='#2b6cb0'; ctx.lineWidth=Math.max(2.5, w*0.05); ctx.lineCap='round';
  (d.lines||[]).forEach(function(L){ ctx.beginPath(); ctx.moveTo(x+L[0]*w, y+L[1]*h); ctx.lineTo(x+L[2]*w, y+L[3]*h); ctx.stroke(); });
  (d.rects||[]).forEach(function(R){ ctx.strokeRect(x+R[0]*w, y+R[1]*h, (R[2]-R[0])*w, (R[3]-R[1])*h); });
  (d.arches||[]).forEach(function(A){
    var x1=x+A[0]*w,y1=y+A[1]*h,x2=x+A[2]*w,y2=y+A[3]*h,asY=y1+(A[4]||0.22)*(y2-y1),mx=(x1+x2)/2,cy=2*y1-asY;
    ctx.beginPath(); ctx.moveTo(x1,y2); ctx.lineTo(x2,y2); ctx.lineTo(x2,asY); ctx.quadraticCurveTo(mx,cy,x1,asY); ctx.closePath(); ctx.stroke();
  });
  return h;
}
function orderDoorFace(it){
  var e = (window.modelMap||[]).find(function(m){ return m.code === it.customerCode; });
  return e && e.doorFace ? e.doorFace : '';
}
function mmUpdateDoorFacePreview() {
  var sel = document.getElementById('mm-form-doorface');
  var box = document.getElementById('mm-doorface-preview');
  if (box) box.innerHTML = (sel && sel.value) ? doorFaceSVG(sel.value, 90) : '';
}
function drawHolesSVG(doorWmm, doorHmm, computed, maxW, maxH) {
  maxW = maxW||120; maxH = maxH||200;
  if (!doorWmm||!doorHmm||!computed.length) return '';
  var scale = Math.min(maxW/doorWmm, maxH/doorHmm);
  var dw = +(doorWmm*scale).toFixed(2), dh = +(doorHmm*scale).toFixed(2);
  var rects = '';
  for (var i = 0; i < computed.length; i++) {
    var c = computed[i];
    if (c.holeW_mm>0&&c.holeH_mm>0) {
      rects += '<rect x="'+(c.distL_mm*scale).toFixed(2)+'" y="'+(c.distT_mm*scale).toFixed(2)+
        '" width="'+Math.max(1,c.holeW_mm*scale).toFixed(2)+'" height="'+Math.max(1,c.holeH_mm*scale).toFixed(2)+
        '" fill="#fff" stroke="#e53e3e" stroke-width="1.5" stroke-dasharray="3,2"/>';
    }
  }
  return '<svg width="'+dw+'" height="'+dh+'" style="box-sizing:content-box;border:2px solid #2b6cb0;border-radius:3px;background:#ebf8ff">'+
    '<rect width="'+dw+'" height="'+dh+'" fill="#ebf8ff"/>'+rects+'</svg>'+
    '<div class="hole-note" style="margin-top:4px">'+(doorWmm/10).toFixed(1)+'×'+(doorHmm/10).toFixed(1)+'公分</div>';
}
function mmDispUnit(valWithUnit) {
  if (!valWithUnit) return '';
  var m = String(valWithUnit).match(/^([\d.]+)(公分|台分|台寸|尺|寸|分)$/);
  return m ? (parseFloat(m[1]) + unitLabel(m[2])) : normUnitsText(valWithUnit);
}
function holesSpecText(holes, doorWmm, doorHmm) {
  var computed = calcHolesLayout(holes, doorWmm, doorHmm);
  function cm(mm) { return mm > 0 ? (mm/10).toFixed(1)+'公分' : '?'; }
  // 設定者有手動填的欄位 → 顯示原本單位；系統自動算的 → 公分
  function disp(orig, mm) {
    var mt = orig ? String(orig).match(/^([\d.]+)(公分|台分|台寸|尺|寸|分)$/) : null;
    return mt ? (parseFloat(mt[1])+unitLabel(mt[2])) : cm(mm);
  }
  var parts = computed.map(function(c, i) {
    var h = holes[i];
    var s = '洞'+(i+1);
    if (i>0) s += ' 洞距'+disp(h.gap, valToMm(h.gap));
    s += ' 洞寬'+disp(h.holeW, c.holeW_mm)+' 洞高'+disp(h.holeH, c.holeH_mm);
    s += ' 距高'+(i===0 ? disp(h.distT, c.distT_mm) : cm(c.distT_mm));
    s += ' 距底'+cm(c.distB_mm);
    s += ' 距左'+disp(holes[0].distL, c.distL_mm);
    s += ' 距右'+cm(c.distR_mm);
    return s;
  });
  return '【挖洞】'+parts.join('　');
}
function updateHolePreview(sid) {
  const box = document.getElementById('s'+sid+'-hole-preview');
  if (!box) return;
  const topWVal = parseFloat(document.getElementById('s'+sid+'-topW').value)||0;
  const botEl = document.getElementById('s'+sid+'-bottomW');
  const botWVal = botEl ? (parseFloat(botEl.value)||0) : 0;
  const doorW = Math.max(unitToMm(topWVal,getFieldUnit(sid,'topW')), unitToMm(botWVal,getFieldUnit(sid,'bottomW')));
  const hRaw = parseFloat(document.getElementById('s'+sid+'-height').value)||0;
  const doorH = unitToMm(hRaw, getFieldUnit(sid,'height'));
  if (window.lockedHoles[sid]) {
    const computed = calcHolesLayout(window.lockedHoles[sid], doorW, doorH);
    if (doorW<=0||doorH<=0) { box.innerHTML='<div class="hole-note">請先填門板上寬與高度</div>'; }
    else { box.innerHTML = drawHolesSVG(doorW, doorH, computed); }
    const specEl = document.getElementById('s'+sid+'-hole-locked-spec');
    if (specEl) {
      const lines = holesSpecText(window.lockedHoles[sid], doorW, doorH)
        .replace('【挖洞】','').split('　');
      specEl.innerHTML = lines.map(function(l){ return '<div>'+escHtml(l)+'</div>'; }).join('');
    }
    return;
  }
  if (doorW<=0||doorH<=0) { box.innerHTML='<div class="hole-note">請先填門板上寬與高度，才能畫示意圖</div>'; return; }
  const holeW=unitToMm(holeVal(sid,'W'),holeUnit(sid,'W'));
  const holeH=unitToMm(holeVal(sid,'H'),holeUnit(sid,'H'));
  // 定位：有距左用距左、否則用距右；有距高用距高、否則用距底（用門板實際尺寸）
  const lFilled=holeVal(sid,'L')!=='', rFilled=holeVal(sid,'R')!=='';
  const tFilled=holeVal(sid,'T')!=='', bFilled=holeVal(sid,'B')!=='';
  const Lmm=unitToMm(holeVal(sid,'L')||'0',holeUnit(sid,'L'));
  const Rmm=unitToMm(holeVal(sid,'R')||'0',holeUnit(sid,'R'));
  const Tmm=unitToMm(holeVal(sid,'T')||'0',holeUnit(sid,'T'));
  const Bmm=unitToMm(holeVal(sid,'B')||'0',holeUnit(sid,'B'));
  const leftMm = lFilled ? Lmm : (rFilled ? (doorW - Rmm - holeW) : 0);
  const topMm  = tFilled ? Tmm : (bFilled ? (doorH - Bmm - holeH) : 0);
  const MAX=120; const scale=Math.min(MAX/doorW,MAX*1.5/doorH);
  const dw=+(doorW*scale).toFixed(2),dh=+(doorH*scale).toFixed(2);
  let inner='';
  if(holeW>0&&holeH>0) {
    const hw=+Math.max(1,holeW*scale).toFixed(2),hh=+Math.max(1,holeH*scale).toFixed(2);
    const hx=+(leftMm*scale).toFixed(2),hy=+(topMm*scale).toFixed(2);
    inner=`<rect x="${hx}" y="${hy}" width="${hw}" height="${hh}" fill="#fff" stroke="#e53e3e" stroke-width="1.5" stroke-dasharray="3,2"/>`;
  }
  box.innerHTML=`<svg width="${dw}" height="${dh}" style="box-sizing:content-box;border:2px solid #2b6cb0;border-radius:3px;background:#ebf8ff"><rect width="${dw}" height="${dh}" fill="#ebf8ff"/>${inner}</svg><div class="hole-note" style="margin-top:4px">${(doorW/10).toFixed(1)}×${(doorH/10).toFixed(1)}公分</div>`;
}

function updateCutoffNotice() {
  const el = document.getElementById('cutoff-notice');
  if (!el) return;
  const now = new Date();
  const h = now.getHours(), m = now.getMinutes();
  if (h > 16 || (h === 16 && m >= 31)) {
    const tom = new Date(now.getTime() + 86400000);
    const tomStr = (tom.getMonth()+1) + '月' + tom.getDate() + '日';
    el.innerHTML = '<div style="font-size:.82rem;color:#c53030;padding:8px 12px;background:#fff5f5;border-radius:8px;border-left:3px solid #e53e3e;margin-bottom:10px">⚠️ 已超過截單時間（16:31），此訂單將列入 <strong>'+tomStr+'</strong> 處理</div>';
  } else {
    el.innerHTML = '<div style="font-size:.8rem;color:#718096;text-align:center;margin-bottom:8px">每日 16:31 後下單，將列入隔日處理</div>';
  }
}

// ══════════════════════════════════════════════
//  送出訂單
// ══════════════════════════════════════════════
async function submitAllOrders() {
  const groups = document.querySelectorAll('#groups-container .group-card');
  if (!groups.length) { showAlert('請先新增訂單'); return; }
  // 管理員代下單：這批記在所選客戶名下
  let orderCustomer = currentCustomer, placedBy = '';
  if (currentRole === 'admin') {
    const sel = document.getElementById('proxy-customer');
    orderCustomer = sel ? sel.value.trim() : '';
    if (!orderCustomer) { showAlert('請先在最上方選擇或輸入「代下單客戶」'); return; }
    placedBy = currentUser;
  }
  const orders = [];
  for (const g of groups) {
    const gid = g.id.replace('group-', '');
    const modelEl = document.getElementById('g'+gid+'-model');
    const model = (modelEl.dataset.systemCode || modelEl.value).trim();
    const customerCode = (modelEl.value || '').trim();
    const color = document.getElementById('g'+gid+'-color').value.trim();
    if (!model || !color) { showAlert('請填寫型式與顏色'); return; }
    const rows = g.querySelectorAll('.size-row');
    for (const row of rows) {
      const sid = row.id.replace('size-', '');
      const topW = document.getElementById('s'+sid+'-topW').value.trim();
      const topWUnit = getFieldUnit(sid,'topW');
      const height = document.getElementById('s'+sid+'-height').value.trim();
      const heightUnit = getFieldUnit(sid,'height');
      const qty = document.getElementById('s'+sid+'-qty').value.trim();
      const slant = document.getElementById('s'+sid+'-slant').checked;
      const botEl = document.getElementById('s'+sid+'-bottomW');
      const bottomW = slant && botEl ? botEl.value.trim() : '';
      const botWUnit = slant ? getFieldUnit(sid,'bottomW') : '公分';
      let remark = document.getElementById('s'+sid+'-remark').value.trim();
      // 型式對照的預設備註：自動合併（客戶備註 ＋ 型式預設備註）
      const presetRemark = (modelEl.dataset.presetRemark || '').trim();
      if (presetRemark) remark = remark ? (remark + ' ' + presetRemark) : presetRemark;
      if (!topW || !height || !qty) { showAlert('有必填欄位未填'); return; }
      if (slant && !bottomW) { showAlert('勾選斜邊但未填下寬'); return; }
      const hole = document.getElementById('s'+sid+'-hole').checked;
      if (hole) {
        if (window.lockedHoles[sid]) {
          const spec = holeSpecText(sid);
          remark = remark ? remark+' '+spec : spec;
        } else {
          const hw = holeVal(sid,'W'), hh = holeVal(sid,'H');
          if (!(parseFloat(hw)>0)||!(parseFloat(hh)>0)) { showAlert('挖洞的洞寬與洞高須大於 0'); return; }
          const cH = document.getElementById('s'+sid+'-holeCH'), cV = document.getElementById('s'+sid+'-holeCV');
          const hasV = (cV&&cV.checked) || holeVal(sid,'T')!=='' || holeVal(sid,'B')!=='';
          const hasHo = (cH&&cH.checked) || holeVal(sid,'L')!=='' || holeVal(sid,'R')!=='';
          if (!hasV || !hasHo) { showAlert('挖洞請至少填：距高或距底（擇一）＋ 距左或距右（擇一），洞才能定位'); return; }
          const spec = holeSpecText(sid);
          remark = remark ? remark+' '+spec : spec;
        }
      }
      // 加工勾選項 → 併入備註（標準字串，避免打錯字）
      if (document.getElementById('s'+sid+'-bridge').checked && remark.indexOf('橋洞板') === -1) remark = remark ? remark + ' 橋洞板' : '橋洞板';
      if (document.getElementById('s'+sid+'-reinforce').checked && remark.indexOf('上下補強') === -1) remark = remark ? remark + ' 上下補強' : '上下補強';
      if (document.getElementById('s'+sid+'-strip').checked && remark.indexOf('下降壓條') === -1) remark = remark ? remark + ' 下降壓條' : '下降壓條';
      const a9sub = remark.indexOf('橋洞板') !== -1 ? 22 : 23;
      const resultA9 = computeA9(parseFloat(topW)||0, topWUnit, parseFloat(bottomW)||0, botWUnit, a9sub) || 0;
      orders.push({ modelType: model, customerCode, color, topW, topWUnit, bottomW, botWUnit, height, heightUnit, quantity: qty, remark, resultA9, customerName: orderCustomer, placedBy: placedBy });
    }
  }
  const totalQty = orders.reduce(function(s,o){ return s+(parseInt(o.quantity)||0); }, 0);
  const summary = orders.map(function(o){
    const wu = o.topWUnit==='分'?'尺':'公分';
    const hu = o.heightUnit==='分'?'尺':'公分';
    return o.modelType+'/'+o.color+' 寬'+o.topW+(o.bottomW?'/'+o.bottomW:'')+wu+' 高'+o.height+hu+' ×'+o.quantity+'片';
  }).join('\n');
  const ok = await showConfirm('確定送出以下 '+orders.length+' 筆訂單（共 '+totalQty+' 片）？\n\n'+summary);
  if (!ok) return;
  loading(true);
  try {
    const res = await gasApi('saveOrders', { ...authData(), orders });
    loading(false);
    if (!res.success) { showAlert('送出失敗：'+(res.error||'未知錯誤')); return; }
    document.getElementById('groups-container').style.display = 'none';
    document.querySelectorAll('#order-section .content > .btn-outline, #order-section .content > .btn-green')
      .forEach(function(el){ el.style.display = 'none'; });
    document.getElementById('success-title').textContent = '訂單已送出！（編號：' + res.orderId + '）';
    document.getElementById('success-card').style.display = 'block';
    window.scrollTo(0, 0);
  } catch (e) { loading(false); showAlert('連線失敗'); }
}

// ══════════════════════════════════════════════
//  查詢紀錄
// ══════════════════════════════════════════════
async function loadOrders() {
  loading(true);
  try {
    allOrders = await gasApi('getMyOrders', authData());
    loading(false);
    renderOrders();
  } catch (e) { loading(false); showAlert('查詢失敗'); }
}

function filterOrdersByDate(orders, dateVal) {
  var d = new Date(dateVal + 'T12:00:00');
  d.setDate(d.getDate() - 1);
  var prevStr = d.getFullYear() + '-' +
    ('0'+(d.getMonth()+1)).slice(-2) + '-' +
    ('0'+d.getDate()).slice(-2);
  return orders.filter(function(o) {
    if (o.time.startsWith(dateVal) && o.time.slice(11, 16) < '16:31') return true;
    return o.time.startsWith(prevStr) && o.time.slice(11, 16) >= '16:31';
  });
}

function sortGroupsPendingFirst(groups) {
  return groups.sort(function(a, b) {
    var aC = a.items.every(function(it){ return it.status==='已確認'; }) ? 1 : 0;
    var bC = b.items.every(function(it){ return it.status==='已確認'; }) ? 1 : 0;
    return aC - bC;
  });
}

function renderOrders() {
  if (!allOrders) return;
  const dateVal = document.getElementById('query-date').value;
  const idQuery = (document.getElementById('query-orderid').value||'').trim().toUpperCase();
  const listEl = document.getElementById('orders-list');
  const summaryEl = document.getElementById('summary-card');
  const noDataEl = document.getElementById('no-orders');
  const filtered = idQuery
    ? allOrders.filter(function(o){ return String(o.orderId||'').toUpperCase().indexOf(idQuery)!==-1; })
    : filterOrdersByDate(allOrders, dateVal);
  const p = dateVal.split('-');
  document.getElementById('summary-date').textContent = idQuery ? '編號搜尋：'+idQuery : p[0]+'/'+p[1]+'/'+p[2];
  if (!filtered.length) { summaryEl.style.display='none'; noDataEl.style.display='block'; listEl.innerHTML=''; return; }
  noDataEl.style.display='none'; summaryEl.style.display='flex';
  document.getElementById('summary-total').textContent = filtered.reduce(function(s,o){return s+o.quantity;},0);
  const groups = sortGroupsPendingFirst(groupOrders(filtered).reverse());
  listEl.innerHTML = groups.map(function(g,i){
    const t = g.time.length>=16 ? g.time.substring(11,16) : '';
    const allConfirmed = g.items.every(function(it){ return it.status==='已確認'; });
    const isPending = g.items.some(function(it){ return it.status==='待料'; });
    const badge = isPending
      ? '<span class="status-badge badge-waiting">待料</span>'
      : allConfirmed
      ? '<span class="status-badge badge-confirmed">已確認</span>'
      : '<span class="status-badge badge-pending">待確認</span>';
    const idTag = g.orderId ? '<span style="font-size:.75rem;color:#718096;margin-left:6px">'+escHtml(g.orderId)+'</span>' : '';
    const totalQty = g.items.reduce(function(s,it){return s+it.quantity;},0);
    const editBtn = !allConfirmed ? '<button class="btn-action" style="background:#ebf8ff;color:#2b6cb0" onclick="showEditModal(\''+escHtml(g.orderId)+'\')">✏️ 修改</button>' : '';
    const dlBtn = g.orderId ? '<button class="btn-action" style="background:#e6fffa;color:#2c7a7b" onclick="downloadOrderImage(\''+escHtml(g.orderId)+'\')">📥 下載訂單</button>' : '';
    return '<div class="order-item">' +
      '<div class="order-item-header"><span class="order-seq">#'+(groups.length-i)+idTag+'</span><span class="order-time">'+t+'　'+badge+'</span></div>' +
      g.items.map(itemLine).join('') +
      '<div class="order-qty" style="margin-top:8px">本單共 <strong>'+totalQty+' 片</strong></div>' +
      ((editBtn||dlBtn) ? '<div class="order-actions">'+editBtn+dlBtn+'</div>' : '') +
    '</div>';
  }).join('');
}

// ── 下載訂單圖片（仿訂貨單 PNG）─────────────────────────
function mmRocDate(time) {
  if (!time || time.length < 10) return '';
  var y = parseInt(time.slice(0,4),10) - 1911;
  var mo = parseInt(time.slice(5,7),10), da = parseInt(time.slice(8,10),10);
  return y + ' 年 ' + mo + ' 月 ' + da + ' 日';
}
function downloadOrderImage(orderId) {
  var items = (allOrders || []).filter(function(o){ return String(o.orderId) === String(orderId); });
  if (!items.length) { showAlert('找不到訂單資料'); return; }
  var custName = items[0].customerName || '';
  var dateStr = mmRocDate(items[0].time || '');
  var totalQty = items.reduce(function(s,it){ return s + (parseInt(it.quantity)||0); }, 0);

  var FF = "'Microsoft JhengHei','Noto Sans TC',sans-serif";
  var fBody = "16px " + FF, fSmall = "13.5px " + FF;
  var W = 800, colX = [20,170,360,420,530,780];
  var headerTop = 68, headerH = 38, pad = 8, lineH = 22, baseRowH = 44;

  var meas = document.createElement('canvas').getContext('2d');
  function wrap(text, maxW, font) {
    meas.font = font; text = String(text==null?'':text);
    if (text === '') return [''];
    var lines = [], cur = '';
    for (var i=0;i<text.length;i++){
      var ch = text.charAt(i);
      if (ch === '\n') { lines.push(cur); cur=''; continue; }
      var t = cur + ch;
      if (meas.measureText(t).width > maxW && cur !== '') { lines.push(cur); cur = ch; }
      else cur = t;
    }
    lines.push(cur);
    return lines;
  }
  function sizeText(it) {
    var hh = dimDisp(it.height,400);
    if (it.bottomW) return dimDisp(it.topW,150)+'／'+dimDisp(it.bottomW,150)+'（斜）× '+hh;
    return dimDisp(it.topW,150)+' × '+hh;
  }
  var rows = items.map(function(it){
    var modelLines = wrap(it.modelType, colX[1]-colX[0]-2*pad, fBody);
    var sizeLines  = wrap(sizeText(it), colX[2]-colX[1]-2*pad, fBody);
    var colorLines = wrap(it.color, colX[4]-colX[3]-2*pad, fBody);
    var remarkLines= wrap(normUnitsText(it.remark), colX[5]-colX[4]-2*pad, fSmall);
    var maxL = Math.max(modelLines.length, sizeLines.length, colorLines.length, remarkLines.length, 1);
    var df = it ? orderDoorFace(it) : '';
    var h = Math.max(baseRowH, maxL*lineH + 2*pad, df ? (modelLines.length*lineH + 60 + 3*pad) : 0);
    return {it:it, df:df, modelLines:modelLines, sizeLines:sizeLines, colorLines:colorLines, remarkLines:remarkLines, h:h};
  });
  // 不足 9 列補空白列，表格才不會太空
  while (rows.length < 9) {
    rows.push({it:null, modelLines:[''], sizeLines:[''], colorLines:[''], remarkLines:[''], h:baseRowH});
  }
  var tableTop = headerTop + headerH;
  var rowsH = rows.reduce(function(s,r){ return s+r.h; }, 0);
  var tableBottom = tableTop + rowsH;
  var H = tableBottom + 90;

  var scale = 2;
  var canvas = document.createElement('canvas');
  canvas.width = W*scale; canvas.height = H*scale;
  var ctx = canvas.getContext('2d');
  ctx.scale(scale, scale);
  ctx.fillStyle = '#fff'; ctx.fillRect(0,0,W,H);
  ctx.textBaseline = 'middle';

  ctx.fillStyle='#2d3748'; ctx.font='18px '+FF; ctx.textAlign='left';
  ctx.fillText(dateStr, 20, 36);
  ctx.fillStyle='#1a365d'; ctx.font='bold 28px '+FF; ctx.textAlign='center';
  ctx.fillText(custName + '訂貨單', W/2, 38);
  ctx.fillStyle='#2d3748'; ctx.font='18px '+FF; ctx.textAlign='right';
  ctx.fillText('廠商：安奕木業', 780, 36);

  ctx.strokeStyle='#2d3748'; ctx.lineWidth=2;
  ctx.strokeRect(20, headerTop, 760, headerH + rowsH);
  ctx.fillStyle='#ebf2fb'; ctx.fillRect(20, headerTop, 760, headerH);

  function cellMid(i){ return (colX[i]+colX[i+1])/2; }
  function block(lines, x, align, rowTop, rowH, lh, font, color) {
    ctx.font = font; ctx.fillStyle = color; ctx.textAlign = align;
    var bH = lines.length*lh, startY = rowTop + (rowH-bH)/2 + lh/2;
    for (var i=0;i<lines.length;i++) ctx.fillText(lines[i], x, startY + i*lh);
  }

  ctx.strokeStyle='#2d3748'; ctx.lineWidth=1.5;
  [colX[1],colX[2],colX[3],colX[4]].forEach(function(x){
    ctx.beginPath(); ctx.moveTo(x, headerTop); ctx.lineTo(x, tableBottom); ctx.stroke();
  });
  ctx.beginPath(); ctx.moveTo(20, tableTop); ctx.lineTo(780, tableTop); ctx.stroke();

  var hMid = headerTop + headerH/2;
  ctx.font='bold 17px '+FF; ctx.fillStyle='#1a365d'; ctx.textAlign='center';
  ctx.fillText('型式', cellMid(0), hMid);
  ctx.fillText('尺寸', cellMid(1), hMid);
  ctx.fillText('數量', cellMid(2), hMid);
  ctx.fillText('顏色', cellMid(3), hMid);
  ctx.fillText('備註', cellMid(4), hMid);

  var y = tableTop;
  rows.forEach(function(r, idx){
    if (idx > 0) {
      ctx.strokeStyle='#cbd5e0'; ctx.lineWidth=1;
      ctx.beginPath(); ctx.moveTo(20, y); ctx.lineTo(780, y); ctx.stroke();
    }
    if (r.df) {
      var mh = r.modelLines.length*lineH;
      block(r.modelLines, cellMid(0), 'center', y + pad, mh, lineH, fBody, '#2d3748');
      doorFaceCanvas(ctx, r.df, cellMid(0), y + pad + mh + 4, 56);
    } else {
      block(r.modelLines, cellMid(0), 'center', y, r.h, lineH, fBody, '#2d3748');
    }
    block(r.sizeLines, cellMid(1), 'center', y, r.h, lineH, fBody, '#2d3748');
    block([r.it ? String(r.it.quantity==null?'':r.it.quantity) : ''], cellMid(2), 'center', y, r.h, lineH, fBody, '#2d3748');
    block(r.colorLines, cellMid(3), 'center', y, r.h, lineH, fBody, '#2d3748');
    block(r.remarkLines, colX[4]+pad, 'left', y, r.h, lineH, fSmall, '#4a5568');
    y += r.h;
  });

  var fy = tableBottom + 32;
  ctx.fillStyle='#1a365d'; ctx.font='bold 17px '+FF; ctx.textAlign='left';
  ctx.fillText('總數：'+totalQty+' 片', 40, fy);
  ctx.fillStyle='#2d3748'; ctx.font='16px '+FF;
  ctx.fillText('經手人：__________', 320, fy);
  ctx.fillText('核對：__________', 600, fy);
  ctx.fillStyle='#718096'; ctx.font='14px '+FF;
  ctx.fillText('訂單編號：'+(orderId||''), 40, fy+30);

  try {
    var url = canvas.toDataURL('image/png');
    var a = document.createElement('a');
    a.href = url; a.download = '訂貨單_'+(orderId||custName)+'.png';
    document.body.appendChild(a); a.click(); a.remove();
  } catch(e) { showAlert('產生圖片失敗'); }
}

// ══════════════════════════════════════════════
//  老闆後台
// ══════════════════════════════════════════════
async function loadAllOrders() {
  if (allAdminOrders !== null) { renderAdminOrders(); return; }
  loading(true);
  try {
    allAdminOrders = await gasApi('getAllOrders', authData());
    loading(false);
    renderAdminOrders();
  } catch (e) { loading(false); showAlert('查詢失敗'); }
}

function refreshAdminOrders() { allAdminOrders = null; loadAllOrders(); }

function renderAdminOrders() {
  if (adminPendingView) { renderPendingOrders(); return; }
  const dateVal = document.getElementById('admin-date').value;
  const selectEl = document.getElementById('admin-search');
  const idQuery = (document.getElementById('admin-orderid').value||'').trim().toUpperCase();
  const byDate = filterOrdersByDate(allAdminOrders||[], dateVal).filter(function(o){ return String(o.status)!=='待料'; });
  const prev = selectEl.value;
  const names = [];
  byDate.forEach(function(o){ if(names.indexOf(o.customerName)===-1) names.push(o.customerName); });
  selectEl.innerHTML = '<option value="">所有客戶</option>' +
    names.map(function(n){ return '<option value="'+escHtml(n)+'"'+(n===prev?' selected':'')+'>'+escHtml(n)+'</option>'; }).join('');
  const chosen = selectEl.value;
  let filtered;
  if (idQuery) {
    filtered = (allAdminOrders||[]).filter(function(o){ return String(o.orderId||'').toUpperCase().indexOf(idQuery)!==-1; });
    document.getElementById('admin-summary-date').textContent = '編號搜尋：'+idQuery;
  } else {
    filtered = chosen ? byDate.filter(function(o){ return o.customerName===chosen; }) : byDate;
    const p = dateVal.split('-');
    document.getElementById('admin-summary-date').textContent = p[0]+'/'+p[1]+'/'+p[2];
  }
  const listEl = document.getElementById('admin-orders-list');
  const summaryEl = document.getElementById('admin-summary-card');
  const noDataEl = document.getElementById('admin-no-orders');
  if (!filtered.length) { summaryEl.style.display='none'; noDataEl.style.display='block'; listEl.innerHTML=''; return; }
  noDataEl.style.display='none'; summaryEl.style.display='flex';
  document.getElementById('admin-summary-total').textContent = filtered.reduce(function(s,o){return s+o.quantity;},0);
  const groups = sortGroupsPendingFirst(groupOrders(filtered).reverse());
  listEl.innerHTML = groups.map(function(g,i){
    const t = g.time.length>=16 ? g.time.substring(11,16) : '';
    const st = groupStatus(g);
    const badge = st==='待料' ? '<span class="status-badge badge-waiting">待料</span>'
      : st==='已確認' ? '<span class="status-badge badge-confirmed">已確認</span>'
      : '<span class="status-badge badge-pending">待確認</span>';
    const idTag = g.orderId ? '<span style="font-size:.75rem;color:#718096;margin-left:6px">'+escHtml(g.orderId)+'</span>' : '';
    const totalQty = g.items.reduce(function(s,it){return s+it.quantity;},0);
    const rowIdxs = g.items.map(function(it){ return it.rowIndex; });
    const deleteBtn = '<button class="btn-action btn-delete" onclick="doDeleteGroup(['+rowIdxs.join(',')+'])">✕ 刪除整單</button>';
    const editBtn = '<button class="btn-action" style="background:#ebf8ff;color:#2b6cb0" onclick="showEditModal(\''+escHtml(g.orderId)+'\')">✏️ 修改</button>';
    let mainBtns;
    if (st==='待料') mainBtns = '<button class="btn-action btn-confirm" onclick="doArriveGroup(['+rowIdxs.join(',')+'])">📦 到貨</button>';
    else if (st==='已確認') mainBtns = '';
    else mainBtns = '<button class="btn-action btn-confirm" onclick="doConfirmGroup(['+rowIdxs.join(',')+'])">✓ 確認整單</button><button class="btn-action" style="background:#feebc8;color:#c05621" onclick="doPendingGroup(['+rowIdxs.join(',')+'])">🕓 待料</button>';
    return '<div class="order-item">' +
      '<div class="order-item-header"><span class="order-seq">#'+(groups.length-i)+'　'+escHtml(g.customerName)+idTag+'</span><span class="order-time">'+t+'　'+badge+'</span></div>' +
      g.items.map(itemLine).join('') +
      '<div class="order-qty" style="margin-top:8px">本單共 <strong>'+totalQty+' 片</strong></div>' +
      '<div class="order-actions">'+mainBtns+deleteBtn+editBtn+'</div>' +
    '</div>';
  }).join('');
}

// 分組狀態:任一列待料→待料;全部已確認→已確認;否則待確認
function groupStatus(g) {
  if (g.items.some(function(it){ return it.status==='待料'; })) return '待料';
  if (g.items.every(function(it){ return it.status==='已確認'; })) return '已確認';
  return '待確認';
}

// 切換「待料清單(跨日期)」與「日期檢視」
function togglePendingView() {
  adminPendingView = !adminPendingView;
  const btn = document.getElementById('admin-pending-btn');
  if (btn) btn.textContent = adminPendingView ? '← 返回日期檢視' : '🕓 待料清單';
  renderAdminOrders();
}

// 待料清單:不分日期,列出所有待料的單,每張可按「到貨」
function renderPendingOrders() {
  const pending = (allAdminOrders||[]).filter(function(o){ return String(o.status)==='待料'; });
  const listEl = document.getElementById('admin-orders-list');
  const summaryEl = document.getElementById('admin-summary-card');
  const noDataEl = document.getElementById('admin-no-orders');
  document.getElementById('admin-summary-date').textContent = '待料清單（跨日期）';
  if (!pending.length) {
    summaryEl.style.display='none';
    noDataEl.style.display='block'; noDataEl.textContent='目前沒有待料的訂單';
    listEl.innerHTML=''; return;
  }
  noDataEl.style.display='none'; summaryEl.style.display='flex';
  document.getElementById('admin-summary-total').textContent = pending.reduce(function(s,o){return s+o.quantity;},0);
  const groups = groupOrders(pending).reverse();
  listEl.innerHTML = groups.map(function(g,i){
    const t = (g.time||'').substring(0,16);
    const idTag = g.orderId ? '<span style="font-size:.75rem;color:#718096;margin-left:6px">'+escHtml(g.orderId)+'</span>' : '';
    const totalQty = g.items.reduce(function(s,it){return s+it.quantity;},0);
    const rowIdxs = g.items.map(function(it){ return it.rowIndex; });
    const arriveBtn = '<button class="btn-action btn-confirm" onclick="doArriveGroup(['+rowIdxs.join(',')+'])">📦 到貨</button>';
    const deleteBtn = '<button class="btn-action btn-delete" onclick="doDeleteGroup(['+rowIdxs.join(',')+'])">✕ 刪除整單</button>';
    const editBtn = '<button class="btn-action" style="background:#ebf8ff;color:#2b6cb0" onclick="showEditModal(\''+escHtml(g.orderId)+'\')">✏️ 修改</button>';
    return '<div class="order-item">' +
      '<div class="order-item-header"><span class="order-seq">#'+(groups.length-i)+'　'+escHtml(g.customerName)+idTag+'</span><span class="order-time">'+escHtml(t)+'　<span class="status-badge badge-waiting">待料</span></span></div>' +
      g.items.map(itemLine).join('') +
      '<div class="order-qty" style="margin-top:8px">本單共 <strong>'+totalQty+' 片</strong></div>' +
      '<div class="order-actions">'+arriveBtn+deleteBtn+editBtn+'</div>' +
    '</div>';
  }).join('');
}

async function doPendingGroup(rowIndexes) {
  const ok = await showConfirm('把這張訂單標成「待料」？（先不排進生產，等按到貨才排入）');
  if (!ok) return;
  loading(true);
  try {
    const res = await gasApi('setPending', { ...authData(), rows: rowIndexes });
    loading(false);
    if (res.success) { allAdminOrders = null; loadAllOrders(); }
    else showAlert('操作失敗');
  } catch(e) { loading(false); showAlert('連線失敗'); }
}

async function doArriveGroup(rowIndexes) {
  const ok = await showConfirm('確認「到貨」？這張會排進今天的生產。');
  if (!ok) return;
  loading(true);
  try {
    const res = await gasApi('markArrived', { ...authData(), rows: rowIndexes });
    loading(false);
    if (res.success) { allAdminOrders = null; loadAllOrders(); }
    else showAlert('操作失敗');
  } catch(e) { loading(false); showAlert('連線失敗'); }
}

function showEditModal(orderId) {
  const source = currentRole === 'admin' ? (allAdminOrders||[]) : (allOrders||[]);
  const items = source.filter(function(o){ return o.orderId === orderId; });
  if (!items.length) return;
  function unitLbl(v) { return parseFloat(v) < 150 ? '公分' : '尺'; }
  function eiColorControl(it) {
    const tc = (window.typeColorMap||[]).find(function(t){ return t.systemType === it.modelType; });
    const colors = (tc && tc.colors && tc.colors.length) ? tc.colors : null;
    if (colors) {
      const cur = String(it.color||'');
      const keep = colors.indexOf(cur) >= 0 ? cur : '';
      return '<select class="ei-color" style="width:100%;padding:8px 10px;border:1.5px solid #e2e8f0;border-radius:8px;font-size:.9rem">' +
        '<option value="">請選擇顏色</option>' +
        colors.map(function(c){ return '<option value="'+escHtml(c)+'"'+(c===keep?' selected':'')+'>'+escHtml(c)+'</option>'; }).join('') +
      '</select>';
    }
    return '<input class="ei-color" value="'+escHtml(String(it.color||''))+'" list="color-list" style="width:100%;padding:8px 10px;border:1.5px solid #e2e8f0;border-radius:8px;font-size:.9rem">';
  }
  function inp(cls, val, type) {
    type = type || 'text';
    return '<input class="'+cls+'" type="'+type+'" value="'+escHtml(String(val||''))+'" style="width:100%;padding:8px 10px;border:1.5px solid #e2e8f0;border-radius:8px;font-size:.9rem">';
  }
  const itemHtml = items.map(function(it, idx) {
    return '<div class="edit-item" data-row-index="'+it.rowIndex+'" style="border:1.5px solid #e2e8f0;border-radius:10px;padding:12px;margin-bottom:10px">' +
      (items.length > 1 ? '<div style="font-size:.78rem;font-weight:700;color:#a0aec0;margin-bottom:8px">第 '+(idx+1)+' 項</div>' : '') +
      '<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:8px">' +
        '<div><label style="font-size:.75rem;font-weight:700;color:#718096;display:block;margin-bottom:3px">型式</label>'+inp('ei-model', it.modelType)+'</div>' +
        '<div><label style="font-size:.75rem;font-weight:700;color:#718096;display:block;margin-bottom:3px">顏色</label>'+eiColorControl(it)+'</div>' +
      '</div>' +
      '<div style="display:grid;grid-template-columns:1fr 1fr 72px;gap:8px;margin-bottom:8px">' +
        '<div><label style="font-size:.75rem;font-weight:700;color:#718096;display:block;margin-bottom:3px">上寬 ('+unitLbl(it.topW)+')</label>'+inp('ei-topW', it.topW, 'number')+'</div>' +
        '<div><label style="font-size:.75rem;font-weight:700;color:#718096;display:block;margin-bottom:3px">高度 ('+unitLbl(it.height)+')</label>'+inp('ei-height', it.height, 'number')+'</div>' +
        '<div><label style="font-size:.75rem;font-weight:700;color:#718096;display:block;margin-bottom:3px">數量</label>'+inp('ei-qty', it.quantity, 'number')+'</div>' +
      '</div>' +
      (it.bottomW ? '<div style="margin-bottom:8px"><label style="font-size:.75rem;font-weight:700;color:#718096;display:block;margin-bottom:3px">下寬 ('+unitLbl(it.bottomW)+')</label>'+inp('ei-bottomW', it.bottomW, 'number')+'</div>' : '') +
      '<div><label style="font-size:.75rem;font-weight:700;color:#718096;display:block;margin-bottom:3px">備註</label>'+inp('ei-remark', normUnitsText(it.remark))+'</div>' +
    '</div>';
  }).join('');
  const overlay = document.createElement('div');
  overlay.id = 'edit-modal-overlay';
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:2000;display:flex;align-items:flex-end;justify-content:center';
  overlay.innerHTML = '<div style="background:#fff;border-radius:14px 14px 0 0;padding:20px 16px 32px;width:100%;max-width:520px;max-height:85vh;overflow-y:auto">' +
    '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px">' +
      '<div style="font-weight:800;color:#2d3748;font-size:1rem">✏️ 修改訂單</div>' +
      '<button onclick="closeEditModal()" style="background:none;border:none;font-size:1.3rem;cursor:pointer;color:#718096;line-height:1">✕</button>' +
    '</div>' +
    '<div id="edit-items-wrap">'+itemHtml+'</div>' +
    '<div style="display:flex;gap:10px;margin-top:14px">' +
      '<button onclick="closeEditModal()" style="flex:1;padding:12px;border:1.5px solid #3182ce;background:transparent;color:#3182ce;border-radius:9px;font-weight:700;cursor:pointer">取消</button>' +
      '<button onclick="doUpdateOrder()" style="flex:2;padding:12px;background:#3182ce;color:#fff;border:none;border-radius:9px;font-weight:700;cursor:pointer">💾 儲存</button>' +
    '</div>' +
  '</div>';
  document.body.appendChild(overlay);
}

function closeEditModal() {
  const el = document.getElementById('edit-modal-overlay');
  if (el) el.remove();
}

async function doUpdateOrder() {
  const itemEls = document.querySelectorAll('#edit-items-wrap .edit-item');
  const items = [];
  let valid = true;
  itemEls.forEach(function(el) {
    const rowIndex = parseInt(el.dataset.rowIndex);
    const modelRaw = el.querySelector('.ei-model').value.trim();
    const entry = (window.modelMap||[]).find(function(m){ return m.code === modelRaw; });
    const modelType = entry ? entry.systemType : modelRaw;
    const color = el.querySelector('.ei-color').value.trim();
    const topW = el.querySelector('.ei-topW').value.trim();
    const height = el.querySelector('.ei-height').value.trim();
    const qty = parseInt(el.querySelector('.ei-qty').value) || 0;
    const bottomWEl = el.querySelector('.ei-bottomW');
    const bottomW = bottomWEl ? bottomWEl.value.trim() : '';
    const remark = el.querySelector('.ei-remark').value.trim();
    if (!modelType || !color || !topW || !height || !qty) { valid = false; return; }
    items.push({ rowIndex, modelType, color, topW, bottomW, height, quantity: qty, remark });
  });
  if (!valid) { showAlert('有必填欄位未填'); return; }
  loading(true);
  try {
    const res = await gasApi('updateOrderItems', { ...authData(), items });
    loading(false);
    if (!res.success) { showAlert('儲存失敗：'+(res.error||'')); return; }
    closeEditModal();
    showAlert('修改已儲存！');
    if (currentRole === 'admin') { allAdminOrders = null; loadAllOrders(); }
    else { allOrders = null; loadOrders(); }
  } catch(e) { loading(false); showAlert('連線失敗'); }
}

async function doConfirmGroup(rowIndexes) {
  loading(true);
  try {
    const res = await gasApi('confirmOrders', { ...authData(), rows: rowIndexes });
    loading(false);
    if (res.success) { allAdminOrders = null; loadAllOrders(); }
    else showAlert('操作失敗');
  } catch(e) { loading(false); showAlert('連線失敗'); }
}

async function doDeleteGroup(rowIndexes) {
  const ok = await showConfirm('確定要刪除這筆訂單嗎？刪除後無法復原。');
  if (!ok) return;
  loading(true);
  try {
    const res = await gasApi('deleteOrders', { ...authData(), rows: rowIndexes });
    loading(false);
    if (res.success) { allAdminOrders = null; loadAllOrders(); }
    else showAlert('刪除失敗');
  } catch(e) { loading(false); showAlert('連線失敗'); }
}

async function exportDailyReport() {
  const dateStr = document.getElementById('admin-date').value;
  if (!dateStr) { showAlert('請先選擇日期'); return; }
  loading(true);
  try {
    const res = await gasApi('createDailyReport', { ...authData(), dateStr });
    loading(false);
    if (!res.success) { showAlert('匯出失敗：'+res.error); return; }
    showAlert('已建立 '+res.rocDate+' 日報（共 '+res.count+' 筆）\n\n點確定後開啟 Google 試算表', function(){ window.open(res.url,'_blank'); });
  } catch(e) { loading(false); showAlert('連線失敗'); }
}

// ══════════════════════════════════════════════
//  帳號管理
// ══════════════════════════════════════════════
function lastSeenText(ms) {
  var s = Math.floor(ms/1000);
  if (s < 60)  return s + ' 秒前';
  var m = Math.floor(s/60);
  if (m < 60)  return m + ' 分前';
  var h = Math.floor(m/60);
  if (h < 24)  return h + ' 小時前';
  return Math.floor(h/24) + ' 天前';
}
function presenceHtml(a) {
  var ms = a.lastSeen;
  if (ms == null || ms < 0) return '<span style="font-size:.72rem;color:#a0aec0;white-space:nowrap"><span style="color:#cbd5e0">●</span> 未上線</span>';
  var online = ms < 90000;
  return '<span style="font-size:.72rem;white-space:nowrap;color:'+(online?'#276749':'#a0aec0')+'">'+
    '<span style="color:'+(online?'#38a169':'#cbd5e0')+'">●</span> '+(online ? '在線' : lastSeenText(ms))+'</span>';
}
function startHeartbeat() {
  if (_hbTimer) clearInterval(_hbTimer);
  function ping() { if (currentUser) gasApi('heartbeat', authData()).catch(function(){}); }
  ping();
  _hbTimer = setInterval(ping, 45000);
}
async function loadProxyCustomers() {
  try {
    const list = await gasApi('getAllAccounts', authData());
    var names = [];
    (list||[]).forEach(function(a){ if (a.customerName && a.customerName !== currentCustomer && names.indexOf(a.customerName) === -1) names.push(a.customerName); });
    names.sort(function(a,b){ return mmCodeCmp(a,b); });
    var dl = document.getElementById('proxy-customer-list');
    if (!dl) return;
    dl.innerHTML = names.map(function(n){ return '<option value="'+escHtml(n)+'"></option>'; }).join('');
  } catch(e) {}
}
async function loadAccounts(silent) {
  if (!silent) loading(true);
  try {
    const list = await gasApi('getAllAccounts', authData());
    if (!silent) loading(false);
    const el = document.getElementById('accounts-list');
    if (!list.length) { el.innerHTML = '<p style="color:#a0aec0;text-align:center;padding:20px">目前無帳號資料</p>'; return; }
    el.innerHTML = list.map(function(a){
      const disabled = a.status==='停用';
      return '<div class="account-item'+(disabled?' account-disabled':'')+'">'+
        '<div class="account-info">'+
          '<div class="account-name">'+escHtml(a.customerName)+'　'+presenceHtml(a)+'</div>'+
          '<div class="account-meta">帳號：'+escHtml(a.username)+'　統編：'+escHtml(a.taxId)+'　狀態：'+a.status+'</div>'+
        '</div>'+
        '<div class="account-btns">'+
          '<button class="btn-action btn-confirm" onclick="doResetPwd('+a.rowIndex+')">重設密碼</button>'+
          '<button class="btn-action '+(disabled?'btn-confirm':'btn-delete')+'" onclick="doToggle('+a.rowIndex+')">'+
            (disabled?'啟用':'停用')+
          '</button>'+
        '</div>'+
      '</div>';
    }).join('');
  } catch(e) { if (!silent) { loading(false); showAlert('查詢失敗'); } }
}

async function doResetPwd(rowIndex) {
  const newPass = prompt('輸入新密碼（至少4碼）：');
  if (!newPass || newPass.length < 4) { if (newPass !== null) showAlert('密碼至少需要 4 個字元'); return; }
  loading(true);
  try {
    const res = await gasApi('resetAccountPassword', { ...authData(), rowIndex, newPass });
    loading(false);
    if (res.success) showAlert('密碼已重設');
    else showAlert('失敗：'+(res.error||''));
  } catch(e) { loading(false); showAlert('連線失敗'); }
}

async function doToggle(rowIndex) {
  loading(true);
  try {
    const res = await gasApi('toggleAccountStatus', { ...authData(), rowIndex });
    loading(false);
    if (res.success) loadAccounts();
    else showAlert('操作失敗');
  } catch(e) { loading(false); showAlert('連線失敗'); }
}

// ══════════════════════════════════════════════
//  訂單顯示工具
// ══════════════════════════════════════════════
function groupOrders(orders) {
  const groups = [];
  orders.forEach(function(o) {
    const last = groups[groups.length-1];
    if (last && last.orderId === o.orderId && last.time === o.time) {
      last.items.push(o);
    } else {
      groups.push({ orderId: o.orderId, time: o.time, customerName: o.customerName, items: [o] });
    }
  });
  return groups;
}

function parseHoleMm(spec, key) {
  const m = spec.match(new RegExp(key+'([\\d.]+)(公分|台分|台寸|尺|寸|分)'));
  if (!m) return 0;
  return unitToMm(parseFloat(m[1]), m[2]);
}
function holeRemarkSvg(remark, doorWmm, doorHmm) {
  if (!remark || remark.indexOf('【挖洞】') === -1) return '';
  const spec = remark.substring(remark.indexOf('【挖洞】'));
  const W = parseHoleMm(spec,'洞寬'), H = parseHoleMm(spec,'洞高');
  if (W<=0||H<=0) return '';
  const hasT = spec.indexOf('距高')!==-1, hasB = spec.indexOf('距底')!==-1;
  const hasL = spec.indexOf('距左')!==-1, hasR = spec.indexOf('距右')!==-1;
  const T = parseHoleMm(spec,'距高'), B = parseHoleMm(spec,'距底');
  const L = parseHoleMm(spec,'距左'), R = parseHoleMm(spec,'距右');
  // 門板實際大小（沒帶進來就用距離推算當後備）
  const doorW = (doorWmm>0 ? doorWmm : ((L+W+R)||W));
  const doorH = (doorHmm>0 ? doorHmm : ((B+H+T)||H));
  // 定位：有距左用距左、否則用距右；有距高用距高、否則用距底
  const leftMm = hasL ? L : (hasR ? (doorW - R - W) : 0);
  const topMm  = hasT ? T : (hasB ? (doorH - B - H) : 0);
  const MAX=70, scale=Math.min(MAX/doorW,MAX*1.5/doorH);
  const dw=+(doorW*scale).toFixed(2), dh=+(doorH*scale).toFixed(2);
  const hw=+Math.max(1,W*scale).toFixed(2), hh=+Math.max(1,H*scale).toFixed(2);
  const hx=+(leftMm*scale).toFixed(2), hy=+(topMm*scale).toFixed(2);
  return '<svg width="'+dw+'" height="'+dh+'" style="box-sizing:content-box;border:2px solid #2b6cb0;border-radius:3px;background:#ebf8ff;display:block;margin-top:6px">'+
    '<rect width="'+dw+'" height="'+dh+'" fill="#ebf8ff"/>'+
    '<rect x="'+hx+'" y="'+hy+'" width="'+hw+'" height="'+hh+'" fill="#fff" stroke="#e53e3e" stroke-width="1.5" stroke-dasharray="3,2"/>'+
    '</svg>';
}
function itemLine(it) {
  const wDisp = it.bottomW
    ? dimDisp(it.topW,150)+' / '+dimDisp(it.bottomW,150)+'（斜邊）'
    : dimDisp(it.topW,150);
  const idx = it.remark ? it.remark.indexOf('【挖洞】') : -1;
  const noteText = normUnitsText((idx>=0 ? it.remark.substring(0,idx) : (it.remark||'')).trim());
  const holeText = idx>=0 ? normUnitsText(it.remark.substring(idx).trim()) : '';
  const doorWmm = Math.max(unitToMm(it.topW, dimUnit(it.topW,150)), it.bottomW ? unitToMm(it.bottomW, dimUnit(it.bottomW,150)) : 0);
  const doorHmm = unitToMm(it.height, dimUnit(it.height,400));
  const holeSvg = holeRemarkSvg(it.remark||'', doorWmm, doorHmm);
  const modelDisp = (it.customerCode && it.customerCode !== it.modelType)
    ? it.customerCode + ' → ' + it.modelType : it.modelType;
  const proxyTag = it.placedBy ? '<span class="tag" style="background:#fefcbf;color:#744210">代下單</span>' : '';
  const dfCode = orderDoorFace(it);
  const dfSvg = dfCode ? '<div style="margin-top:6px">'+doorFaceSVG(dfCode, 72)+'</div>' : '';
  return '<div class="suborder">'+
    '<div class="order-detail"><span class="tag">'+escHtml(modelDisp)+'</span><span class="tag">'+escHtml(it.color)+'</span>'+proxyTag+'</div>'+
    '<div class="order-spec">寬 '+wDisp+'　高 '+dimDisp(it.height,400)+'　× <strong>'+it.quantity+' 片</strong>'+
      (noteText ? '　<span class="order-remark">備註：'+escHtml(noteText)+'</span>' : '')+
    '</div>'+
    (holeText ? '<div class="order-remark" style="margin-top:2px;color:#2b6cb0;line-height:1.6">'+escHtml(holeText)+'</div>' : '')+
    dfSvg+holeSvg+'</div>';
}

function escHtml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ══════════════════════════════════════════════
//  UI 工具
// ══════════════════════════════════════════════
let _loadingGuard = null;
function loading(on) {
  document.getElementById('loading').style.display = on ? 'flex' : 'none';
  if (_loadingGuard) { clearTimeout(_loadingGuard); _loadingGuard = null; }
  // 保險：萬一哪裡忘了關，轉圈最多 30 秒就自動收掉，不會卡死畫面
  if (on) _loadingGuard = setTimeout(function () {
    document.getElementById('loading').style.display = 'none';
  }, 30000);
}

function showAlert(msg) {
  return new Promise(function(resolve) {
    document.getElementById('modal-msg').textContent = msg;
    document.getElementById('modal-cancel').style.display = 'none';
    document.getElementById('modal-overlay').style.display = 'flex';
    modalResolve = function() {
      document.getElementById('modal-overlay').style.display = 'none';
      resolve(true);
    };
  });
}

function showConfirm(msg) {
  return new Promise(function(resolve) {
    document.getElementById('modal-msg').textContent = msg;
    document.getElementById('modal-cancel').style.display = 'inline-flex';
    document.getElementById('modal-overlay').style.display = 'flex';
    modalResolve = function(val) {
      document.getElementById('modal-overlay').style.display = 'none';
      resolve(val);
    };
  });
}

// ══════════════════════════════════════════════
//  型式對照
// ══════════════════════════════════════════════
function mmCodeCmp(a, b) {
  return String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: 'base' });
}
// 訂單頁自動完成排序：平永遠最前 → 自己廠商 → 通用 → 其他
function mmAutocompleteOrder(list) {
  function rank(m) {
    if (m.code === '平') return -1;
    var vs = m.vendors || [];
    if (currentUser && vs.indexOf(currentUser) !== -1) return 0;
    if (!vs.length) return 1;
    return 2;
  }
  return list.slice().sort(function(a, b) {
    var ra = rank(a), rb = rank(b);
    if (ra !== rb) return ra - rb;
    return mmCodeCmp(a.code, b.code);
  });
}
async function loadModelMap() {
  function apply(list) {
    window.modelMap = Array.isArray(list) ? list : [];
    const dl = document.getElementById('model-codes-list');
    if (dl) dl.innerHTML = mmAutocompleteOrder(window.modelMap).map(function(m){
      return '<option value="'+escHtml(m.code)+'"></option>';
    }).join('');
    renderModelMap();
  }
  const cached = cacheGet('anyi_modelMap');
  if (cached) apply(cached);                 // 先用快取瞬間顯示
  try {
    const res = await gasApi('getModelMap', authData());
    cacheSet('anyi_modelMap', res);
    apply(res);                              // 再用最新資料覆蓋
  } catch(e) {}
}
async function mmLoadAccounts() {
  if (window.mmAccounts && window.mmAccounts.length) { mmRenderVendorChecks(); return; }
  try {
    const list = await gasApi('getAllAccounts', authData());
    window.mmAccounts = Array.isArray(list) ? list : [];
    mmRenderVendorChecks();
    renderMmSavedList();
  } catch(e) {}
}
function mmVendorLabel(username) {
  var a = (window.mmAccounts || []).find(function(x){ return x.username === username; });
  return a ? a.customerName : username;
}
function mmRenderVendorChecks() {
  var wrap = document.getElementById('mm-form-vendors');
  if (!wrap) return;
  var accs = window.mmAccounts || [];
  if (!accs.length) { wrap.innerHTML = '<span style="font-size:.78rem;color:#a0aec0">（載入客戶帳號中…）</span>'; return; }
  var nameCount = {};
  accs.forEach(function(a){ nameCount[a.customerName] = (nameCount[a.customerName]||0) + 1; });
  wrap.innerHTML = accs.map(function(a){
    var label = nameCount[a.customerName] > 1 ? a.customerName+'（'+a.username+'）' : a.customerName;
    return '<label style="display:flex;align-items:center;gap:4px;font-size:.8rem;color:#4a5568;cursor:pointer;white-space:nowrap">'+
      '<input type="checkbox" value="'+escHtml(a.username)+'"> '+escHtml(label)+'</label>';
  }).join('');
}
function mmGetCheckedVendors() {
  var out = [];
  document.querySelectorAll('#mm-form-vendors input[type=checkbox]:checked').forEach(function(c){ out.push(c.value); });
  return out;
}
function mmSetCheckedVendors(vendors) {
  var set = {};
  (vendors||[]).forEach(function(v){ set[v] = 1; });
  document.querySelectorAll('#mm-form-vendors input[type=checkbox]').forEach(function(c){ c.checked = !!set[c.value]; });
}

// 依型式解出系統型式，若「型式顏色」有設限制 → 顏色欄換成純下拉；否則還原自由輸入
function typeColorsFor(modelVal) {
  const mapping = (window.modelMap||[]).find(function(m){ return m.code === modelVal; });
  const sysType = mapping ? mapping.systemType : modelVal;
  const tc = (window.typeColorMap||[]).find(function(t){ return t.systemType === sysType; });
  return (tc && tc.colors && tc.colors.length) ? tc.colors : null;
}
function applyColorRestriction(gid, modelVal) {
  const wrap = document.getElementById('g'+gid+'-color-wrap');
  if (!wrap) return;
  const colors = typeColorsFor(modelVal);
  const el = document.getElementById('g'+gid+'-color');
  const cur = el ? el.value : '';
  if (colors) {
    const sig = colors.join(',');
    if (el && el.tagName === 'SELECT' && wrap.dataset.colorSig === sig) return; // 已是相同下拉，免重建
    const keep = colors.indexOf(cur) >= 0 ? cur : '';
    wrap.innerHTML = '<select id="g'+gid+'-color">' +
      '<option value="">請選擇顏色</option>' +
      colors.map(function(c){ return '<option value="'+escHtml(c)+'"'+(c===keep?' selected':'')+'>'+escHtml(c)+'</option>'; }).join('') +
    '</select>';
    wrap.dataset.colorSig = sig;
  } else {
    if (el && el.tagName === 'INPUT') { delete wrap.dataset.colorSig; return; } // 已是輸入框，免重建
    wrap.innerHTML = '<input type="text" id="g'+gid+'-color" placeholder="如 P1" list="color-list" value="'+escHtml(cur)+'">';
    delete wrap.dataset.colorSig;
  }
}

function applyModelCode(gid, val) {
  const inp = document.getElementById('g'+gid+'-model');
  const presetEl = document.getElementById('g'+gid+'-preset-remark');
  const dfEl = document.getElementById('g'+gid+'-doorface');
  const mapping = (window.modelMap||[]).find(function(m){ return m.code === val; });
  // 依系統型式套用顏色限制（限制成純下拉）
  applyColorRestriction(gid, val);
  if (!mapping) {
    if (inp) { delete inp.dataset.systemCode; delete inp.dataset.presetRemark; }
    if (presetEl) presetEl.style.display = 'none';
    if (dfEl) { dfEl.style.display = 'none'; dfEl.innerHTML = ''; }
    return;
  }
  inp.dataset.systemCode = mapping.systemType;
  if (dfEl) {
    if (mapping.doorFace && DOOR_FACES[mapping.doorFace]) {
      dfEl.innerHTML = doorFaceSVG(mapping.doorFace, 120);
      dfEl.style.display = 'block';
    } else { dfEl.style.display = 'none'; dfEl.innerHTML = ''; }
  }
  // 預設備註：顯示給客戶看（唯讀），送單時自動合併（不塞進客戶備註欄）
  if (mapping.remark) {
    inp.dataset.presetRemark = mapping.remark;
    if (presetEl) { presetEl.textContent = '此型式備註：' + mapping.remark; presetEl.style.display = 'block'; }
  } else {
    delete inp.dataset.presetRemark;
    if (presetEl) presetEl.style.display = 'none';
  }
  // 預設顏色：顏色欄空白才帶入
  if (mapping.color) {
    const cEl = document.getElementById('g'+gid+'-color');
    if (cEl && !cEl.value) cEl.value = mapping.color;
  }
  const container = document.getElementById('sizes-'+gid);
  if (!container) return;
  container.querySelectorAll('.size-row').forEach(function(row) {
    const sid = parseInt(row.id.replace('size-',''));
    if (mapping.hole) {
      const holeChk = document.getElementById('s'+sid+'-hole');
      if (holeChk && !holeChk.checked) { holeChk.checked = true; toggleHole(sid); }
      applyHolePreset(sid, mapping);
    } else if (window.lockedHoles[sid]) {
      delete window.lockedHoles[sid];
      const chk = document.getElementById('s'+sid+'-hole');
      if (chk) { delete chk.dataset.locked; chk.checked = false; }
      const fw = document.getElementById('s'+sid+'-hole-fields-wrap');
      const ld = document.getElementById('s'+sid+'-hole-locked-display');
      if (fw) fw.style.display = '';
      if (ld) ld.style.display = 'none';
      toggleHole(sid);
    }
  });
}

function applyHolePreset(sid, mapping) {
  const holes = mapping.holes && mapping.holes.length ? mapping.holes : null;
  const chk = document.getElementById('s'+sid+'-hole');
  if (holes) {
    // 多洞或單洞（含 holes 陣列）：鎖定
    window.lockedHoles[sid] = holes;
    if (chk) { chk.dataset.locked = '1'; }
    const fieldsWrap = document.getElementById('s'+sid+'-hole-fields-wrap');
    const lockedDisp = document.getElementById('s'+sid+'-hole-locked-display');
    if (fieldsWrap) fieldsWrap.style.display = 'none';
    if (lockedDisp) lockedDisp.style.display = 'block';
    updateHolePreview(sid);
    return;
  }
  // 舊格式（無 holes 陣列）：可編輯
  delete window.lockedHoles[sid];
  if (chk) delete chk.dataset.locked;
  const fieldsWrap = document.getElementById('s'+sid+'-hole-fields-wrap');
  const lockedDisp = document.getElementById('s'+sid+'-hole-locked-display');
  if (fieldsWrap) fieldsWrap.style.display = '';
  if (lockedDisp) lockedDisp.style.display = 'none';
  function setF(key, valWithUnit) {
    const el = document.getElementById('s'+sid+'-hole'+key);
    const uEl = document.getElementById('s'+sid+'-hole'+key+'-u');
    if (!valWithUnit) {
      if (el) { el.value = ''; delete el.dataset.manual; el.classList.remove('hole-input-auto'); }
      return;
    }
    const m = valWithUnit.match(/^([\d.]+)(公分|台分|台寸|尺|寸|分)$/);
    if (!m) return;
    if (el) { el.value = m[1]; delete el.dataset.manual; el.classList.remove('hole-input-auto'); }
    if (uEl) uEl.value = unitValue(m[2]);
  }
  setF('B', mapping.distB); setF('T', mapping.distT);
  setF('L', mapping.distL); setF('R', mapping.distR);
  setF('W', mapping.holeW); setF('H', mapping.holeH);
  autoCalcHole(sid); updateHolePreview(sid);
}

// ── 型式對照 admin 管理 ──
function mmUnitSel(id, val) {
  function opt(u) { return '<option'+(val===u?' selected':'')+'>'+u+'</option>'; }
  return '<select id="'+escHtml(id)+'" onchange="mmUpdateMmPreview()" style="padding:5px 2px;border:1.5px solid #bee3f8;border-radius:5px;font-size:.78rem;color:#2b6cb0;background:#ebf8ff;flex-shrink:0">'+opt('寸')+opt('公分')+opt('尺')+'</select>';
}
function mmHoleFieldHtml(label, idx, key, val, unit) {
  var id = 'mm-h-'+idx+'-'+key;
  return '<div style="display:flex;flex-direction:column;gap:2px;flex:0 0 calc(50% - 4px)">' +
    '<label style="font-size:.72rem;color:#2b6cb0">'+label+'</label>' +
    '<div style="display:flex;gap:3px">' +
      '<input id="'+escHtml(id)+'" type="number" step="0.1" min="0" placeholder="0" value="'+escHtml(val||'')+'" oninput="mmUpdateMmPreview()" style="flex:1;min-width:0;padding:7px 8px;border:1.5px solid #bee3f8;border-radius:5px;font-size:.82rem">' +
      mmUnitSel(id+'-u', unit||'寸') +
    '</div>' +
  '</div>';
}
function mmRenderHoleForm() {
  var wrap = document.getElementById('mm-holes-wrap');
  if (!wrap) return;
  var html = '';
  for (var i = 0; i < window.mmFormHoles.length; i++) {
    var h = window.mmFormHoles[i];
    if (i > 0) {
      var gid = 'mm-h-'+i+'-gap';
      html += '<div style="display:flex;align-items:center;gap:6px;margin:8px 0">' +
        '<div style="flex:1;border-top:1px dashed #bee3f8"></div>' +
        '<span style="font-size:.75rem;color:#718096;white-space:nowrap">洞距</span>' +
        '<input id="'+escHtml(gid)+'" type="number" step="0.1" min="0" placeholder="0" value="'+escHtml(h.gap||'')+'" oninput="mmUpdateMmPreview()" style="width:60px;padding:5px 6px;border:1.5px solid #bee3f8;border-radius:5px;font-size:.82rem">' +
        mmUnitSel(gid+'-u', h.gap_u||'寸') +
        '<div style="flex:1;border-top:1px dashed #bee3f8"></div>' +
      '</div>';
    }
    html += '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">' +
      '<span style="font-size:.78rem;font-weight:700;color:#2b6cb0">洞 '+(i+1)+'</span>' +
      (window.mmFormHoles.length > 1 ? '<button onclick="mmRemoveHoleRow('+i+')" style="background:transparent;border:1px solid #e53e3e;color:#e53e3e;border-radius:4px;padding:2px 7px;font-size:.75rem;cursor:pointer">✕</button>' : '') +
    '</div>';
    if (i === 0) {
      html += '<div style="display:flex;gap:16px;margin-bottom:6px">' +
        '<label style="display:flex;align-items:center;gap:4px;font-size:.78rem;color:#2b6cb0;cursor:pointer"><input type="checkbox" id="mm-center-h"'+(h.centerH?' checked':'')+' onchange="mmToggleCenter()"> 左右置中</label>' +
        '<label style="display:flex;align-items:center;gap:4px;font-size:.78rem;color:#2b6cb0;cursor:pointer"><input type="checkbox" id="mm-center-v"'+(h.centerV?' checked':'')+' onchange="mmToggleCenter()"> 上下置中</label>' +
      '</div>';
    }
    html += '<div style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:6px">';
    if (i === 0) {
      if (!h.centerV) html += mmHoleFieldHtml('距高', i, 'distT', h.distT||'', h.distT_u||'寸');
      if (!h.centerH) html += mmHoleFieldHtml('距左', i, 'distL', h.distL||'', h.distL_u||'寸');
    }
    html += mmHoleFieldHtml('洞寬', i, 'holeW', h.holeW||'', h.holeW_u||'寸');
    html += mmHoleFieldHtml('洞高', i, 'holeH', h.holeH||'', h.holeH_u||'寸');
    html += '</div>';
  }
  wrap.innerHTML = html;
}
function mmSaveHoleFormValues() {
  function setIf(idx, field, id) {
    var e = document.getElementById(id);
    if (e) {
      window.mmFormHoles[idx][field] = e.value.trim();
      var u = document.getElementById(id+'-u');
      if (u) window.mmFormHoles[idx][field+'_u'] = u.value;
    }
  }
  for (var i = 0; i < window.mmFormHoles.length; i++) {
    if (i===0) {
      var ch = document.getElementById('mm-center-h'), cv = document.getElementById('mm-center-v');
      if (ch) window.mmFormHoles[0].centerH = ch.checked;
      if (cv) window.mmFormHoles[0].centerV = cv.checked;
      setIf(0,'distT','mm-h-0-distT');
      setIf(0,'distL','mm-h-0-distL');
    } else {
      setIf(i,'gap','mm-h-'+i+'-gap');
    }
    setIf(i,'holeW','mm-h-'+i+'-holeW');
    setIf(i,'holeH','mm-h-'+i+'-holeH');
  }
}
function mmToggleCenter() {
  mmSaveHoleFormValues();
  mmRenderHoleForm();
  mmUpdateMmPreview();
}
function mmUpdateMmPreview() {
  var box = document.getElementById('mm-hole-preview');
  if (!box) return;
  function gv(id) { var e=document.getElementById(id); return e?e.value.trim():''; }
  var refW = gv('mm-ref-w'), refWu = gv('mm-ref-w-u')||'寸';
  var refH = gv('mm-ref-h'), refHu = gv('mm-ref-h-u')||'寸';
  var dW = unitToMm(parseFloat(refW)||0, refWu.replace('台',''));
  var dH = unitToMm(parseFloat(refH)||0, refHu.replace('台',''));
  if (!dW||!dH) { box.innerHTML='<div class="hole-note">填入參考門寬/門高即可預覽</div>'; return; }
  var holes = mmHolesFromForm();
  var computed = calcHolesLayout(holes, dW, dH);
  box.innerHTML = drawHolesSVG(dW, dH, computed, 100, 180);
}
function mmAddHoleRow() {
  mmSaveHoleFormValues();
  window.mmFormHoles.push({gap:'', gap_u:'寸', holeW:'', holeW_u:'寸', holeH:'', holeH_u:'寸'});
  mmRenderHoleForm();
  mmUpdateMmPreview();
}
function mmRemoveHoleRow(i) {
  mmSaveHoleFormValues();
  window.mmFormHoles.splice(i, 1);
  mmRenderHoleForm();
  mmUpdateMmPreview();
}
function renderModelMap() {
  const list = document.getElementById('modelmap-list');
  if (!list) return;
  window.mmEditIndex = -1;
  list.innerHTML =
    '<div style="border:1.5px solid #bee3f8;border-radius:8px;padding:12px;background:#ebf8ff;margin-bottom:14px">' +
      '<div style="font-size:.8rem;font-weight:700;color:#2b6cb0;margin-bottom:8px">新增對照</div>' +
      '<div style="display:flex;gap:8px;margin-bottom:8px;align-items:center">' +
        '<input id="mm-form-code" placeholder="客戶代碼（如 378-2）" style="flex:1;min-width:0;padding:7px 10px;border:1.5px solid #bee3f8;border-radius:7px;font-size:.88rem">' +
        '<span style="color:#a0aec0;flex-shrink:0">→</span>' +
        '<input id="mm-form-type" placeholder="系統型式（如 103）" style="flex:1;min-width:0;padding:7px 10px;border:1.5px solid #bee3f8;border-radius:7px;font-size:.88rem">' +
      '</div>' +
      '<div style="display:flex;gap:8px;margin-bottom:8px;align-items:center">' +
        '<input id="mm-form-remark" placeholder="自動帶入備註（選填）" style="flex:1;min-width:0;padding:7px 10px;border:1.5px solid #bee3f8;border-radius:7px;font-size:.88rem">' +
        '<label style="display:flex;align-items:center;gap:5px;font-size:.85rem;white-space:nowrap;color:#2b6cb0;cursor:pointer"><input type="checkbox" id="mm-form-hole" onchange="mmToggleFormHole(this.checked)"> 挖洞</label>' +
      '</div>' +
      '<div style="display:flex;gap:8px;margin-bottom:8px;align-items:center">' +
        '<input id="mm-form-color" placeholder="自動帶入顏色（選填）" list="color-list" style="flex:1;min-width:0;padding:7px 10px;border:1.5px solid #bee3f8;border-radius:7px;font-size:.88rem">' +
        '<span style="color:#a0aec0;flex-shrink:0">＋</span>' +
        '<input id="mm-form-color2" placeholder="第二顏色（選填）" list="color-list" style="flex:1;min-width:0;padding:7px 10px;border:1.5px solid #bee3f8;border-radius:7px;font-size:.88rem">' +
      '</div>' +
      '<div style="display:flex;gap:8px;margin-bottom:8px;align-items:center">' +
        '<span style="font-size:.85rem;color:#2b6cb0;white-space:nowrap">門型示意</span>' +
        '<select id="mm-form-doorface" onchange="mmUpdateDoorFacePreview()" style="flex:1;min-width:0;padding:7px 10px;border:1.5px solid #bee3f8;border-radius:7px;font-size:.88rem">'+doorFaceOptions('')+'</select>' +
        '<div id="mm-doorface-preview" style="flex-shrink:0"></div>' +
      '</div>' +
      '<div id="mm-form-hole-section" style="display:none">' +
        '<div style="display:flex;gap:8px;align-items:center;margin-bottom:10px;flex-wrap:wrap">' +
          '<span style="font-size:.75rem;color:#718096;white-space:nowrap">參考門寬</span>' +
          '<input id="mm-ref-w" type="number" step="0.1" min="0" placeholder="0" oninput="mmUpdateMmPreview()" style="width:70px;padding:6px 8px;border:1.5px solid #bee3f8;border-radius:5px;font-size:.82rem">' +
          mmUnitSel('mm-ref-w-u','尺') +
          '<span style="font-size:.75rem;color:#718096;white-space:nowrap">門高</span>' +
          '<input id="mm-ref-h" type="number" step="0.1" min="0" placeholder="0" oninput="mmUpdateMmPreview()" style="width:70px;padding:6px 8px;border:1.5px solid #bee3f8;border-radius:5px;font-size:.82rem">' +
          mmUnitSel('mm-ref-h-u','尺') +
        '</div>' +
        '<div style="display:flex;gap:12px;align-items:flex-start">' +
          '<div style="flex:1;min-width:0">' +
            '<div id="mm-holes-wrap"></div>' +
            '<button onclick="mmAddHoleRow()" style="margin-top:6px;padding:5px 14px;background:transparent;border:1.5px solid #2b6cb0;color:#2b6cb0;border-radius:6px;font-size:.82rem;cursor:pointer">＋ 新增洞</button>' +
          '</div>' +
          '<div id="mm-hole-preview" style="flex-shrink:0;min-width:60px;text-align:center"></div>' +
        '</div>' +
      '</div>' +
      '<div style="margin-bottom:10px">' +
        '<div style="font-size:.78rem;color:#2b6cb0;font-weight:700;margin-bottom:5px">指定廠商（不勾＝通用，所有人可見）</div>' +
        '<div id="mm-form-vendors" style="display:flex;flex-wrap:wrap;gap:6px 14px;max-height:120px;overflow-y:auto;padding:7px 8px;border:1.5px solid #bee3f8;border-radius:6px;background:#fff"></div>' +
      '</div>' +
      '<div style="display:flex;gap:8px;margin-top:10px">' +
        '<button id="mm-add-btn" onclick="mmAddFromForm()" style="padding:7px 18px;background:#2b6cb0;color:#fff;border:none;border-radius:7px;font-size:.88rem;font-weight:700;cursor:pointer">＋ 加入清單</button>' +
        '<button id="mm-cancel-btn" onclick="mmCancelEdit()" style="display:none;padding:7px 18px;background:transparent;border:1.5px solid #a0aec0;color:#718096;border-radius:7px;font-size:.88rem;font-weight:700;cursor:pointer">取消</button>' +
      '</div>' +
    '</div>' +
    '<div style="font-size:.8rem;font-weight:700;color:#4a5568;margin-bottom:6px">已加入的對照</div>' +
    '<div id="mm-saved-list"></div>';
  renderMmSavedList();
  if (currentRole === 'admin') mmLoadAccounts();
}
function mmResetForm() {
  document.getElementById('mm-form-code').value='';
  document.getElementById('mm-form-type').value='';
  document.getElementById('mm-form-remark').value='';
  document.getElementById('mm-form-color').value='';
  document.getElementById('mm-form-color2').value='';
  document.getElementById('mm-form-doorface').value=''; mmUpdateDoorFacePreview();
  document.getElementById('mm-form-hole').checked = false;
  window.mmFormHoles = [];
  window.mmEditIndex = -1;
  mmToggleFormHole(false);
  mmSetCheckedVendors([]);
  const addBtn = document.getElementById('mm-add-btn');
  if (addBtn) addBtn.textContent = '＋ 加入清單';
  const cancelBtn = document.getElementById('mm-cancel-btn');
  if (cancelBtn) cancelBtn.style.display = 'none';
}
function mmCancelEdit() { mmResetForm(); }
function mmToggleFormHole(checked) {
  var d = document.getElementById('mm-form-hole-section');
  if (!d) return;
  d.style.display = checked ? 'block' : 'none';
  if (checked && window.mmFormHoles.length === 0) {
    window.mmFormHoles = [{distT:'', distT_u:'寸', distL:'', distL_u:'寸', holeW:'', holeW_u:'寸', holeH:'', holeH_u:'寸'}];
    mmRenderHoleForm();
    mmUpdateMmPreview();
  }
}
function mmHolesFromForm() {
  mmSaveHoleFormValues();
  return window.mmFormHoles.map(function(h, i) {
    var obj = {
      holeW: (h.holeW||'')+(h.holeW_u||'寸'),
      holeH: (h.holeH||'')+(h.holeH_u||'寸')
    };
    if (i===0) {
      obj.centerH = !!h.centerH;
      obj.centerV = !!h.centerV;
      obj.distT = h.centerV ? '' : (h.distT||'')+(h.distT_u||'寸');
      obj.distL = h.centerH ? '' : (h.distL||'')+(h.distL_u||'寸');
    } else {
      obj.gap = (h.gap||'')+(h.gap_u||'寸');
    }
    return obj;
  });
}
function mmAddFromForm() {
  const code = (document.getElementById('mm-form-code').value || '').trim();
  const type = (document.getElementById('mm-form-type').value || '').trim();
  if (!code || !type) { showAlert('請填寫客戶代碼和系統型式'); return; }
  const hole = document.getElementById('mm-form-hole').checked;
  function fv(id) { const el = document.getElementById(id); return el ? el.value.trim() : ''; }
  const holes = hole ? mmHolesFromForm() : [];
  const c1 = fv('mm-form-color'), c2 = fv('mm-form-color2');
  const color = (c1 && c2) ? (c1 + '／' + c2) : (c1 || c2);
  const entry = { code: code, systemType: type, remark: fv('mm-form-remark'), color: color, doorFace: fv('mm-form-doorface'), hole: hole, holes: holes, vendors: mmGetCheckedVendors() };
  if (window.mmEditIndex >= 0) { window.modelMap[window.mmEditIndex] = entry; }
  else { window.modelMap.push(entry); }
  renderMmSavedList();
  mmResetForm();
}
function mmRowHtml(m, i) {
  var holeTag = '';
  if (m.hole && m.holes && m.holes.length) {
    var summary = m.holes.map(function(h, hi) {
      var parts = [];
      if (hi===0&&h.distT) parts.push('距高'+mmDispUnit(h.distT));
      if (hi===0&&h.distL) parts.push('距左'+mmDispUnit(h.distL));
      if (hi>0&&h.gap) parts.push('洞距'+mmDispUnit(h.gap));
      if (h.holeW) parts.push('洞寬'+mmDispUnit(h.holeW));
      if (h.holeH) parts.push('洞高'+mmDispUnit(h.holeH));
      return '洞'+(hi+1)+' '+parts.join(' ');
    }).join('　');
    holeTag = '<span style="font-size:.72rem;color:#2b6cb0;background:#ebf8ff;padding:2px 6px;border-radius:4px;white-space:nowrap;max-width:280px;overflow:hidden;text-overflow:ellipsis;display:inline-block">挖洞 <span style="color:#4a5568;font-weight:400">'+escHtml(summary)+'</span></span>';
  } else if (m.hole) {
    holeTag = '<span style="font-size:.75rem;color:#2b6cb0;background:#ebf8ff;padding:2px 6px;border-radius:4px;white-space:nowrap">挖洞</span>';
  }
  return '<div style="display:flex;align-items:center;gap:8px;padding:9px 12px;border:1.5px solid #e2e8f0;border-radius:8px;background:#fff;margin-bottom:6px">' +
    '<span style="font-weight:700;color:#2d3748;font-size:.9rem">' + escHtml(m.code) + '</span>' +
    '<span style="color:#a0aec0;font-size:.8rem">→</span>' +
    '<span style="font-weight:700;color:#2b6cb0;font-size:.9rem">' + escHtml(m.systemType) + '</span>' +
    (m.remark ? '<span style="flex:1;color:#718096;font-size:.82rem;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + escHtml(m.remark) + '</span>' : '<span style="flex:1"></span>') +
    (m.color ? '<span style="font-size:.72rem;color:#805ad5;background:#faf5ff;padding:2px 6px;border-radius:4px;white-space:nowrap">'+escHtml(m.color)+'</span>' : '') +
    (m.doorFace ? '<span style="font-size:.72rem;color:#744210;background:#fffbea;padding:2px 6px;border-radius:4px;white-space:nowrap">門型:'+escHtml(doorFaceName(m.doorFace))+'</span>' : '') +
    holeTag +
    '<button onclick="mmEdit(' + i + ')" style="background:transparent;border:1px solid #3182ce;color:#3182ce;border-radius:5px;padding:3px 8px;font-size:.78rem;cursor:pointer;flex-shrink:0">✎</button>' +
    '<button onclick="mmDel(' + i + ')" style="background:transparent;border:1px solid #e53e3e;color:#e53e3e;border-radius:5px;padding:3px 8px;font-size:.78rem;cursor:pointer;flex-shrink:0">✕</button>' +
  '</div>';
}
function mmGroupHeader(text) {
  return '<div style="font-size:.78rem;font-weight:700;color:#2b6cb0;margin:10px 0 6px;padding-bottom:3px;border-bottom:1.5px solid #bee3f8">' + escHtml(text) + '</div>';
}
function renderMmSavedList() {
  const el = document.getElementById('mm-saved-list');
  if (!el) return;
  if (!window.modelMap.length) {
    el.innerHTML = '<p style="color:#a0aec0;text-align:center;padding:14px 0;font-size:.85rem">尚無資料</p>';
    return;
  }
  // 分組：通用（沒勾廠商）最上，其餘每個廠商一區（綁多廠商者出現在每區）
  var generic = [], vendorOrder = [], vendorGroups = {};
  window.modelMap.forEach(function(m, idx) {
    var vs = m.vendors || [];
    if (!vs.length) { generic.push({ m: m, i: idx }); return; }
    vs.forEach(function(u) {
      if (!vendorGroups[u]) { vendorGroups[u] = []; vendorOrder.push(u); }
      vendorGroups[u].push({ m: m, i: idx });
    });
  });
  function genericCmp(a, b) {
    var af = a.m.code==='平'?0:1, bf = b.m.code==='平'?0:1;
    if (af !== bf) return af - bf;
    return mmCodeCmp(a.m.code, b.m.code);
  }
  function codeCmp(a, b) { return mmCodeCmp(a.m.code, b.m.code); }
  vendorOrder.sort(function(a, b){ return mmCodeCmp(mmVendorLabel(a), mmVendorLabel(b)); });
  var html = '';
  if (generic.length) {
    html += mmGroupHeader('通用（所有人可見）');
    html += generic.sort(genericCmp).map(function(o){ return mmRowHtml(o.m, o.i); }).join('');
  }
  vendorOrder.forEach(function(u) {
    html += mmGroupHeader(mmVendorLabel(u));
    html += vendorGroups[u].sort(codeCmp).map(function(o){ return mmRowHtml(o.m, o.i); }).join('');
  });
  el.innerHTML = html;
}
function mmDel(i) {
  window.modelMap.splice(i, 1);
  if (window.mmEditIndex >= 0) mmResetForm();
  renderMmSavedList();
}
function mmEdit(i) {
  const m = window.modelMap[i];
  window.mmEditIndex = i;
  function setEl(id, val) { const el = document.getElementById(id); if (el) el.value = val || ''; }
  setEl('mm-form-code', m.code);
  setEl('mm-form-type', m.systemType);
  setEl('mm-form-remark', m.remark || '');
  var _colorParts = String(m.color || '').split('／');
  setEl('mm-form-color', _colorParts[0] || '');
  setEl('mm-form-color2', _colorParts[1] || '');
  setEl('mm-form-doorface', m.doorFace || ''); mmUpdateDoorFacePreview();
  mmSetCheckedVendors(m.vendors || []);
  const holeChk = document.getElementById('mm-form-hole');
  if (holeChk) holeChk.checked = !!m.hole;
  window.mmFormHoles = [];
  if (m.hole && m.holes && m.holes.length) {
    window.mmFormHoles = m.holes.map(function(h, idx) {
      function parseVU(val, defU) {
        var mt = val ? val.match(/^([\d.]+)(公分|台分|台寸|尺|寸|分)$/) : null;
        return mt ? {v: mt[1], u: unitLabel(mt[2])} : {v: '', u: defU||'寸'};
      }
      var obj = {};
      var hw = parseVU(h.holeW,'寸'), hh = parseVU(h.holeH,'寸');
      obj.holeW=hw.v; obj.holeW_u=hw.u; obj.holeH=hh.v; obj.holeH_u=hh.u;
      if (idx===0) {
        obj.centerH = !!h.centerH; obj.centerV = !!h.centerV;
        var dt=parseVU(h.distT,'寸'), dl=parseVU(h.distL,'寸');
        obj.distT=dt.v; obj.distT_u=dt.u; obj.distL=dl.v; obj.distL_u=dl.u;
      } else {
        var gp=parseVU(h.gap,'寸'); obj.gap=gp.v; obj.gap_u=gp.u;
      }
      return obj;
    });
    mmToggleFormHole(true);
    mmRenderHoleForm();
    mmUpdateMmPreview();
  } else {
    mmToggleFormHole(!!m.hole);
  }
  renderMmSavedList();
  const addBtn = document.getElementById('mm-add-btn');
  if (addBtn) addBtn.textContent = '💾 更新';
  const cancelBtn = document.getElementById('mm-cancel-btn');
  if (cancelBtn) cancelBtn.style.display = 'inline-block';
  const formEl = document.getElementById('mm-form-code');
  if (formEl) formEl.focus();
}
async function doSaveModelMap() {
  loading(true);
  try {
    const res = await gasApi('saveModelMap', Object.assign(authData(), { rows: window.modelMap }));
    loading(false);
    if (res.success) { showAlert('儲存成功！'); loadModelMap(); }
    else showAlert('儲存失敗：'+(res.error||''));
  } catch(e) { loading(false); showAlert('連線失敗'); }
}

// ══ 顏色清單 ══
window.colorList = [];
async function loadColorList() {
  function apply(list) {
    window.colorList = Array.isArray(list) ? list : [];
    const dl = document.getElementById('color-list');
    if (dl) dl.innerHTML = window.colorList.map(function(c){ return '<option value="'+escHtml(c)+'">'; }).join('');
    renderColorList();
    if (typeof renderTypeColors === 'function') renderTypeColors();  // 顏色清單變動 → 勾選框同步
  }
  const cached = cacheGet('anyi_colorList');
  if (cached) apply(cached);                 // 先用快取瞬間顯示
  try {
    const res = await gasApi('getColorList', authData());
    cacheSet('anyi_colorList', res);
    apply(res);                              // 再用最新資料覆蓋
  } catch(e) {}
}
function renderColorList() {
  const list = document.getElementById('colorlist-list');
  if (!list) return;
  list.innerHTML =
    '<div style="display:flex;gap:8px;margin-bottom:12px;align-items:center">' +
      '<input id="cl-form-name" placeholder="顏色名稱（如 白橡木）" style="flex:1;padding:7px 10px;border:1.5px solid #bee3f8;border-radius:7px;font-size:.88rem;background:#ebf8ff">' +
      '<button onclick="clAdd()" style="padding:7px 16px;background:#2b6cb0;color:#fff;border:none;border-radius:7px;font-size:.88rem;font-weight:700;cursor:pointer;white-space:nowrap">＋ 加入</button>' +
    '</div>' +
    '<div style="font-size:.8rem;font-weight:700;color:#4a5568;margin-bottom:6px">已加入的顏色</div>' +
    '<div id="cl-saved-list"></div>';
  renderClSavedList();
}
function clAdd() {
  const inp = document.getElementById('cl-form-name');
  const val = (inp ? inp.value : '').trim();
  if (!val) { showAlert('請填寫顏色名稱'); return; }
  if (window.colorList.indexOf(val) >= 0) { showAlert('已有這個顏色'); return; }
  window.colorList.push(val);
  renderClSavedList();
  if (inp) inp.value = '';
}
function renderClSavedList() {
  const el = document.getElementById('cl-saved-list');
  if (!el) return;
  if (!window.colorList.length) {
    el.innerHTML = '<p style="color:#a0aec0;text-align:center;padding:12px 0;font-size:.85rem">尚無顏色</p>';
    return;
  }
  el.innerHTML = window.colorList.map(function(c, i) {
    return '<div style="display:flex;align-items:center;gap:8px;padding:8px 12px;border:1.5px solid #e2e8f0;border-radius:8px;background:#fff;margin-bottom:6px">' +
      '<span style="flex:1;font-size:.9rem;color:#2d3748">' + escHtml(c) + '</span>' +
      '<button onclick="clDel('+i+')" style="background:transparent;border:1px solid #e53e3e;color:#e53e3e;border-radius:5px;padding:3px 8px;font-size:.78rem;cursor:pointer">✕</button>' +
    '</div>';
  }).join('');
}
function clDel(i) { window.colorList.splice(i, 1); renderClSavedList(); }
async function doSaveColorList() {
  loading(true);
  try {
    const res = await gasApi('saveColorList', Object.assign(authData(), { colors: window.colorList }));
    loading(false);
    if (res.success) {
      const dl = document.getElementById('color-list');
      if (dl) dl.innerHTML = window.colorList.map(function(c){ return '<option value="'+escHtml(c)+'">'; }).join('');
      showAlert('儲存成功！');
      loadColorList();
    } else showAlert('儲存失敗：'+(res.error||''));
  } catch(e) { loading(false); showAlert('連線失敗'); }
}

// ══ 型式顏色限制 ══
window.typeColorMap = [];
window.tcEditIndex = -1;
async function loadTypeColors() {
  const cached = cacheGet('anyi_typeColors');
  if (cached) { window.typeColorMap = cached; renderTypeColors(); }   // 先用快取瞬間顯示
  try {
    const res = await gasApi('getTypeColors', authData());
    window.typeColorMap = Array.isArray(res) ? res : [];
    cacheSet('anyi_typeColors', window.typeColorMap);
    renderTypeColors();                      // 再用最新資料覆蓋
  } catch(e) {}
}
function tcColorChecks(selected) {
  selected = selected || [];
  var opts = (window.colorList||[]).slice();
  selected.forEach(function(c){ if (opts.indexOf(c) < 0) opts.push(c); }); // 含清單外的舊資料
  if (!opts.length) return '<span style="font-size:.82rem;color:#a0aec0">請先到「顏色清單管理」新增顏色</span>';
  return opts.map(function(c){
    var on = selected.indexOf(c) >= 0;
    return '<label style="display:flex;align-items:center;gap:5px;font-size:.85rem;color:#4a5568;cursor:pointer;white-space:nowrap">'+
      '<input type="checkbox" class="tc-form-color" value="'+escHtml(c)+'"'+(on?' checked':'')+' style="width:16px;height:16px;accent-color:#3182ce;cursor:pointer">'+escHtml(c)+'</label>';
  }).join('');
}
function renderTypeColors() {
  const list = document.getElementById('typecolor-list');
  if (!list) return;
  const editing = window.tcEditIndex >= 0 ? window.typeColorMap[window.tcEditIndex] : null;
  list.innerHTML =
    '<div style="border:1.5px solid #bee3f8;border-radius:8px;padding:12px;background:#ebf8ff;margin-bottom:14px">' +
      '<div style="font-size:.8rem;font-weight:700;color:#2b6cb0;margin-bottom:8px">'+(editing?'修改限制':'新增限制')+'</div>' +
      '<div style="display:flex;gap:8px;margin-bottom:8px;align-items:center">' +
        '<span style="font-size:.85rem;color:#2b6cb0;white-space:nowrap">系統型式</span>' +
        '<input id="tc-form-type" placeholder="如 101" value="'+escHtml(editing?editing.systemType:'')+'" style="flex:1;min-width:0;padding:7px 10px;border:1.5px solid #bee3f8;border-radius:7px;font-size:.88rem">' +
      '</div>' +
      '<div style="font-size:.78rem;color:#2b6cb0;font-weight:700;margin:6px 0 5px">允許顏色（勾選）</div>' +
      '<div style="display:flex;flex-wrap:wrap;gap:6px 14px;padding:7px 8px;border:1.5px solid #bee3f8;border-radius:6px;background:#fff">'+tcColorChecks(editing?editing.colors:[])+'</div>' +
      '<div style="display:flex;gap:8px;margin-top:10px">' +
        '<button onclick="tcAddFromForm()" style="padding:7px 18px;background:#2b6cb0;color:#fff;border:none;border-radius:7px;font-size:.88rem;font-weight:700;cursor:pointer">'+(editing?'✓ 更新':'＋ 加入清單')+'</button>' +
        (editing?'<button onclick="tcCancelEdit()" style="padding:7px 18px;background:transparent;border:1.5px solid #a0aec0;color:#718096;border-radius:7px;font-size:.88rem;font-weight:700;cursor:pointer">取消</button>':'') +
      '</div>' +
    '</div>' +
    '<div style="font-size:.8rem;font-weight:700;color:#4a5568;margin-bottom:6px">已設定的型式</div>' +
    '<div id="tc-saved-list"></div>';
  renderTcSavedList();
}
function renderTcSavedList() {
  const el = document.getElementById('tc-saved-list');
  if (!el) return;
  if (!window.typeColorMap.length) {
    el.innerHTML = '<p style="color:#a0aec0;text-align:center;padding:12px 0;font-size:.85rem">尚無設定</p>';
    return;
  }
  el.innerHTML = window.typeColorMap.map(function(t, i) {
    return '<div style="display:flex;align-items:center;gap:8px;padding:9px 12px;border:1.5px solid #e2e8f0;border-radius:8px;background:#fff;margin-bottom:6px">' +
      '<span style="font-weight:700;color:#2b6cb0;font-size:.9rem;white-space:nowrap">' + escHtml(t.systemType) + '</span>' +
      '<span style="color:#a0aec0;font-size:.8rem">→</span>' +
      '<span style="flex:1;color:#4a5568;font-size:.85rem">' + escHtml((t.colors||[]).join('、')) + '</span>' +
      '<button onclick="tcEdit(' + i + ')" style="background:transparent;border:1px solid #3182ce;color:#3182ce;border-radius:5px;padding:3px 8px;font-size:.78rem;cursor:pointer;flex-shrink:0">✎</button>' +
      '<button onclick="tcDel(' + i + ')" style="background:transparent;border:1px solid #e53e3e;color:#e53e3e;border-radius:5px;padding:3px 8px;font-size:.78rem;cursor:pointer;flex-shrink:0">✕</button>' +
    '</div>';
  }).join('');
}
function tcAddFromForm() {
  const type = (document.getElementById('tc-form-type').value || '').trim();
  if (!type) { showAlert('請填寫系統型式'); return; }
  const colors = [];
  document.querySelectorAll('.tc-form-color:checked').forEach(function(c){ colors.push(c.value); });
  if (!colors.length) { showAlert('請至少勾選一個顏色'); return; }
  const entry = { systemType: type, colors: colors };
  if (window.tcEditIndex >= 0) {
    window.typeColorMap[window.tcEditIndex] = entry;
  } else {
    const dup = window.typeColorMap.findIndex(function(t){ return t.systemType === type; });
    if (dup >= 0) window.typeColorMap[dup] = entry;   // 同型式覆蓋，不重複
    else window.typeColorMap.push(entry);
  }
  window.tcEditIndex = -1;
  renderTypeColors();
}
function tcEdit(i) { window.tcEditIndex = i; renderTypeColors(); }
function tcCancelEdit() { window.tcEditIndex = -1; renderTypeColors(); }
function tcDel(i) { window.typeColorMap.splice(i, 1); if (window.tcEditIndex === i) window.tcEditIndex = -1; renderTypeColors(); }
async function doSaveTypeColors() {
  loading(true);
  try {
    const res = await gasApi('saveTypeColors', Object.assign(authData(), { rows: window.typeColorMap }));
    loading(false);
    if (res.success) { showAlert('儲存成功！'); loadTypeColors(); }
    else showAlert('儲存失敗：'+(res.error||''));
  } catch(e) { loading(false); showAlert('連線失敗'); }
}
