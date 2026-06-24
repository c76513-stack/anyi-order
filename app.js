// ══════════════════════════════════════════════
//  GAS API 通訊
// ══════════════════════════════════════════════
const GAS_URL = 'https://script.google.com/macros/s/AKfycbxN_zAwK-GI9stX4bgPnx59WnsXAY--kgl3sXOrSeftSUFw3fefSA22VcCQ5SZpE4SQKg/exec';
window.modelMap = [];

async function gasApi(action, data) {
  const payload = encodeURIComponent(JSON.stringify(Object.assign({ action }, data || {})));
  const resp = await fetch(GAS_URL + '?payload=' + payload, { redirect: 'follow' });
  if (!resp.ok) throw new Error('HTTP ' + resp.status);
  return resp.json();
}

function authData() {
  return { u: currentUser, p: currentPass };
}

// ══════════════════════════════════════════════
//  全域狀態
// ══════════════════════════════════════════════
let currentUser = '', currentPass = '', currentCustomer = '', currentRole = '';
let allOrders = null, allAdminOrders = null;
let _installPrompt = null;
let groupCounter = 0, sizeCounter = 0;
let modalResolve = null;

// ══════════════════════════════════════════════
//  初始化
// ══════════════════════════════════════════════
window.addEventListener('load', function () {
  // 記住帳密
  try {
    const saved = JSON.parse(localStorage.getItem('anyi_cred') || '{}');
    if (saved.u) { document.getElementById('username').value = saved.u; document.getElementById('remember-me').checked = true; }
    if (saved.p) document.getElementById('password').value = saved.p;
  } catch (e) {}
  showLoginSection();
  initInstallUI();
});

// Service Worker 註冊
if ('serviceWorker' in navigator) {
  window.addEventListener('load', function () {
    navigator.serviceWorker.register('./sw.js');
  });
}

// PWA 安裝提示
window.addEventListener('beforeinstallprompt', function (e) {
  e.preventDefault();
  _installPrompt = e;
  const btn = document.getElementById('install-btn');
  if (btn) btn.style.display = 'block';
});
window.addEventListener('appinstalled', function () {
  _installPrompt = null;
  const btn = document.getElementById('install-btn');
  if (btn) btn.style.display = 'none';
  const done = document.getElementById('install-done');
  if (done) done.style.display = 'block';
});

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
  if (name === 'query' && !allOrders) loadOrders();
  if (name === 'admin' && !allAdminOrders) loadAllOrders();
  if (name === 'accounts') loadAccounts();
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
    }
    loadModelMap();
    const today = new Date().toISOString().slice(0, 10);
    document.getElementById('query-date').value = today;
    document.getElementById('admin-date').value = today;
    allOrders = null; allAdminOrders = null;
    initGroups();
  } catch (e) {
    loading(false);
    showAlert('連線失敗，請確認網路或 GAS 網址是否正確');
  }
}

function logout() {
  currentUser = ''; currentPass = ''; currentCustomer = ''; currentRole = '';
  allOrders = null; allAdminOrders = null;
  document.getElementById('form-section').style.display = 'none';
  document.getElementById('tab-admin').style.display = 'none';
  document.getElementById('tab-accounts').style.display = 'none';
  document.getElementById('tab-modelmap').style.display = 'none';
  window.modelMap = [];
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
  document.getElementById('groups-container').innerHTML = '';
  document.getElementById('success-card').style.display = 'none';
  addGroup();
  // 預填上次型式
  gasApi('getLastOrder', authData()).then(function(last) {
    if (!last) return;
    const g = document.querySelector('.group-card');
    if (!g) return;
    const gid = g.id.replace('group-','');
    const m = document.getElementById('g'+gid+'-model');
    const c = document.getElementById('g'+gid+'-color');
    if (m && last.modelType) m.value = last.modelType;
    if (c && last.color) c.value = last.color;
  }).catch(function(){});
}

function nextOrder() {
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
      '<div class="field"><label>型式 <span class="req">*</span></label><input type="text" id="g'+gid+'-model" placeholder="如 101" list="model-codes-list" oninput="applyModelCode('+gid+',this.value)"></div>' +
      '<div class="field"><label>顏色 <span class="req">*</span></label><input type="text" id="g'+gid+'-color" placeholder="如 P1"></div>' +
    '</div>' +
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
  const uOpts = '<option value="公分">公分</option><option value="分">台分</option><option value="寸">台寸</option>';
  row.innerHTML =
    '<div class="size-main">' +
      '<span class="size-seq">' + num + '</span>' +
      '<div class="size-field dim-field"><label>上寬</label>' +
        '<div class="dim-wrap"><input type="number" id="s'+sid+'-topW" placeholder="數值" oninput="updateDimUnit(this,\'s'+sid+'-topW-u\',150);updateHolePreview('+sid+')">' +
        '<span id="s'+sid+'-topW-u" class="dim-u-btn" data-unit="" data-sid="'+sid+'" onclick="toggleDimUnit(this)">—</span></div></div>' +
      '<div class="size-field dim-field" id="s'+sid+'-bottomW-wrap" style="display:none"><label>下寬</label>' +
        '<div class="dim-wrap"><input type="number" id="s'+sid+'-bottomW" placeholder="數值" oninput="updateDimUnit(this,\'s'+sid+'-bottomW-u\',150);updateHolePreview('+sid+')">' +
        '<span id="s'+sid+'-bottomW-u" class="dim-u-btn" data-unit="" data-sid="'+sid+'" onclick="toggleDimUnit(this)">—</span></div></div>' +
      '<div class="size-field dim-field"><label>高度</label>' +
        '<div class="dim-wrap"><input type="number" id="s'+sid+'-height" placeholder="數值" oninput="updateDimUnit(this,\'s'+sid+'-height-u\',300);updateHolePreview('+sid+')">' +
        '<span id="s'+sid+'-height-u" class="dim-u-btn" data-unit="" data-sid="'+sid+'" onclick="toggleDimUnit(this)">—</span></div></div>' +
      '<div class="size-field size-field-sm"><label>數量</label><input type="number" id="s'+sid+'-qty" value="1" min="1"></div>' +
      '<label class="size-slant"><input type="checkbox" id="s'+sid+'-slant" onchange="toggleSizeSlant('+sid+')"> 斜邊</label>' +
      '<label class="size-slant"><input type="checkbox" id="s'+sid+'-hole" onchange="toggleHole('+sid+')"> 挖洞</label>' +
      '<button class="btn-remove-size" onclick="removeSizeRow('+sid+')">✕</button>' +
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
  const checked = document.getElementById('s'+sid+'-hole').checked;
  const panel = document.getElementById('s'+sid+'-hole-wrap');
  if (panel) panel.style.display = checked ? 'flex' : 'none';
  if (checked) { autoCalcHole(sid); updateHolePreview(sid); }
}

function buildHolePanel(sid) {
  const uCm = '<option value="公分" selected>公分</option><option value="分">台分</option><option value="寸">台寸</option>';
  const uCun = '<option value="公分">公分</option><option value="分">台分</option><option value="寸" selected>台寸</option>';
  const uPlain = '<option value="公分">公分</option><option value="分">台分</option><option value="寸">台寸</option>';
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
    '<div class="hole-fields-wrap">' +
      '<div class="hole-dist-row">' +
        df('B','距底','100',uCm) + df('T','距高','5',uCun) +
        df('L','距左','5',uCun) + df('R','距右','5',uCun) +
      '</div>' +
      '<div class="hole-size-row">' + sf('W','洞寬',uPlain) + sf('H','洞高',uPlain) + '</div>' +
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
  if (unit === '寸') return v * 100/3.3;   // 1台寸 = 1/0.33公分
  if (unit === '分') return v * 10/3.3;    // 1台分 = 1/3.3公分
  return v * 10;
}
function updateDimUnit(input, labelId, threshold) {
  const v = parseFloat(input.value);
  const el = document.getElementById(labelId);
  if (!el) return;
  if (!v || v <= 0) { el.dataset.unit = ''; delete el.dataset.manual; el.textContent = '—'; return; }
  if (el.dataset.manual === '1') return;
  const unit = v < threshold ? '公分' : '分';
  el.dataset.unit = unit;
  el.textContent = unit === '分' ? '台分' : '公分';
}
function toggleDimUnit(el) {
  const cur = el.dataset.unit;
  if (!cur) return;
  const next = cur === '分' ? '公分' : '分';
  el.dataset.unit = next;
  el.textContent = next === '分' ? '台分' : '公分';
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
  return n < threshold ? n + '公分' : n + '台分';
}

// ── 角材計算 ──
function computeA9(t, tUnit, b, bUnit) {
  const tFen = tUnit === '分' ? t : t * 3.3;
  const bFen = b > 0 ? (bUnit === '分' ? b : b * 3.3) : 0;
  let w = Math.max(tFen, bFen);
  if (w <= 0) return null;
  w = w - 23;
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
  return el.value === '分' ? '台分' : el.value === '寸' ? '台寸' : '公分';
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
  const dW = getDoorMm(sid,'W'), dH = getDoorMm(sid,'H');
  if (dW > 0) {
    const L=holeValMm(sid,'L'),R=holeValMm(sid,'R'),W=holeValMm(sid,'W');
    const lEl=document.getElementById('s'+sid+'-holeL'),rEl=document.getElementById('s'+sid+'-holeR'),wEl=document.getElementById('s'+sid+'-holeW');
    const hasL=lEl&&lEl.value!=='',hasR=rEl&&rEl.value!=='',hasW=wEl&&wEl.value!=='';
    if(hasL&&hasR&&wEl&&!wEl.dataset.manual) setHoleAuto(sid,'W',dW-L-R);
    else if(hasL&&hasW&&rEl&&!rEl.dataset.manual) setHoleAuto(sid,'R',dW-L-W);
    else if(hasR&&hasW&&lEl&&!lEl.dataset.manual) setHoleAuto(sid,'L',dW-R-W);
  }
  if (dH > 0) {
    const B=holeValMm(sid,'B'),T=holeValMm(sid,'T'),H=holeValMm(sid,'H');
    const bEl=document.getElementById('s'+sid+'-holeB'),tEl=document.getElementById('s'+sid+'-holeT'),hEl=document.getElementById('s'+sid+'-holeH');
    const hasB=bEl&&bEl.value!=='',hasT=tEl&&tEl.value!=='',hasH=hEl&&hEl.value!=='';
    if(hasB&&hasT&&hEl&&!hEl.dataset.manual) setHoleAuto(sid,'H',dH-B-T);
    else if(hasB&&hasH&&tEl&&!tEl.dataset.manual) setHoleAuto(sid,'T',dH-B-H);
    else if(hasT&&hasH&&bEl&&!bEl.dataset.manual) setHoleAuto(sid,'B',dH-T-H);
  }
}
function holeSpecText(sid) {
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
function updateHolePreview(sid) {
  const box = document.getElementById('s'+sid+'-hole-preview');
  if (!box) return;
  const topWVal = parseFloat(document.getElementById('s'+sid+'-topW').value)||0;
  const botEl = document.getElementById('s'+sid+'-bottomW');
  const botWVal = botEl ? (parseFloat(botEl.value)||0) : 0;
  const doorW = Math.max(unitToMm(topWVal,getFieldUnit(sid,'topW')), unitToMm(botWVal,getFieldUnit(sid,'bottomW')));
  const hRaw = parseFloat(document.getElementById('s'+sid+'-height').value)||0;
  const doorH = unitToMm(hRaw, getFieldUnit(sid,'height'));
  if (doorW<=0||doorH<=0) { box.innerHTML='<div class="hole-note">請先填門板上寬與高度，才能畫示意圖</div>'; return; }
  const holeW=unitToMm(holeVal(sid,'W'),holeUnit(sid,'W').replace('台',''));
  const holeH=unitToMm(holeVal(sid,'H'),holeUnit(sid,'H').replace('台',''));
  const holeL=unitToMm(holeVal(sid,'L')||'0',holeUnit(sid,'L').replace('台',''));
  const holeB=unitToMm(holeVal(sid,'B')||'0',holeUnit(sid,'B').replace('台',''));
  const MAX=120; const scale=Math.min(MAX/doorW,MAX*1.5/doorH);
  const dw=Math.round(doorW*scale),dh=Math.round(doorH*scale);
  let inner='';
  if(holeW>0&&holeH>0) {
    const hw=Math.max(1,Math.round(holeW*scale)),hh=Math.max(1,Math.round(holeH*scale));
    const hl=Math.round(holeL*scale),hb=dh-Math.round(holeB*scale)-hh;
    inner=`<rect x="${hl}" y="${hb}" width="${hw}" height="${hh}" fill="#fff" stroke="#e53e3e" stroke-width="1.5" stroke-dasharray="3,2"/>`;
  }
  box.innerHTML=`<svg width="${dw}" height="${dh}" style="border:2px solid #2b6cb0;border-radius:3px;background:#ebf8ff"><rect width="${dw}" height="${dh}" fill="#ebf8ff"/>${inner}</svg><div class="hole-note" style="margin-top:4px">${(doorW/10).toFixed(1)}×${(doorH/10).toFixed(1)}公分</div>`;
}

// ══════════════════════════════════════════════
//  送出訂單
// ══════════════════════════════════════════════
async function submitAllOrders() {
  const groups = document.querySelectorAll('.group-card');
  if (!groups.length) { showAlert('請先新增訂單'); return; }
  const orders = [];
  for (const g of groups) {
    const gid = g.id.replace('group-', '');
    const modelEl = document.getElementById('g'+gid+'-model');
    const model = (modelEl.dataset.systemCode || modelEl.value).trim();
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
      if (!topW || !height || !qty) { showAlert('有必填欄位未填'); return; }
      if (slant && !bottomW) { showAlert('勾選斜邊但未填下寬'); return; }
      const hole = document.getElementById('s'+sid+'-hole').checked;
      if (hole) {
        const hw = holeVal(sid,'W'), hh = holeVal(sid,'H');
        if (!(parseFloat(hw)>0)||!(parseFloat(hh)>0)) { showAlert('挖洞的洞寬與洞高須大於 0'); return; }
        const spec = holeSpecText(sid);
        remark = remark ? remark+' '+spec : spec;
      }
      const resultA9 = computeA9(parseFloat(topW)||0, topWUnit, parseFloat(bottomW)||0, botWUnit) || 0;
      orders.push({ modelType: model, color, topW, topWUnit, bottomW, botWUnit, height, heightUnit, quantity: qty, remark, resultA9 });
    }
  }
  const totalQty = orders.reduce(function(s,o){ return s+(parseInt(o.quantity)||0); }, 0);
  const summary = orders.map(function(o){
    const wu = o.topWUnit==='分'?'台分':'公分';
    const hu = o.heightUnit==='分'?'台分':'公分';
    return o.modelType+'/'+o.color+' 寬'+o.topW+(o.bottomW?'/'+o.bottomW:'')+wu+' 高'+o.height+hu+' ×'+o.quantity+'片';
  }).join('\n');
  const ok = await showConfirm('確定送出以下 '+orders.length+' 筆訂單（共 '+totalQty+' 片）？\n\n'+summary);
  if (!ok) return;
  loading(true);
  try {
    const res = await gasApi('saveOrders', { ...authData(), orders });
    loading(false);
    if (!res.success) { showAlert('送出失敗：'+(res.error||'未知錯誤')); return; }
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

function renderOrders() {
  if (!allOrders) return;
  const dateVal = document.getElementById('query-date').value;
  const idQuery = (document.getElementById('query-orderid').value||'').trim().toUpperCase();
  const listEl = document.getElementById('orders-list');
  const summaryEl = document.getElementById('summary-card');
  const noDataEl = document.getElementById('no-orders');
  const filtered = idQuery
    ? allOrders.filter(function(o){ return String(o.orderId||'').toUpperCase().indexOf(idQuery)!==-1; })
    : allOrders.filter(function(o){ return o.time.startsWith(dateVal); });
  const p = dateVal.split('-');
  document.getElementById('summary-date').textContent = idQuery ? '編號搜尋：'+idQuery : p[0]+'/'+p[1]+'/'+p[2];
  if (!filtered.length) { summaryEl.style.display='none'; noDataEl.style.display='block'; listEl.innerHTML=''; return; }
  noDataEl.style.display='none'; summaryEl.style.display='flex';
  document.getElementById('summary-total').textContent = filtered.reduce(function(s,o){return s+o.quantity;},0);
  const groups = groupOrders(filtered);
  listEl.innerHTML = groups.map(function(g,i){
    const t = g.time.length>=16 ? g.time.substring(11,16) : '';
    const allConfirmed = g.items.every(function(it){ return it.status==='已確認'; });
    const badge = allConfirmed
      ? '<span class="status-badge badge-confirmed">已確認</span>'
      : '<span class="status-badge badge-pending">待確認</span>';
    const idTag = g.orderId ? '<span style="font-size:.75rem;color:#718096;margin-left:6px">'+escHtml(g.orderId)+'</span>' : '';
    const totalQty = g.items.reduce(function(s,it){return s+it.quantity;},0);
    return '<div class="order-item">' +
      '<div class="order-item-header"><span class="order-seq">#'+(i+1)+idTag+'</span><span class="order-time">'+t+'　'+badge+'</span></div>' +
      g.items.map(itemLine).join('') +
      '<div class="order-qty" style="margin-top:8px">本單共 <strong>'+totalQty+' 片</strong></div>' +
    '</div>';
  }).join('');
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
  const dateVal = document.getElementById('admin-date').value;
  const selectEl = document.getElementById('admin-search');
  const idQuery = (document.getElementById('admin-orderid').value||'').trim().toUpperCase();
  const byDate = (allAdminOrders||[]).filter(function(o){ return o.time.startsWith(dateVal); });
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
  const groups = groupOrders(filtered);
  listEl.innerHTML = groups.map(function(g,i){
    const t = g.time.length>=16 ? g.time.substring(11,16) : '';
    const allConfirmed = g.items.every(function(it){ return it.status==='已確認'; });
    const badge = allConfirmed
      ? '<span class="status-badge badge-confirmed">已確認</span>'
      : '<span class="status-badge badge-pending">待確認</span>';
    const idTag = g.orderId ? '<span style="font-size:.75rem;color:#718096;margin-left:6px">'+escHtml(g.orderId)+'</span>' : '';
    const totalQty = g.items.reduce(function(s,it){return s+it.quantity;},0);
    const rowIdxs = g.items.map(function(it){ return it.rowIndex; });
    const confirmBtn = allConfirmed ? '' : '<button class="btn-action btn-confirm" onclick="doConfirmGroup(['+rowIdxs.join(',')+'])">✓ 確認整單</button>';
    const deleteBtn = '<button class="btn-action btn-delete" onclick="doDeleteGroup(['+rowIdxs.join(',')+'])">✕ 刪除整單</button>';
    return '<div class="order-item">' +
      '<div class="order-item-header"><span class="order-seq">#'+(i+1)+'　'+escHtml(g.customerName)+idTag+'</span><span class="order-time">'+t+'　'+badge+'</span></div>' +
      g.items.map(itemLine).join('') +
      '<div class="order-qty" style="margin-top:8px">本單共 <strong>'+totalQty+' 片</strong></div>' +
      '<div class="order-actions">'+confirmBtn+deleteBtn+'</div>' +
    '</div>';
  }).join('');
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
async function loadAccounts() {
  loading(true);
  try {
    const list = await gasApi('getAllAccounts', authData());
    loading(false);
    const el = document.getElementById('accounts-list');
    if (!list.length) { el.innerHTML = '<p style="color:#a0aec0;text-align:center;padding:20px">目前無帳號資料</p>'; return; }
    el.innerHTML = list.map(function(a){
      const disabled = a.status==='停用';
      return '<div class="account-item'+(disabled?' account-disabled':'')+'">'+
        '<div class="account-info">'+
          '<div class="account-name">'+escHtml(a.customerName)+'</div>'+
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
  } catch(e) { loading(false); showAlert('查詢失敗'); }
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
  const m = spec.match(new RegExp(key+'([\\d.]+)(公分|台分|台寸)'));
  if (!m) return 0;
  return unitToMm(parseFloat(m[1]), m[2].replace('台',''));
}
function holeRemarkSvg(remark) {
  if (!remark || remark.indexOf('【挖洞】') === -1) return '';
  const spec = remark.substring(remark.indexOf('【挖洞】'));
  const W = parseHoleMm(spec,'洞寬'), H = parseHoleMm(spec,'洞高');
  if (W<=0||H<=0) return '';
  const B = parseHoleMm(spec,'距底')||0, T = parseHoleMm(spec,'距高')||0;
  const L = parseHoleMm(spec,'距左')||0, R = parseHoleMm(spec,'距右')||0;
  const doorW = (L+W+R)||W, doorH = (B+H+T)||H;
  const MAX=70, scale=Math.min(MAX/doorW,MAX*1.5/doorH);
  const dw=Math.round(doorW*scale), dh=Math.round(doorH*scale);
  const hw=Math.max(1,Math.round(W*scale)), hh=Math.max(1,Math.round(H*scale));
  const hl=Math.round(L*scale), hb=dh-Math.round(B*scale)-hh;
  return '<svg width="'+dw+'" height="'+dh+'" style="border:2px solid #2b6cb0;border-radius:3px;background:#ebf8ff;display:block;margin-top:6px">'+
    '<rect width="'+dw+'" height="'+dh+'" fill="#ebf8ff"/>'+
    '<rect x="'+hl+'" y="'+hb+'" width="'+hw+'" height="'+hh+'" fill="#fff" stroke="#e53e3e" stroke-width="1.5" stroke-dasharray="3,2"/>'+
    '</svg>';
}
function itemLine(it) {
  const wDisp = it.bottomW
    ? dimDisp(it.topW,150)+' / '+dimDisp(it.bottomW,150)+'（斜邊）'
    : dimDisp(it.topW,150);
  const remarkText = it.remark ? it.remark.replace(/【挖洞】.*/,'').trim() : '';
  const holeSvg = holeRemarkSvg(it.remark||'');
  return '<div class="suborder">'+
    '<div class="order-detail"><span class="tag">'+escHtml(it.modelType)+'</span><span class="tag">'+escHtml(it.color)+'</span></div>'+
    '<div class="order-spec">寬 '+wDisp+'　高 '+dimDisp(it.height,200)+'　× <strong>'+it.quantity+' 片</strong>'+
      (remarkText ? '　<span class="order-remark">備註：'+escHtml(remarkText)+'</span>' : '')+
    '</div>'+holeSvg+'</div>';
}

function escHtml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ══════════════════════════════════════════════
//  UI 工具
// ══════════════════════════════════════════════
function loading(on) {
  document.getElementById('loading').style.display = on ? 'flex' : 'none';
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
async function loadModelMap() {
  try {
    const res = await gasApi('getModelMap', authData());
    window.modelMap = Array.isArray(res) ? res : [];
    const dl = document.getElementById('model-codes-list');
    if (dl) dl.innerHTML = window.modelMap.map(function(m){
      return '<option value="'+escHtml(m.code)+'">'+escHtml(m.systemType)+'</option>';
    }).join('');
  } catch(e) {}
}

function applyModelCode(gid, val) {
  const inp = document.getElementById('g'+gid+'-model');
  const mapping = (window.modelMap||[]).find(function(m){ return m.code === val; });
  if (!mapping) { if (inp) delete inp.dataset.systemCode; return; }
  inp.dataset.systemCode = mapping.systemType;
  const container = document.getElementById('sizes-'+gid);
  if (!container) return;
  container.querySelectorAll('.size-row').forEach(function(row) {
    const sid = parseInt(row.id.replace('size-',''));
    if (mapping.remark) {
      const rEl = document.getElementById('s'+sid+'-remark');
      if (rEl && !rEl.value) rEl.value = mapping.remark;
    }
    if (mapping.hole) {
      const holeChk = document.getElementById('s'+sid+'-hole');
      if (holeChk && !holeChk.checked) { holeChk.checked = true; toggleHole(sid); }
      applyHolePreset(sid, mapping);
    }
  });
}

function applyHolePreset(sid, mapping) {
  function setF(key, valWithUnit) {
    if (!valWithUnit) return;
    const m = valWithUnit.match(/^([\d.]+)(公分|台分|台寸)$/);
    if (!m) return;
    const el = document.getElementById('s'+sid+'-hole'+key);
    const uEl = document.getElementById('s'+sid+'-hole'+key+'-u');
    if (el) { el.value = m[1]; delete el.dataset.manual; el.classList.remove('hole-input-auto'); }
    if (uEl) uEl.value = m[2].replace('台','');
  }
  setF('B', mapping.distB); setF('T', mapping.distT);
  setF('L', mapping.distL); setF('R', mapping.distR);
  setF('W', mapping.holeW); setF('H', mapping.holeH);
  autoCalcHole(sid); updateHolePreview(sid);
}

// ── 型式對照 admin 管理 ──
function renderModelMap() {
  const list = document.getElementById('modelmap-list');
  if (!list) return;
  if (!window.modelMap.length) {
    list.innerHTML = '<p style="color:#a0aec0;text-align:center;padding:20px 0">尚無資料，點「＋ 新增」新增</p>';
    return;
  }
  list.innerHTML = window.modelMap.map(function(m, i){ return mmCard(m, i); }).join('');
}

function mmCard(m, i) {
  const hd = m.hole ? 'flex' : 'none';
  return '<div style="border:1.5px solid #e2e8f0;border-radius:8px;padding:12px;margin-bottom:8px;background:#f7fafc">' +
    '<div style="display:flex;gap:8px;margin-bottom:8px;align-items:center">' +
      '<input placeholder="客戶代碼（如378-2）" value="'+escHtml(m.code)+'" oninput="mmSet('+i+',\'code\',this.value)" style="flex:1;padding:7px 10px;border:1.5px solid #e2e8f0;border-radius:7px;font-size:.88rem">' +
      '<span style="color:#a0aec0">→</span>' +
      '<input placeholder="系統型式（如103）" value="'+escHtml(m.systemType)+'" oninput="mmSet('+i+',\'systemType\',this.value)" style="flex:1;padding:7px 10px;border:1.5px solid #e2e8f0;border-radius:7px;font-size:.88rem">' +
      '<button class="btn-remove-row" onclick="mmDel('+i+')">✕</button>' +
    '</div>' +
    '<div style="display:flex;gap:8px;margin-bottom:6px;align-items:center">' +
      '<input placeholder="自動帶入備註（選填）" value="'+escHtml(m.remark)+'" oninput="mmSet('+i+',\'remark\',this.value)" style="flex:1;padding:7px 10px;border:1.5px solid #e2e8f0;border-radius:7px;font-size:.88rem">' +
      '<label style="display:flex;align-items:center;gap:5px;font-size:.85rem;white-space:nowrap;color:#4a5568;cursor:pointer"><input type="checkbox" '+(m.hole?'checked':'')+' onchange="mmHoleToggle('+i+',this.checked)"> 挖洞</label>' +
    '</div>' +
    '<div id="mm-hole-'+i+'" style="display:'+hd+';flex-wrap:wrap;gap:6px">' +
      mmHF('距底',i,'distB',m.distB)+mmHF('距高',i,'distT',m.distT)+
      mmHF('距左',i,'distL',m.distL)+mmHF('距右',i,'distR',m.distR)+
      mmHF('洞寬',i,'holeW',m.holeW)+mmHF('洞高',i,'holeH',m.holeH)+
    '</div>' +
  '</div>';
}
function mmHF(label, i, key, val) {
  return '<div style="display:flex;flex-direction:column;gap:2px;flex:0 0 calc(33% - 4px)">' +
    '<label style="font-size:.72rem;color:#718096">'+label+'</label>' +
    '<input placeholder="如 5台寸" value="'+escHtml(val||'')+'" oninput="mmSet('+i+',\''+key+'\',this.value)" style="padding:6px 8px;border:1.5px solid #e2e8f0;border-radius:6px;font-size:.82rem">' +
  '</div>';
}
function mmSet(i, key, val) { if (window.modelMap[i]) window.modelMap[i][key] = val; }
function mmHoleToggle(i, checked) {
  if (window.modelMap[i]) window.modelMap[i].hole = checked;
  const d = document.getElementById('mm-hole-'+i);
  if (d) d.style.display = checked ? 'flex' : 'none';
}
function mmDel(i) { window.modelMap.splice(i,1); renderModelMap(); }
function addModelMapRow() {
  window.modelMap.push({code:'',systemType:'',remark:'',hole:false,distB:'',distT:'',distL:'',distR:'',holeW:'',holeH:''});
  renderModelMap();
}
async function doSaveModelMap() {
  loading(true);
  try {
    const res = await gasApi('saveModelMap', Object.assign(authData(), { rows: window.modelMap }));
    loading(false);
    if (res.success) {
      const dl = document.getElementById('model-codes-list');
      if (dl) dl.innerHTML = window.modelMap.map(function(m){
        return '<option value="'+escHtml(m.code)+'">'+escHtml(m.systemType)+'</option>';
      }).join('');
      showAlert('儲存成功！');
    } else showAlert('儲存失敗：'+(res.error||''));
  } catch(e) { loading(false); showAlert('連線失敗'); }
}
