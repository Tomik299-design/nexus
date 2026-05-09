// NexusChat Server
// Spuštění: node server.js
// Připojení: wss://TVOJE-URL

const WebSocket = require('ws');
const http      = require('http');
const https     = require('https');
const fs        = require('fs');
const path      = require('path');
const os        = require('os');
const crypto    = require('crypto');

// ── Email+Password Auth ──────────────────────────────────────────────
const AUTH_FILE   = '/tmp/nexus_auth.json';
const TOKEN_FILE  = '/tmp/nexus_tokens.json';
let authData      = {};  // { email: { userId, passHash, salt, username, createdAt } }
let resetTokens   = {};  // { token: { email, expires } }

function hashPass(password, salt) {
  return crypto.pbkdf2Sync(password, salt, 100000, 64, 'sha512').toString('hex');
}
function verifyPass(password, salt, hash) {
  return crypto.timingSafeEqual(Buffer.from(hashPass(password, salt), 'hex'), Buffer.from(hash, 'hex'));
}
function genToken(len) {
  return crypto.randomBytes(len || 32).toString('hex');
}
// loadBulkAccounts — načte účty z JSONBin (pokud je nastaveno ACCOUNTS_BIN_ID)
function loadBulkAccounts(cb) {
  const binId = process.env.ACCOUNTS_BIN_ID;
  if (!binId) { if (cb) cb(); return; }
  jsonbinRequest('GET', binId, null, (err, result) => {
    if (!err && result && result.record && typeof result.record === 'object') {
      Object.assign(accounts, result.record);
      console.log('[Cloud] Loaded', Object.keys(result.record).length, 'accounts from JSONBin');
    } else if (err) {
      console.warn('[Cloud] loadBulkAccounts error:', err.message);
    }
    if (cb) cb();
  });
}

function loadAuth() {
  try {
    if (fs.existsSync(AUTH_FILE))  authData     = JSON.parse(fs.readFileSync(AUTH_FILE, 'utf8'));
    if (fs.existsSync(TOKEN_FILE)) resetTokens  = JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8'));
    console.log('[Auth] Loaded', Object.keys(authData).length, 'email accounts');
  } catch(e) { console.warn('[Auth] Load error:', e.message); }
}
function saveAuth()   { try { fs.writeFileSync(AUTH_FILE,  JSON.stringify(authData));    } catch(e) {} }
function saveTokens() { try { fs.writeFileSync(TOKEN_FILE, JSON.stringify(resetTokens)); } catch(e) {} }

function sendResetEmail(toEmail, token, cb) {
  const SMTP_HOST = process.env.SMTP_HOST;
  const SMTP_USER = process.env.SMTP_USER;
  const SMTP_PASS = process.env.SMTP_PASS;
  const APP_URL   = process.env.APP_URL || 'https://nexus-g7k4.onrender.com';
  if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS) {
    return cb(new Error('SMTP not configured'));
  }
  const resetUrl = APP_URL + '/reset?token=' + token;
  const body = 'Resetuj heslo zde:\n' + resetUrl + '\n\nPlatnost: 1 hodina.\nPokud jsi o reset nežádal/a, ignoruj tento email.';
  const msg  = 'From: NexusChat <' + SMTP_USER + '>\r\nTo: ' + toEmail + '\r\nSubject: Reset hesla — NexusChat\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n' + body;
  const net  = require('net');
  // Use nodemailer if available, else simple SMTP
  let nodemailer;
  try { nodemailer = require('nodemailer'); } catch(e) { nodemailer = null; }
  if (nodemailer) {
    const transporter = nodemailer.createTransport({
      host: SMTP_HOST, port: 587, secure: false,
      auth: { user: SMTP_USER, pass: SMTP_PASS }
    });
    transporter.sendMail({ from: SMTP_USER, to: toEmail, subject: 'Reset hesla — NexusChat', text: body }, cb);
  } else {
    cb(new Error('nodemailer not installed — run: npm install nodemailer'));
  }
}

// ── JSONBin.io cloud storage ──
// Zdarma na jsonbin.io — účet není nutný pro základní použití
// Pro vlastní API klíč: nastavit env proměnnou JSONBIN_KEY na Render
const JSONBIN_KEY = process.env.JSONBIN_KEY || '';
const JSONBIN_BASE = 'https://api.jsonbin.io/v3';

function jsonbinRequest(method, binId, data, cb) {
  const body = data ? JSON.stringify(data) : null;
  const headers = {
    'Content-Type': 'application/json',
    'X-Bin-Private': 'false',
  };
  if (JSONBIN_KEY) headers['X-Master-Key'] = JSONBIN_KEY;
  if (body) headers['Content-Length'] = Buffer.byteLength(body);

  const urlPath = binId ? '/b/' + binId + '/latest' : '/b';
  const options = {
    hostname: 'api.jsonbin.io',
    path: '/v3' + urlPath,
    method: method,
    headers
  };

  const req = https.request(options, (res) => {
    let raw = '';
    res.on('data', d => raw += d);
    res.on('end', () => {
      try { cb(null, JSON.parse(raw)); } catch(e) { cb(e); }
    });
  });
  req.on('error', cb);
  if (body) req.write(body);
  req.end();
}

function cloudSaveAccount(userId, data) {
  // Use userId as bin name via metadata
  const binId = accounts[userId]?._binId;
  if (binId) {
    // Update existing bin
    jsonbinRequest('PUT', binId, data, (err) => {
      if (err) console.warn('[Cloud] Save error:', err.message);
    });
  } else {
    // Create new bin
    const reqOpts = {
      hostname: 'api.jsonbin.io',
      path: '/v3/b',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Bin-Name': 'nx_' + userId.slice(0, 16),
        'X-Bin-Private': 'false',
        ...(JSONBIN_KEY ? { 'X-Master-Key': JSONBIN_KEY } : {})
      }
    };
    const body = JSON.stringify(data);
    reqOpts.headers['Content-Length'] = Buffer.byteLength(body);
    const req = https.request(reqOpts, (res) => {
      let raw = '';
      res.on('data', d => raw += d);
      res.on('end', () => {
        try {
          const result = JSON.parse(raw);
          if (result.metadata?.id) {
            if (!accounts[userId]) accounts[userId] = {};
            accounts[userId]._binId = result.metadata.id;
            saveAccounts(); // persist binId locally
            console.log('[Cloud] Created bin for', userId.slice(0,8), ':', result.metadata.id);
          }
        } catch(e) {}
      });
    });
    req.on('error', err => console.warn('[Cloud] Create error:', err.message));
    req.write(body);
    req.end();
  }
}

function cloudLoadAccount(userId, cb) {
  const binId = accounts[userId]?._binId;
  if (!binId) { cb(null, null); return; }
  jsonbinRequest('GET', binId, null, (err, result) => {
    if (err) { cb(err); return; }
    cb(null, result?.record || null);
  });
}

const PORT = process.env.PORT || 3001;

// Show loading screen on EVERY start (deploy or cold start)
// Users see changelog while server warms up
let serverReady = false;
let serverStartTime = Date.now();
setTimeout(() => { serverReady = true; console.log('[NexusChat] Server ready!'); }, 12000);

// ── HTTP server ──
// ══════════════════════════════════════════
//  CHANGELOG — edit this to update users
// ══════════════════════════════════════════
// ══════════════════════════════════════════
//  AUTO CHANGELOG — čte CHANGELOG.md soubor
//  Formát: ## v3.2 | 2026-03-29
//          + Nová funkce
//          * Oprava bugu
//          - Odebráno
// ══════════════════════════════════════════

function parseChangelogMd() {
  const file = path.join(__dirname, 'CHANGELOG.md');
  if (!fs.existsSync(file)) return null;
  try {
    const text = fs.readFileSync(file, 'utf8');
    const versions = [];
    let cur = null;
    for (const rawLine of text.split('\n')) {
      const line = rawLine.trim();
      // Version header: ## v3.2 | 2026-03-29  or  ## v3.2 - 2026-03-29
      const vh = line.match(/^##\s+v?([\d.]+)\s*[|\-]\s*([\d\-]+)/);
      if (vh) {
        if (cur) versions.push(cur);
        cur = { version: vh[1], date: vh[2], items: [] };
        continue;
      }
      if (!cur) continue;
      // Item lines
      if (line.startsWith('+ ') || line.startsWith('- [x] ') || line.startsWith('✅')) {
        cur.items.push({ type: 'new', text: line.replace(/^[+✅]\s*\[x\]?\s*/, '') });
      } else if (line.startsWith('* ') || line.startsWith('~ ') || line.startsWith('🔧')) {
        cur.items.push({ type: 'fix', text: line.replace(/^[*~🔧]\s*/, '') });
      } else if (line.startsWith('^ ') || line.startsWith('⬆') || line.startsWith('! ')) {
        cur.items.push({ type: 'imp', text: line.replace(/^[^\w]*/, '') });
      } else if (line.startsWith('- ') && !line.startsWith('- [')) {
        cur.items.push({ type: 'rem', text: line.replace(/^-\s*/, '') });
      }
    }
    if (cur) versions.push(cur);
    return versions.length ? versions : null;
  } catch(e) {
    console.warn('[Changelog] Parse error:', e.message);
    return null;
  }
}

const CHANGELOG_FALLBACK = [
  {
    version: '3.2',
    date: '2026-03-29',
    items: [
      { type: 'new',  text: 'Login system — ID + přezdívka = účet přes prohlížeče' },
      { type: 'new',  text: 'Zapamatovat účet — zůstaneš přihlášený po refreshi' },
      { type: 'new',  text: 'Sync serverů přes server — servery se obnoví při přihlášení' },
      { type: 'new',  text: 'Historie zpráv uložena na disk — noví uživatelé vidí staré zprávy' },
      { type: 'new',  text: 'Voice calls přes WebSocket relay — funguje všude' },
      { type: 'new',  text: 'Noise Gate — filtruje dýchání a hluk' },
      { type: 'new',  text: 'Hlasitost mikrofonu a výstupu v nastavení' },
      { type: 'new',  text: 'Přepínač jazyka CS / EN' },
      { type: 'new',  text: 'DM seznam v sidebaru s odznaky nepřečtených' },
      { type: 'fix',  text: 'Zprávy se posílaly do špatného chatu po DM' },
      { type: 'fix',  text: 'Voice room správně zobrazuje kdo je ve kterém kanálu' },
      { type: 'fix',  text: 'Odpojení z voice nyní ihned uklidí UI' },
      { type: 'fix',  text: 'Bany a offline členové přetrvají po restartu serveru' },
      { type: 'imp',  text: 'Automatický changelog z CHANGELOG.md souboru' },
    ]
  }
];

const CHANGELOG = parseChangelogMd() || CHANGELOG_FALLBACK;

const LOADING_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>NexusChat — Starting</title>
<link href="https://fonts.googleapis.com/css2?family=Syne:wght@400;600;700&display=swap" rel="stylesheet">
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{background:#070809;font-family:'Syne',system-ui,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh}
.card{background:#0d0f12;border:1px solid #1f2836;border-radius:20px;padding:40px 36px;text-align:center;width:min(400px,90vw)}
.logo{font-size:48px;margin-bottom:16px;display:inline-block;animation:pulse 1.8s ease infinite}
@keyframes pulse{0%,100%{transform:scale(1)}50%{transform:scale(1.12)}}
h1{font-size:22px;font-weight:700;color:#e2e8f0;margin-bottom:8px}
.sub{font-size:14px;color:#64748b;margin-bottom:24px}
.dots{display:flex;justify-content:center;gap:8px}
.dot{width:10px;height:10px;border-radius:50%;background:#4fffb0;animation:bounce 1.2s ease infinite}
.dot:nth-child(2){animation-delay:.2s}
.dot:nth-child(3){animation-delay:.4s}
@keyframes bounce{0%,100%{opacity:.2;transform:scale(.7)}50%{opacity:1;transform:scale(1)}}
</style>
</head>
<body>
<div class="card">
  <div class="logo">⚡</div>
  <h1>NexusChat is starting</h1>
  <p class="sub">Připojování k serveru...</p>
  <div class="dots"><div class="dot"></div><div class="dot"></div><div class="dot"></div></div>
</div>
<script>
function tryConnect(){fetch('/health').then(function(r){return r.json();}).then(function(d){if(d.ready){location.reload();}else{setTimeout(tryConnect,1500);}}).catch(function(){setTimeout(tryConnect,2000);});}
setTimeout(tryConnect,1500);
</script>
</body>
</html>`;

function buildChangelogHtml() {
  var html = '<div class="changelog">';
  CHANGELOG.forEach(function(v) {
    html += '<div class="cl-header">'
      + '<span class="cl-title">&#x1F680; What\'s new</span>'
      + '<span class="cl-version">v' + v.version + '</span>'
      + '<span class="cl-date">' + v.date + '</span>'
      + '</div>';
    v.items.forEach(function(item) {
      html += '<div class="cl-item">'
        + '<span class="cl-badge ' + item.type + '">' + item.type.toUpperCase() + '</span>'
        + item.text
        + '</div>';
    });
  });
  html += '</div>';
  return html;
}

const MAINTENANCE_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="refresh" content="12">
<title>NexusChat — Update in progress</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Syne:wght@400;600;700;800&family=Syne+Mono&display=swap" rel="stylesheet">
<style>
  *, *::before, *::after { margin:0; padding:0; box-sizing:border-box; }
  body {
    background: #070809; color: #cdd6e0;
    font-family: 'Syne', 'Segoe UI', sans-serif;
    min-height: 100vh; padding: 24px 16px;
    display: flex; align-items: center; justify-content: center;
  }
  .wrap { width: min(520px, 100%); display: flex; flex-direction: column; gap: 14px; }

  /* Main card */
  .card {
    background: #0d0f12; border: 1px solid #1f2836;
    border-radius: 20px; padding: 36px 32px;
    box-shadow: 0 24px 60px rgba(0,0,0,.7);
    animation: fadeUp .5s cubic-bezier(.22,1,.36,1) forwards;
    text-align: center;
  }
  @keyframes fadeUp { from{opacity:0;transform:translateY(16px)} to{opacity:1;transform:translateY(0)} }

  .logo { font-size: 44px; margin-bottom: 14px; display:inline-block; animation: pulse 2s ease infinite; }
  @keyframes pulse { 0%,100%{transform:scale(1)} 50%{transform:scale(1.08)} }

  h1 { font-size: 22px; font-weight: 700; color: #e2e8f0; margin-bottom: 6px; }
  .sub { font-size: 14px; color: #64748b; margin-bottom: 22px; line-height: 1.6; }

  .status-badge {
    display: inline-flex; align-items: center; gap: 8px;
    background: rgba(79,255,176,.07); border: 1px solid rgba(79,255,176,.2);
    border-radius: 20px; padding: 7px 16px; font-size: 13px; color: #4fffb0;
    margin-bottom: 20px; font-weight: 600;
  }
  .dot { width:8px; height:8px; border-radius:50%; background:#4fffb0; animation: blink 1.4s ease infinite; }
  @keyframes blink { 0%,100%{opacity:1} 50%{opacity:.3} }

  .progress { background: #1a1f2e; border-radius: 8px; height: 3px; overflow:hidden; margin-bottom:18px; }
  .progress-bar {
    height:100%; background: linear-gradient(90deg,#4fffb0,#7c6aff);
    border-radius:8px; animation: prog 12s linear infinite; width:0;
  }
  @keyframes prog { from{width:0%} to{width:100%} }

  .refresh-note { font-size: 12px; color: #3a4654; }
  .refresh-note a { color: #4fffb0; cursor:pointer; text-decoration:none; }
  .refresh-note a:hover { text-decoration: underline; }

  /* Changelog card */
  .changelog {
    background: #0d0f12; border: 1px solid #1f2836;
    border-radius: 20px; padding: 24px 28px;
    animation: fadeUp .5s cubic-bezier(.22,1,.36,1) .15s both;
  }
  .cl-header {
    display: flex; align-items: center; gap: 10px;
    margin-bottom: 16px; padding-bottom: 12px;
    border-bottom: 1px solid #1f2836;
  }
  .cl-title { font-size: 14px; font-weight: 700; color: #e2e8f0; flex:1; }
  .cl-version {
    font-family: 'Syne Mono', monospace; font-size: 11px;
    background: rgba(79,255,176,.1); color: #4fffb0;
    padding: 2px 8px; border-radius: 6px; border: 1px solid rgba(79,255,176,.2);
  }
  .cl-date { font-size: 11px; color: #3a4654; font-family: 'Syne Mono', monospace; }
  .cl-item {
    display: flex; align-items: flex-start; gap: 10px;
    padding: 6px 0; border-bottom: 1px solid #131720;
    font-size: 13px; color: #94a3b8; line-height: 1.5;
  }
  .cl-item:last-child { border-bottom: none; }
  .cl-badge {
    font-size: 10px; font-weight: 700; padding: 2px 6px;
    border-radius: 4px; flex-shrink: 0; margin-top: 1px;
    letter-spacing: .4px; text-transform: uppercase;
  }
  .cl-badge.new { background: rgba(79,255,176,.12); color: #4fffb0; }
  .cl-badge.fix { background: rgba(124,106,255,.12); color: #7c6aff; }
  .cl-badge.imp { background: rgba(255,203,107,.12); color: #ffcb6b; }
  .cl-badge.rem { background: rgba(255,83,112,.12); color: #ff5370; }
</style>
</head>
<body>
<div class="wrap">

  <div class="card">
    <div class="logo">⚡</div>
    <h1>Update in Progress</h1>
    <p class="sub">NexusChat is being updated.<br>This will only take a few seconds.</p>
    <div class="status-badge"><div class="dot"></div>Deploying...</div>
    <div class="progress"><div class="progress-bar"></div></div>
    <p class="refresh-note">
      Auto-refresh in <strong style="color:#e2e8f0">12 seconds</strong> &nbsp;·&nbsp;
      <a href="javascript:location.reload()">Refresh now</a>
    </p>
  </div>

  ${buildChangelogHtml()}
</div>
</body>
</html>`;

const httpServer = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');

  // Mapování URL na soubory
  const urlPath = req.url.split('?')[0];

  // Najdi NexusChat soubor — podporuje různé názvy
  function findNexusChat() {
    const names = ['NexusChat.html', 'nexuschat.html', 'index.html'];
    for (const n of names) {
      const p = path.join(__dirname, n);
      if (fs.existsSync(p)) return p;
    }
    // Zkus najít jakýkoliv .html soubor se "NexusChat" v názvu
    try {
      const files = fs.readdirSync(__dirname);
      const found = files.find(f => f.toLowerCase().includes('nexuschat') && f.endsWith('.html'));
      if (found) return path.join(__dirname, found);
    } catch {}
    return null;
  }

  if (urlPath === '/' || urlPath === '/index.html' || urlPath === '/NexusChat.html') {
    // Show loading screen during warmup (only to browsers, not health checks)
    // Show loading screen during warmup — to browsers (not API/WS clients)
    const ua = req.headers['user-agent'] || '';
    const isBrowser = ua.includes('Mozilla') || ua.includes('Chrome') || ua.includes('Safari');
    if (!serverReady && isBrowser) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=UTF-8' });
      res.end(LOADING_HTML);
      return;
    }
    const filePath = findNexusChat();
    if (filePath) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=UTF-8', 'X-Content-Type-Options': 'nosniff' });
      fs.createReadStream(filePath).pipe(res);
      return;
    }
    // NexusChat.html not ready yet — show maintenance page
    res.writeHead(503, { 'Content-Type': 'text/html; charset=UTF-8', 'Retry-After': '10' });
    res.end(MAINTENANCE_HTML);
    return;
  }

  // Admin dashboard
  if (urlPath === '/admin' || urlPath === '/admin/') {
    const ADMIN_KEY = process.env.ADMIN_KEY || 'nexus-admin-2026';
    const authHeader = req.headers['x-admin-key'] || new URL('http://x' + req.url).searchParams.get('key');
    if (authHeader !== ADMIN_KEY) {
      res.writeHead(401, { 'Content-Type': 'text/html' });
      res.end(`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Admin</title>
<style>*{margin:0;padding:0;box-sizing:border-box}body{background:#070809;font-family:system-ui;display:flex;align-items:center;justify-content:center;height:100vh;color:#e2e8f0}
.card{background:#0d0f12;border:1px solid #1f2836;border-radius:16px;padding:32px;width:360px;text-align:center}
h2{margin-bottom:16px;font-size:20px}input{width:100%;background:#070809;border:1px solid #1f2836;border-radius:8px;padding:10px;color:#e2e8f0;font-size:14px;margin-bottom:12px;outline:none}
button{width:100%;background:#4fffb0;color:#000;border:none;border-radius:8px;padding:11px;font-size:14px;font-weight:700;cursor:pointer}</style></head>
<body><div class="card"><h2>⚡ NexusChat Admin</h2>
<input type="password" id="k" placeholder="Admin klíč" onkeydown="if(event.key==='Enter')go()">
<button onclick="go()">Přihlásit se →</button></div>
<script>function go(){const k=document.getElementById('k').value;window.location='/admin?key='+encodeURIComponent(k);}</script></body></html>`);
      return;
    }

    const today = new Date().toISOString().slice(0,10);
    const yesterday = new Date(Date.now()-86400000).toISOString().slice(0,10);
    const msgsToday = stats.msgsByDay[today] || 0;
    const msgsYest  = stats.msgsByDay[yesterday] || 0;
    const usersToday = stats.usersByDay[today] ? stats.usersByDay[today].size : 0;
    const usersYest  = stats.usersByDay[yesterday] ? stats.usersByDay[yesterday].size : 0;
    const online = clients.size;
    const msgGrowth = msgsYest > 0 ? Math.round((msgsToday - msgsYest) / msgsYest * 100) : 0;
    const userGrowth = usersYest > 0 ? Math.round((usersToday - usersYest) / usersYest * 100) : 0;

    // Build chart data (last 14 days)
    const chartDays = [];
    const chartMsgs = [];
    const chartUsers = [];
    for (let i = 13; i >= 0; i--) {
      const d = new Date(Date.now() - i * 86400000).toISOString().slice(0,10);
      chartDays.push(d.slice(5));
      chartMsgs.push(stats.msgsByDay[d] || 0);
      chartUsers.push(stats.usersByDay[d] ? stats.usersByDay[d].size : 0);
    }

    const totalMessages = Object.values(history).reduce((a, b) => a + b.length, 0);
    const totalAccounts = Object.keys(accounts).length;

    res.writeHead(200, { 'Content-Type': 'text/html; charset=UTF-8' });
    res.end(`<!DOCTYPE html>
<html lang="cs"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>NexusChat Admin</title>
<script src="https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.min.js"><\/script>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{background:#070809;color:#e2e8f0;font-family:'Segoe UI',system-ui,sans-serif;min-height:100vh}
.nav{background:#0d0f12;border-bottom:1px solid #1f2836;padding:14px 28px;display:flex;align-items:center;gap:12px}
.nav-logo{font-size:20px;font-weight:800;color:#4fffb0}
.nav-sub{font-size:13px;color:#475569}
.nav-badge{background:rgba(79,255,176,.12);border:1px solid rgba(79,255,176,.25);color:#4fffb0;font-size:11px;padding:3px 10px;border-radius:20px;font-weight:600}
.page{padding:28px;max-width:1200px;margin:0 auto}
.section-title{font-size:12px;font-weight:700;color:#475569;letter-spacing:1px;text-transform:uppercase;margin-bottom:14px}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:14px;margin-bottom:28px}
.card{background:#0d0f12;border:1px solid #1f2836;border-radius:14px;padding:22px 24px;transition:border-color .2s}
.card:hover{border-color:#2d3748}
.card-icon{font-size:28px;margin-bottom:10px}
.card-val{font-size:34px;font-weight:800;color:#f1f5f9;line-height:1;margin-bottom:4px}
.card-label{font-size:13px;color:#64748b;margin-bottom:8px}
.growth{font-size:12px;font-weight:700;padding:3px 8px;border-radius:6px}
.growth.up{background:rgba(79,255,176,.1);color:#4fffb0}
.growth.dn{background:rgba(255,83,112,.1);color:#ff5370}
.growth.neu{background:rgba(100,116,139,.1);color:#64748b}
.chart-card{background:#0d0f12;border:1px solid #1f2836;border-radius:14px;padding:22px 24px;margin-bottom:28px}
.chart-title{font-size:14px;font-weight:700;color:#e2e8f0;margin-bottom:16px}
canvas{max-height:220px}
.table-card{background:#0d0f12;border:1px solid #1f2836;border-radius:14px;overflow:hidden;margin-bottom:28px}
.table-head{display:grid;grid-template-columns:1fr 1fr 1fr 1fr;padding:12px 20px;border-bottom:1px solid #1f2836;font-size:11px;color:#475569;font-weight:700;text-transform:uppercase;letter-spacing:.5px}
.table-row{display:grid;grid-template-columns:1fr 1fr 1fr 1fr;padding:12px 20px;border-bottom:1px solid #0a0c0f;font-size:13px;transition:background .15s}
.table-row:hover{background:#111318}
.table-row:last-child{border-bottom:none}
.online-dot{width:7px;height:7px;border-radius:50%;background:#4fffb0;display:inline-block;box-shadow:0 0 6px #4fffb0;margin-right:6px}
.refresh-btn{background:transparent;border:1px solid #1f2836;color:#94a3b8;border-radius:8px;padding:7px 16px;cursor:pointer;font-size:12px;font-family:inherit;transition:all .2s}
.refresh-btn:hover{border-color:#4fffb0;color:#4fffb0}
</style></head>
<body>
<div class="nav">
  <span class="nav-logo">⚡ NexusChat</span>
  <span class="nav-sub">Admin Dashboard</span>
  <span class="nav-badge">🟢 Server běží</span>
  <button class="refresh-btn" style="margin-left:auto" onclick="location.reload()">↻ Obnovit</button>
</div>
<div class="page">

  <div class="section-title">📊 Přehled dnes</div>
  <div class="grid">
    <div class="card">
      <div class="card-icon">👥</div>
      <div class="card-val">${online}</div>
      <div class="card-label">Aktivní uživatelé (online)</div>
      <span class="growth neu">🟢 právě teď</span>
    </div>
    <div class="card">
      <div class="card-icon">📊</div>
      <div class="card-val">${usersToday}</div>
      <div class="card-label">Unikátní uživatelé dnes</div>
      <span class="growth ${userGrowth >= 0 ? 'up' : 'dn'}">${userGrowth >= 0 ? '↑' : '↓'} ${Math.abs(userGrowth)}% oproti včera</span>
    </div>
    <div class="card">
      <div class="card-icon">💬</div>
      <div class="card-val">${msgsToday}</div>
      <div class="card-label">Zprávy dnes</div>
      <span class="growth ${msgGrowth >= 0 ? 'up' : 'dn'}">${msgGrowth >= 0 ? '↑' : '↓'} ${Math.abs(msgGrowth)}% oproti včera</span>
    </div>
    <div class="card">
      <div class="card-icon">🗄️</div>
      <div class="card-val">${totalAccounts}</div>
      <div class="card-label">Celkem účtů</div>
      <span class="growth neu">📈 celkem</span>
    </div>
    <div class="card">
      <div class="card-icon">📨</div>
      <div class="card-val">${totalMessages}</div>
      <div class="card-label">Zprávy v historii</div>
      <span class="growth neu">uloženo na serveru</span>
    </div>
    <div class="card">
      <div class="card-icon">🌐</div>
      <div class="card-val">${Object.keys(serverData).length}</div>
      <div class="card-label">Aktivní servery</div>
      <span class="growth neu">v paměti serveru</span>
    </div>
  </div>

  <div class="chart-card">
    <div class="chart-title">💬 Zprávy posledních 14 dní</div>
    <canvas id="msgChart"></canvas>
  </div>

  <div class="chart-card">
    <div class="chart-title">👥 Unikátní uživatelé posledních 14 dní</div>
    <canvas id="userChart"></canvas>
  </div>

  <div class="section-title">⏰ Denní přehled (posledních 14 dní)</div>
  <div class="table-card">
    <div class="table-head"><span>Datum</span><span>Uživatelé</span><span>Zprávy</span><span>Trend</span></div>
    ${chartDays.slice().reverse().map((day, i) => {
      const ri = chartDays.length - 1 - i;
      const u = chartUsers[ri], m = chartMsgs[ri];
      const pu = chartUsers[ri-1] || 0, pm = chartMsgs[ri-1] || 0;
      const trend = m > pm ? '↑' : m < pm ? '↓' : '→';
      const tcolor = m > pm ? '#4fffb0' : m < pm ? '#ff5370' : '#64748b';
      return '<div class="table-row"><span>' + (i===0?'<span class="online-dot"></span>Dnes':'Před '+(i)+' dny') + '</span><span>'+u+'</span><span>'+m+'</span><span style="color:'+tcolor+'">'+trend+'</span></div>';
    }).join('')}
  </div>

</div>
<script>
const chartOpts = (color) => ({
  responsive: true, maintainAspectRatio: true,
  plugins: { legend: { display: false }, tooltip: { backgroundColor: '#0d0f12', borderColor: '#1f2836', borderWidth: 1, titleColor: '#94a3b8', bodyColor: '#e2e8f0' } },
  scales: {
    x: { grid: { color: '#1f2836' }, ticks: { color: '#475569', font: { size: 11 } } },
    y: { grid: { color: '#1f2836' }, ticks: { color: '#475569', font: { size: 11 } }, beginAtZero: true }
  }
});
new Chart(document.getElementById('msgChart'), {
  type: 'bar',
  data: { labels: ${JSON.stringify(chartDays)}, datasets: [{ data: ${JSON.stringify(chartMsgs)}, backgroundColor: 'rgba(79,255,176,.6)', borderColor: '#4fffb0', borderWidth: 1, borderRadius: 4 }] },
  options: chartOpts('#4fffb0')
});
new Chart(document.getElementById('userChart'), {
  type: 'line',
  data: { labels: ${JSON.stringify(chartDays)}, datasets: [{ data: ${JSON.stringify(chartUsers)}, borderColor: '#7c6aff', backgroundColor: 'rgba(124,106,255,.1)', borderWidth: 2, fill: true, tension: 0.4, pointBackgroundColor: '#7c6aff', pointRadius: 4 }] },
  options: chartOpts('#7c6aff')
});
// Auto refresh every 30s
setTimeout(() => location.reload(), 30000);
<\/script>
</body></html>`);
    return;
  }

  // ── DEV PANEL ────────────────────────────────────────────────────
  if (urlPath === '/dev' || urlPath === '/dev/') {
    const DEV_KEY = process.env.DEV_KEY || 'nexus-dev-2026';
    const key = new URL('http://x' + req.url).searchParams.get('key') || req.headers['x-dev-key'] || '';
    if (key !== DEV_KEY) {
      res.writeHead(200, {'Content-Type':'text/html;charset=UTF-8'});
      res.end('<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Dev</title>'
        + '<style>*{margin:0;padding:0;box-sizing:border-box}body{background:#050507;font-family:monospace;display:flex;align-items:center;justify-content:center;height:100vh;color:#00ff88}'
        + '.b{width:300px;padding:24px;border:1px solid #00ff8833;border-radius:4px}'
        + 'h2{margin-bottom:16px;font-size:13px;letter-spacing:3px}'
        + 'input{width:100%;background:#0a0a0f;border:1px solid #1a1a2e;padding:8px;color:#00ff88;font-family:monospace;outline:none;margin-bottom:8px;border-radius:2px}'
        + 'button{width:100%;background:transparent;border:1px solid #00ff8844;color:#00ff88;padding:8px;font-family:monospace;cursor:pointer}'
        + '</style></head><body>'
        + '<div class="b"><h2>// DEV_ACCESS</h2>'
        + '<input type="password" id="k" placeholder="dev key..." onkeydown="if(event.key===\'Enter\')g()">'
        + '<button onclick="g()">ENTER</button></div>'
        + '<script>function g(){location.href=\'/dev?key=\'+document.getElementById(\'k\').value}<\/script>'
        + '</body></html>');
      return;
    }

    // Build data
    const onlineMap = {};
    for (const [, info] of clients) { if (info.id) onlineMap[info.id] = info; }

    const allAccs = Object.entries(accounts).map(function(e) {
      var id = e[0], acc = e[1], p = acc.profile || {};
      return {
        id: id,
        name: p.name || '?',
        color: p.color || '#888',
        status: p.status || '-',
        servers: Object.keys(acc.servers || {}).length,
        lastSeen: acc.ts ? new Date(acc.ts).toISOString().slice(0,16).replace('T',' ') : 'never',
        online: !!onlineMap[id]
      };
    }).sort(function(a,b){ return b.lastSeen > a.lastSeen ? 1 : -1; });

    const allOnline = Object.values(onlineMap).map(function(i) {
      return { id: i.id || '', name: i.name || '?', ip: i.ip || '?' };
    });

    const allSrvs = Object.entries(serverData).map(function(e) {
      var id = e[0], s = e[1];
      return {
        id: id, name: s.name || '?',
        cats: (s.cats||[]).length,
        chs: (s.cats||[]).reduce(function(a,c){return a+(c.chs||[]).length;},0)
      };
    });

    const allBans = Object.entries(bannedUsers || {}).map(function(e) {
      var id = e[0], info = e[1];
      return { id: id, reason: info.reason || '-', ts: info.ts ? new Date(info.ts).toISOString().slice(0,10) : '-' };
    });

    const today = new Date().toISOString().slice(0,10);
    const statsObj = {
      accounts: allAccs.length,
      online: clients.size,
      today: (stats.usersByDay[today] || {size:0}).size,
      bans: allBans.length,
      msgs: stats.msgsByDay[today] || 0,
      servers: allSrvs.length
    };

    // Serialize data safely
    const dataJson = JSON.stringify({
      accounts: allAccs,
      online: allOnline,
      servers: allSrvs,
      bans: allBans,
      stats: statsObj,
      key: DEV_KEY
    });

    const html = '<!DOCTYPE html><html><head><meta charset="UTF-8">'
      + '<meta name="viewport" content="width=device-width,initial-scale=1">'
      + '<title>NexusChat Dev</title>'
      + '<link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;600;700&display=swap" rel="stylesheet">'
      + '<style>'
      + ':root{--bg:#050507;--bg1:#0a0a0f;--bg2:#0f0f1a;--bg3:#141420;--acc:#00ff88;--p:#7c6aff;--r:#ff4466;--y:#ffcc00;--t1:#e2e8f0;--t2:#94a3b8;--t3:#475569;--bd:#1a1a2e}'
      + '*{margin:0;padding:0;box-sizing:border-box}'
      + 'html,body{background:var(--bg);color:var(--t1);font-family:"JetBrains Mono",monospace;font-size:13px;min-height:100vh}'
      + 'nav{display:flex;align-items:center;gap:10px;padding:10px 18px;background:var(--bg1);border-bottom:1px solid var(--bd);position:sticky;top:0;z-index:50}'
      + '.nl{font-size:16px;font-weight:700;color:var(--acc)}'
      + '.nt{font-size:10px;color:var(--t3);letter-spacing:2px}'
      + '.ns{display:flex;align-items:center;gap:6px;margin-left:auto;font-size:11px;color:var(--acc)}'
      + '.dot{width:7px;height:7px;border-radius:50%;background:var(--acc);box-shadow:0 0 6px var(--acc);animation:bl 2s infinite}'
      + '@keyframes bl{0%,100%{opacity:1}50%{opacity:.3}}'
      + '.nb{background:transparent;border:1px solid var(--bd);color:var(--t3);padding:4px 10px;border-radius:2px;cursor:pointer;font-family:"JetBrains Mono";font-size:10px}'
      + '.nb:hover{border-color:var(--acc);color:var(--acc)}'
      + '.lay{display:flex;min-height:calc(100vh - 41px)}'
      + '.sb{width:170px;flex-shrink:0;background:var(--bg1);border-right:1px solid var(--bd);padding:10px 0}'
      + '.si{padding:9px 16px;cursor:pointer;font-size:10px;letter-spacing:1.5px;color:var(--t3);transition:all .15s;display:flex;align-items:center;gap:6px;text-transform:uppercase;border-left:2px solid transparent}'
      + '.si:hover{color:var(--t1);background:rgba(255,255,255,.03)}'
      + '.si.act{color:var(--acc);border-left-color:var(--acc);background:rgba(0,255,136,.05)}'
      + '.ct{background:var(--p);color:#fff;font-size:9px;padding:1px 5px;border-radius:2px;margin-left:auto}'
      + '.mn{flex:1;padding:18px;overflow-y:auto}'
      + '.pnl{display:none}.pnl.act{display:block}'
      + '.sts{display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:10px;margin-bottom:18px}'
      + '.sc{background:var(--bg2);border:1px solid var(--bd);border-radius:4px;padding:12px}'
      + '.sv{font-size:24px;font-weight:700;margin-bottom:2px}'
      + '.sl{font-size:9px;color:var(--t3);letter-spacing:1px;text-transform:uppercase}'
      + '.tbl{background:var(--bg2);border:1px solid var(--bd);border-radius:4px;overflow:hidden;margin-bottom:14px}'
      + '.th{padding:8px 12px;background:var(--bg3);font-size:9px;color:var(--t3);letter-spacing:1px;text-transform:uppercase;border-bottom:1px solid var(--bd);display:grid;gap:8px}'
      + '.tr{padding:9px 12px;border-bottom:1px solid #0a0a0f;display:grid;gap:8px;align-items:center}'
      + '.tr:hover{background:rgba(0,255,136,.03)}'
      + '.tr:last-child{border-bottom:none}'
      + '.av{width:24px;height:24px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:700;flex-shrink:0}'
      + '.on{background:rgba(0,255,136,.15);color:var(--acc);border:1px solid rgba(0,255,136,.3);font-size:9px;padding:2px 6px;border-radius:2px}'
      + '.of{background:rgba(71,85,105,.1);color:var(--t3);border:1px solid var(--bd);font-size:9px;padding:2px 6px;border-radius:2px}'
      + '.ab{background:transparent;border:1px solid var(--bd);color:var(--t2);padding:2px 7px;border-radius:2px;cursor:pointer;font-family:"JetBrains Mono";font-size:9px;transition:all .15s;white-space:nowrap}'
      + '.ab:hover{border-color:var(--acc);color:var(--acc)}'
      + '.ab.r:hover{border-color:var(--r);color:var(--r)}'
      + '.ab.g:hover{border-color:var(--acc);color:var(--acc)}'
      + '.sec{font-size:9px;letter-spacing:2px;text-transform:uppercase;color:var(--t3);margin-bottom:10px;display:flex;align-items:center;gap:8px}'
      + '.sec::after{content:"";flex:1;height:1px;background:var(--bd)}'
      + '.sinp{width:100%;background:var(--bg2);border:1px solid var(--bd);border-radius:3px;padding:7px 10px;color:var(--t1);font-family:"JetBrains Mono";font-size:12px;outline:none;margin-bottom:10px}'
      + '.sinp:focus{border-color:var(--acc)}'
      + '.em{padding:18px;text-align:center;color:var(--t3);font-size:11px}'
      + '.mb{display:none;position:fixed;inset:0;background:rgba(0,0,0,.88);z-index:999;align-items:center;justify-content:center}'
      + '.mb.open{display:flex}'
      + '.mc{background:var(--bg1);border:1px solid var(--bd);border-radius:6px;padding:20px;width:min(420px,92vw);max-height:80vh;overflow-y:auto}'
      + '.mh{font-size:10px;letter-spacing:2px;color:var(--acc);margin-bottom:12px;text-transform:uppercase}'
      + '.mr{margin-bottom:8px;font-size:12px}'
      + '.ml{color:var(--t3);font-size:9px;letter-spacing:1px;text-transform:uppercase;margin-bottom:3px}'
      + '.mf{display:flex;gap:8px;justify-content:flex-end;margin-top:12px}'
      + '.agrid{display:grid;grid-template-columns:1fr 1fr;gap:12px}'
      + '.ac{background:var(--bg2);border:1px solid var(--bd);border-radius:4px;padding:16px}'
      + '.at{font-size:9px;letter-spacing:1.5px;color:var(--acc);text-transform:uppercase;margin-bottom:10px}'
      + '.lb{background:#020204;border:1px solid var(--bd);border-radius:3px;padding:10px;font-size:11px;line-height:1.8;max-height:280px;overflow-y:auto;color:var(--t3)}'
      + '.la{color:var(--acc)}.le{color:var(--r)}.li{color:var(--p)}.ly{color:var(--y)}'
      + 'textarea.sinp{resize:vertical;min-height:80px}'
      + '</style></head><body>'

      + '<nav><span class="nl">⚡ NexusChat</span><span class="nt">// DEV</span>'
      + '<div class="ns"><div class="dot"></div><span id="n-st">...</span></div>'
      + '<button class="nb" onclick="location.reload()">↻ REFRESH</button></nav>'

      + '<div class="lay"><div class="sb">'
      + '<div class="si act" data-t="accounts" onclick="sw(this)">ACCOUNTS <span class="ct" id="ct-a">0</span></div>'
      + '<div class="si" data-t="servers" onclick="sw(this)">SERVERS <span class="ct" id="ct-s">0</span></div>'
      + '<div class="si" data-t="online" onclick="sw(this)">ONLINE <span class="ct" id="ct-o">0</span></div>'
      + '<div class="si" data-t="bans" onclick="sw(this)">BANS <span class="ct" id="ct-b">0</span></div>'
      + '<div style="height:1px;background:var(--bd);margin:8px 10px"></div>'
      + '<div class="si" data-t="actions" onclick="sw(this)">ACTIONS</div>'
      + '</div>'

      + '<div class="mn">'
      + '<div class="pnl act" id="pnl-accounts"><div class="sts" id="sts"></div>'
      + '<div class="sec">ALL ACCOUNTS</div>'
      + '<input class="sinp" placeholder="search name or id..." oninput="flt(\'tb-a\',this.value)">'
      + '<div class="tbl" id="tb-a">'
      + '<div class="th" style="grid-template-columns:24px 1fr 130px 50px 65px 80px"><span></span><span>NAME/ID</span><span>LAST SEEN</span><span>SRVS</span><span>STATUS</span><span>ACTIONS</span></div>'
      + '<div id="rows-a"></div></div></div>'

      + '<div class="pnl" id="pnl-servers"><div class="sec">SERVERS IN MEMORY</div>'
      + '<div class="tbl">'
      + '<div class="th" style="grid-template-columns:1fr 110px 50px 50px 90px"><span>NAME</span><span>ID</span><span>CATS</span><span>CHS</span><span>ACTIONS</span></div>'
      + '<div id="rows-s"></div></div></div>'

      + '<div class="pnl" id="pnl-online"><div class="sec">CONNECTED NOW</div>'
      + '<div class="tbl">'
      + '<div class="th" style="grid-template-columns:1fr 170px 110px 70px"><span>NAME</span><span>ID</span><span>IP</span><span>ACTIONS</span></div>'
      + '<div id="rows-o"></div></div></div>'

      + '<div class="pnl" id="pnl-bans"><div class="sec">BANNED USERS</div>'
      + '<div class="tbl">'
      + '<div class="th" style="grid-template-columns:160px 1fr 80px 70px"><span>ID</span><span>REASON</span><span>DATE</span><span>ACTION</span></div>'
      + '<div id="rows-b"></div></div></div>'

      + '<div class="pnl" id="pnl-actions"><div class="sec">ACTIONS</div>'
      + '<div class="agrid">'
      + '<div class="ac"><div class="at">📢 Broadcast to all</div>'
      + '<textarea class="sinp" id="bc-msg" placeholder="Message to all users..."></textarea>'
      + '<button class="ab g" style="width:100%;padding:6px" onclick="act(\'broadcast\',{msg:document.getElementById(\'bc-msg\').value})">SEND TO ALL</button></div>'
      + '<div class="ac"><div class="at">📊 Status</div><div class="lb" id="stat-log"></div></div>'
      + '</div></div>'

      + '</div></div>'

      + '<div class="mb" id="mdl"><div class="mc">'
      + '<div class="mh" id="mdl-t">DETAIL</div>'
      + '<div id="mdl-b"></div>'
      + '<div class="mf"><button class="ab" onclick="document.getElementById(\'mdl\').classList.remove(\'open\')">CLOSE</button></div>'
      + '</div></div>'

      + '<script>'
      + 'var D=' + dataJson + ';'
      + 'var K=D.key,BASE=location.origin;'

      + 'document.getElementById("n-st").textContent=D.stats.online+" online";'
      + 'document.getElementById("ct-a").textContent=D.accounts.length;'
      + 'document.getElementById("ct-s").textContent=D.servers.length;'
      + 'document.getElementById("ct-o").textContent=D.online.length;'
      + 'document.getElementById("ct-b").textContent=D.bans.length;'

      // Stats
      + 'var sc=document.getElementById("sts");'
      + 'sc.innerHTML=['
      + '["var(--acc)",D.stats.accounts,"Total accounts"],'
      + '["var(--p)",D.stats.online,"Online now"],'
      + '["var(--y)",D.stats.today,"Active today"],'
      + '["var(--r)",D.stats.bans,"Banned"],'
      + '["var(--t1)",D.stats.msgs,"Msgs today"],'
      + '["var(--acc)",D.stats.servers,"Servers"]'
      + '].map(function(x){return\'<div class="sc"><div class="sv" style="color:\'+x[0]+\'">\'+x[1]+\'</div><div class="sl">\'+x[2]+\'</div></div>\';}).join("");'

      // Accounts rows
      + 'var ra=document.getElementById("rows-a");'
      + 'if(!D.accounts.length){ra.innerHTML=\'<div class="em">No accounts yet</div>\';}else{'
      + 'ra.innerHTML=D.accounts.map(function(a){'
      + 'var col=a.color||"#888";'
      + 'var initial=(a.name&&a.name[0]||"?").toUpperCase();'
      + 'var av=\'<div class="av" style="background:\'+col+\';color:#000">\'+initial+\'</div>\';'
      + 'var badge=a.online?\'<span class="on">● LIVE</span>\':\'<span class="of">○ off</span>\';'
      + 'var sid=a.id.replace(/\'/g,"\\\\\'");'
      + 'var sname=(a.name||"").replace(/\'/g,"\\\\\'");'
      + 'return \'<div class="tr" style="grid-template-columns:24px 1fr 130px 50px 65px 80px" data-s="\'+((a.name||"")+a.id).toLowerCase()+\'">\''
      + '+av'
      + '+\'<div><div style="color:var(--t1);font-weight:600">\'+a.name+\'</div><div style="font-size:10px;color:var(--t3)">\'+a.id.slice(0,22)+\'...</div></div>\''
      + '+\'<div style="color:var(--t3);font-size:11px">\'+a.lastSeen+\'</div>\''
      + '+\'<div style="color:var(--p)">\'+a.servers+\'</div>\''
      + '+badge'
      + '+\'<div style="display:flex;gap:3px"><button class="ab" onclick="vAcc(\\\'\'+sid+\'\\\')" >VIEW</button>\''
      + '+\'<button class="ab r" onclick="doBan(\\\'\'+sid+\'\\\',\\\'\'+sname+\'\\\')" >BAN</button></div>\''
      + '+\'</div>\';'
      + '}).join("");}'

      // Servers rows
      + 'var rs=document.getElementById("rows-s");'
      + 'if(!D.servers.length){rs.innerHTML=\'<div class="em">No servers in memory</div>\';}else{'
      + 'rs.innerHTML=D.servers.map(function(s){'
      + 'var sid=s.id.replace(/\'/g,"\\\\\'");'
      + 'var sname=(s.name||"").replace(/\'/g,"\\\\\'");'
      + 'return\'<div class="tr" style="grid-template-columns:1fr 110px 50px 50px 90px">\''
      + '+\'<div style="color:var(--t1);font-weight:600">\'+s.name+\'</div>\''
      + '+\'<div style="color:var(--t3);font-size:10px">\'+s.id.slice(0,14)+\'...</div>\''
      + '+\'<div style="color:var(--p)">\'+s.cats+\'</div>\''
      + '+\'<div style="color:var(--p)">\'+s.chs+\'</div>\''
      + '+\'<div style="display:flex;gap:3px">\''
      + '+\'<button class="ab g" onclick="cpInv(\\\'\'+sid+\'\\\',\\\'\'+sname+\'\\\')" >INVITE</button>\''
      + '+\'<button class="ab" onclick="window.open(\\\'\'+ BASE +\'/invite?id=\'+sid+\'&s=\'+encodeURIComponent(s.name)+\'\\\')" >OPEN</button>\''
      + '+\'</div></div>\';'
      + '}).join("");}'

      // Online rows
      + 'var ro=document.getElementById("rows-o");'
      + 'if(!D.online.length){ro.innerHTML=\'<div class="em">No users online</div>\';}else{'
      + 'ro.innerHTML=D.online.map(function(u){'
      + 'var uid=u.id.replace(/\'/g,"\\\\\'");'
      + 'return\'<div class="tr" style="grid-template-columns:1fr 170px 110px 70px">\''
      + '+\'<div style="color:var(--acc);font-weight:600">● \'+u.name+\'</div>\''
      + '+\'<div style="color:var(--t3);font-size:10px">\'+u.id.slice(0,22)+\'...</div>\''
      + '+\'<div style="color:var(--t3);font-size:10px">\'+u.ip+\'</div>\''
      + '+\'<button class="ab r" onclick="act(\\\'kick\\\',{id:\\\'\'+uid+\'\\\'})">KICK</button>\''
      + '+\'</div>\';'
      + '}).join("");}'

      // Bans rows
      + 'var rb=document.getElementById("rows-b");'
      + 'if(!D.bans.length){rb.innerHTML=\'<div class="em">No bans</div>\';}else{'
      + 'rb.innerHTML=D.bans.map(function(b){'
      + 'var bid=b.id.replace(/\'/g,"\\\\\'");'
      + 'return\'<div class="tr" style="grid-template-columns:160px 1fr 80px 70px">\''
      + '+\'<div style="color:var(--t3);font-size:10px">\'+b.id.slice(0,22)+\'...</div>\''
      + '+\'<div style="color:var(--t2)">\'+b.reason+\'</div>\''
      + '+\'<div style="color:var(--t3);font-size:10px">\'+b.ts+\'</div>\''
      + '+\'<button class="ab g" onclick="act(\\\'unban\\\',{id:\\\'\'+bid+\'\\\'})">UNBAN</button>\''
      + '+\'</div>\';'
      + '}).join("");}'

      // Status log
      + 'document.getElementById("stat-log").innerHTML='
      + '"<span class=\\"la\\">✓ online</span>\\n"'
      + '+"<span class=\\"li\\"> accounts: "+D.stats.accounts+"</span>\\n"'
      + '+"<span class=\\"li\\"> online: "+D.stats.online+"</span>\\n"'
      + '+"<span class=\\"li\\"> servers: "+D.stats.servers+"</span>\\n"'
      + '+"<span class=\\"ly\\"> msgs today: "+D.stats.msgs+"</span>\\n"'
      + '+"<span class=\\"la\\"> active today: "+D.stats.today+"</span>\\n"'
      + '+"<span class=\\"le\\"> bans: "+D.stats.bans+"</span>";'

      // Functions
      + 'function sw(el){'
      + 'document.querySelectorAll(".si").forEach(function(s){s.classList.remove("act");});'
      + 'document.querySelectorAll(".pnl").forEach(function(p){p.classList.remove("act");});'
      + 'el.classList.add("act");'
      + 'document.getElementById("pnl-"+el.dataset.t).classList.add("act");}'

      + 'function flt(id,q){'
      + 'document.querySelectorAll("#"+id+" .tr").forEach(function(r){'
      + 'r.style.display=(!q||(r.dataset.s||"").includes(q.toLowerCase()))?"":"none";});}'

      + 'function vAcc(id){'
      + 'var a=D.accounts.find(function(x){return x.id===id;});'
      + 'if(!a)return;'
      + 'var sid=a.id.replace(/\'/g,"\\\\\'");'
      + 'var sname=(a.name||"").replace(/\'/g,"\\\\\'");'
      + 'document.getElementById("mdl-t").textContent="ACCOUNT // "+a.name;'
      + 'document.getElementById("mdl-b").innerHTML='
      + '"<div class=\\"mr\\"><div class=\\"ml\\">ID</div><div style=\\"color:var(--acc);font-size:11px;word-break:break-all\\">"+a.id+"</div></div>"'
      + '+"<div class=\\"mr\\"><div class=\\"ml\\">Name</div>"+a.name+"</div>"'
      + '+"<div class=\\"mr\\"><div class=\\"ml\\">Color</div><span style=\\"color:"+a.color+"\\">"+a.color+"</span></div>"'
      + '+"<div class=\\"mr\\"><div class=\\"ml\\">Servers</div>"+a.servers+"</div>"'
      + '+"<div class=\\"mr\\"><div class=\\"ml\\">Last seen</div>"+a.lastSeen+"</div>"'
      + '+"<div class=\\"mr\\"><div class=\\"ml\\">Status</div>"+(a.online?"<span class=\\"on\\">● ONLINE</span>":"<span class=\\"of\\">○ offline</span>")+"</div>"'
      + '+"<div style=\\"display:flex;gap:8px;margin-top:12px\\">"'
      + '+"<button class=\\"ab r\\" onclick=\\"doBan(\'"+sid+"\',\'"+sname+"\')\\" >BAN USER</button>"'
      + '+"<button class=\\"ab r\\" onclick=\\"act(\'kick\',{id:\'"+sid+"\'})\\">KICK</button>"'
      + '+"</div>";'
      + 'document.getElementById("mdl").classList.add("open");}'

      + 'function doBan(id,name){'
      + 'var reason=prompt("Ban \\""+name+"\\" — reason:","Banned by admin");'
      + 'if(reason===null)return;'
      + 'act("ban",{id:id,reason:reason});}'

      + 'function cpInv(id,name){'
      + 'var url=BASE+"/invite?id="+id+"&s="+encodeURIComponent(name);'
      + 'if(navigator.clipboard){navigator.clipboard.writeText(url).then(function(){alert("Copied!\\n"+url);});}else{prompt("Copy URL:",url);}}'

      + 'function act(action,params){'
      + 'var qs=Object.entries(params).map(function(e){return e[0]+"="+encodeURIComponent(e[1]);}).join("&");'
      + 'var url=BASE+"/dev/api?key="+K+"&action="+action+"&"+qs;'
      + 'fetch(url).then(function(r){return r.json();}).then(function(d){'
      + 'if(d.ok){alert(d.msg||action+" done");location.reload();}else{alert("Error: "+(d.error||"?"));}}).catch(function(e){alert("Failed: "+e.message);}); }'

      + 'setTimeout(function(){location.reload();},60000);'
      + '<\/script></body></html>';

    res.writeHead(200, {'Content-Type':'text/html;charset=UTF-8'});
    res.end(html);
    return;
  }

  // ── DEV API ────────────────────────────────────────────────────────
  if (urlPath === '/dev/api') {
    const DEV_KEY = process.env.DEV_KEY || 'nexus-dev-2026';
    const params  = new URL('http://x' + req.url).searchParams;
    if (params.get('key') !== DEV_KEY) {
      res.writeHead(401, {'Content-Type':'application/json'});
      res.end('{"ok":false,"error":"unauthorized"}');
      return;
    }
    const action = params.get('action') || '';
    const id     = params.get('id')     || '';
    const j = function(obj) { res.writeHead(200,{'Content-Type':'application/json'}); res.end(JSON.stringify(obj)); };

    if (action === 'ban') {
      const reason = params.get('reason') || 'Banned by admin';
      bannedUsers[id] = { reason: reason, ts: Date.now() };
      saveBans();
      for (const [ws2, info] of clients) {
        if (info.id === id) { try { ws2.send(JSON.stringify({type:'you_are_banned',reason:reason})); ws2.close(); } catch {} }
      }
      j({ok:true, msg:'Banned '+id.slice(0,10)});

    } else if (action === 'kick') {
      let kicked = false;
      for (const [ws2, info] of clients) {
        if (info.id === id) { try { ws2.send(JSON.stringify({type:'you_are_kicked',reason:'Kicked by admin'})); ws2.close(); kicked=true; } catch {} }
      }
      j({ok:true, msg: kicked ? 'Kicked' : 'Not online'});

    } else if (action === 'unban') {
      delete bannedUsers[id];
      saveBans();
      j({ok:true, msg:'Unbanned'});

    } else if (action === 'broadcast') {
      const msg = params.get('msg') || '';
      let count = 0;
      for (const [ws2] of clients) {
        try {
          ws2.send(JSON.stringify({
            type:'chat', ch:'__broadcast__', srvId:'__sys__',
            msg:{mid:Math.random().toString(36).slice(2), author:'📢 System',
              authorId:'__sys__', color:'#4fffb0', text:msg, ts:Date.now(), reactions:[]}
          }));
          count++;
        } catch {}
      }
      j({ok:true, msg:'Sent to '+count+' users'});

    } else {
      j({ok:false, error:'unknown action'});
    }
    return;
  }

  if (urlPath === '/admin/api') {
    const ADMIN_KEY = process.env.ADMIN_KEY || 'nexus-admin-2026';
    const authHeader = req.headers['x-admin-key'];
    if (authHeader !== ADMIN_KEY) { res.writeHead(401); res.end('{}'); return; }
    const today = new Date().toISOString().slice(0,10);
    const yesterday = new Date(Date.now()-86400000).toISOString().slice(0,10);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      online: clients.size,
      usersToday: stats.usersByDay[today] ? stats.usersByDay[today].size : 0,
      usersYesterday: stats.usersByDay[yesterday] ? stats.usersByDay[yesterday].size : 0,
      msgsToday: stats.msgsByDay[today] || 0,
      msgsYesterday: stats.msgsByDay[yesterday] || 0,
      totalAccounts: Object.keys(accounts).length,
      totalMessages: Object.values(history).reduce((a, b) => a + b.length, 0),
    }));
    return;
  }

  if (urlPath === '/download') {
    const dlPath = path.join(__dirname, 'download.html');
    if (fs.existsSync(dlPath)) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=UTF-8' });
      fs.createReadStream(dlPath).pipe(res);
    } else {
      res.writeHead(302, { 'Location': 'https://github.com/Tomik299-design/nexus/releases' });
      res.end();
    }
    return;
  }

  if (urlPath === '/invite' || urlPath === '/invite.html') {
    const filePath = path.join(__dirname, 'invite.html');
    if (fs.existsSync(filePath)) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=UTF-8', 'X-Content-Type-Options': 'nosniff' });
      fs.createReadStream(filePath).pipe(res);
      return;
    }
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('invite.html nenalezen');
    return;
  }

  if (req.url === '/health' || req.url === '/ping') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', clients: clients.size, uptime: Math.round(process.uptime()) }));
    return;
  }

  if (urlPath === '/auth/set-password' && req.method === 'POST') {
    let body = '';
    req.on('data', d => { body += d; if (body.length > 8192) req.destroy(); });
    req.on('end', () => {
      let parsed; try { parsed = JSON.parse(body); } catch { res.writeHead(400,'',{'Content-Type':'application/json'}); res.end('{"ok":false,"error":"invalid json"}'); return; }
      const userId   = (parsed.userId   || '');
      const email    = (parsed.email    || '').toLowerCase().trim();
      const password = (parsed.password || '');
      if (!userId) { res.writeHead(400,'',{'Content-Type':'application/json'}); res.end('{"ok":false,"error":"Chybí userId"}'); return; }
      if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { res.writeHead(400,'',{'Content-Type':'application/json'}); res.end('{"ok":false,"error":"Neplatný email"}'); return; }
      if (!password || password.length < 6) { res.writeHead(400,'',{'Content-Type':'application/json'}); res.end('{"ok":false,"error":"Heslo musí mít alespoň 6 znaků"}'); return; }
      // Check email not already taken by different account
      if (authData[email] && authData[email].userId !== userId) { res.writeHead(409,'',{'Content-Type':'application/json'}); res.end('{"ok":false,"error":"Tento email je již registrován na jiný účet"}'); return; }
      // Find username from accounts (legacy account store)
      const username = accounts[userId]?.profile?.name || parsed.username || 'Uživatel';
      const salt     = genToken(16);
      const passHash = hashPass(password, salt);
      authData[email] = { userId, passHash, salt, username, createdAt: Date.now() };
      saveAuth();
      res.writeHead(200,'',{'Content-Type':'application/json'});
      res.end(JSON.stringify({ ok: true, userId, username, email }));
    });
    return;
  }

  if (urlPath === '/auth/has-email' && req.method === 'GET') {
    const params = new URL('http://x' + req.url).searchParams;
    const userId = (params.get('userId') || '');
    const has = Object.values(authData).some(a => a.userId === userId);
    res.writeHead(200,'',{'Content-Type':'application/json'});
    res.end(JSON.stringify({ ok: true, hasEmail: has }));
    return;
  }

  // ── AUTH ROUTES ───────────────────────────────────────────────────
  if (urlPath === '/auth/register' && req.method === 'POST') {
    let body = '';
    req.on('data', d => { body += d; if (body.length > 8192) req.destroy(); });
    req.on('end', () => {
      let parsed; try { parsed = JSON.parse(body); } catch { res.writeHead(400,'',{'Content-Type':'application/json'}); res.end('{"ok":false,"error":"invalid json"}'); return; }
      const email    = (parsed.email    || '').toLowerCase().trim();
      const username = (parsed.username || '').trim();
      const password = (parsed.password || '');
      if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { res.writeHead(400,'',{'Content-Type':'application/json'}); res.end('{"ok":false,"error":"Neplatný email"}'); return; }
      if (!username || username.length < 2 || username.length > 32) { res.writeHead(400,'',{'Content-Type':'application/json'}); res.end('{"ok":false,"error":"Přezdívka musí mít 2–32 znaků"}'); return; }
      if (!password || password.length < 6) { res.writeHead(400,'',{'Content-Type':'application/json'}); res.end('{"ok":false,"error":"Heslo musí mít alespoň 6 znaků"}'); return; }
      if (authData[email]) { res.writeHead(409,'',{'Content-Type':'application/json'}); res.end('{"ok":false,"error":"Email je již registrován"}'); return; }
      // Check username uniqueness
      const nameTaken = Object.values(authData).some(a => a.username.toLowerCase() === username.toLowerCase());
      if (nameTaken) { res.writeHead(409,'',{'Content-Type':'application/json'}); res.end('{"ok":false,"error":"Přezdívka je obsazená"}'); return; }
      const salt     = genToken(16);
      const passHash = hashPass(password, salt);
      const userId   = 'nx_' + genToken(16);
      authData[email] = { userId, passHash, salt, username, createdAt: Date.now() };
      saveAuth();
      res.writeHead(200,'',{'Content-Type':'application/json'});
      res.end(JSON.stringify({ ok: true, userId, username, email }));
    });
    return;
  }

  if (urlPath === '/auth/login' && req.method === 'POST') {
    let body = '';
    req.on('data', d => { body += d; if (body.length > 8192) req.destroy(); });
    req.on('end', () => {
      let parsed; try { parsed = JSON.parse(body); } catch { res.writeHead(400,'',{'Content-Type':'application/json'}); res.end('{"ok":false,"error":"invalid json"}'); return; }
      const email    = (parsed.email    || '').toLowerCase().trim();
      const password = (parsed.password || '');
      const acct = authData[email];
      if (!acct) { res.writeHead(401,'',{'Content-Type':'application/json'}); res.end('{"ok":false,"error":"Nesprávný email nebo heslo"}'); return; }
      let valid = false;
      try { valid = verifyPass(password, acct.salt, acct.passHash); } catch {}
      if (!valid) { res.writeHead(401,'',{'Content-Type':'application/json'}); res.end('{"ok":false,"error":"Nesprávný email nebo heslo"}'); return; }
      res.writeHead(200,'',{'Content-Type':'application/json'});
      res.end(JSON.stringify({ ok: true, userId: acct.userId, username: acct.username, email }));
    });
    return;
  }

  if (urlPath === '/auth/reset-request' && req.method === 'POST') {
    let body = '';
    req.on('data', d => { body += d; if (body.length > 8192) req.destroy(); });
    req.on('end', () => {
      let parsed; try { parsed = JSON.parse(body); } catch { res.writeHead(400,'',{'Content-Type':'application/json'}); res.end('{"ok":false,"error":"invalid json"}'); return; }
      const email = (parsed.email || '').toLowerCase().trim();
      // Always return ok to prevent email enumeration
      if (!authData[email]) { res.writeHead(200,'',{'Content-Type':'application/json'}); res.end('{"ok":true}'); return; }
      const token = genToken(32);
      resetTokens[token] = { email, expires: Date.now() + 3600000 };
      saveTokens();
      sendResetEmail(email, token, (err) => {
        if (err) console.warn('[Auth] Email error:', err.message);
      });
      res.writeHead(200,'',{'Content-Type':'application/json'});
      res.end('{"ok":true}');
    });
    return;
  }

  if (urlPath === '/auth/reset' && req.method === 'POST') {
    let body = '';
    req.on('data', d => { body += d; if (body.length > 8192) req.destroy(); });
    req.on('end', () => {
      let parsed; try { parsed = JSON.parse(body); } catch { res.writeHead(400,'',{'Content-Type':'application/json'}); res.end('{"ok":false,"error":"invalid json"}'); return; }
      const token    = (parsed.token    || '');
      const password = (parsed.password || '');
      const entry = resetTokens[token];
      if (!entry || entry.expires < Date.now()) { res.writeHead(400,'',{'Content-Type':'application/json'}); res.end('{"ok":false,"error":"Platnost odkazu vypršela"}'); return; }
      if (!password || password.length < 6) { res.writeHead(400,'',{'Content-Type':'application/json'}); res.end('{"ok":false,"error":"Heslo musí mít alespoň 6 znaků"}'); return; }
      const acct = authData[entry.email];
      if (!acct) { res.writeHead(400,'',{'Content-Type':'application/json'}); res.end('{"ok":false,"error":"Účet nenalezen"}'); return; }
      const salt     = genToken(16);
      acct.salt      = salt;
      acct.passHash  = hashPass(password, salt);
      delete resetTokens[token];
      saveAuth(); saveTokens();
      res.writeHead(200,'',{'Content-Type':'application/json'});
      res.end('{"ok":true}');
    });
    return;
  }

  if (urlPath === '/auth/check-name' && req.method === 'GET') {
    const params = new URL('http://x' + req.url).searchParams;
    const name = (params.get('name') || '').trim();
    const taken = Object.values(authData).some(a => a.username.toLowerCase() === name.toLowerCase());
    res.writeHead(200,'',{'Content-Type':'application/json'});
    res.end(JSON.stringify({ ok: true, taken }));
    return;
  }

  // Reset password page
  if (urlPath === '/reset') {
    const params = new URL('http://x' + req.url).searchParams;
    const token  = params.get('token') || '';
    const entry  = resetTokens[token];
    const valid  = entry && entry.expires > Date.now();
    const html = '<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Reset hesla — NexusChat</title>'
      + '<style>*{margin:0;padding:0;box-sizing:border-box}body{background:#070809;font-family:system-ui;display:flex;align-items:center;justify-content:center;min-height:100vh;color:#e2e8f0;padding:20px}'
      + '.card{background:#0d0f12;border:1px solid #1f2836;border-radius:16px;padding:32px;width:360px;max-width:100%}'
      + 'h2{margin-bottom:6px;font-size:20px}p{color:#64748b;font-size:13px;margin-bottom:20px}'
      + 'label{font-size:12px;color:#94a3b8;display:block;margin-bottom:4px}'
      + 'input{width:100%;background:#070809;border:1px solid #1f2836;border-radius:8px;padding:10px 12px;color:#e2e8f0;font-size:14px;margin-bottom:14px;outline:none}'
      + 'input:focus{border-color:#4fffb0}'
      + 'button{width:100%;background:#4fffb0;color:#000;border:none;border-radius:8px;padding:11px;font-size:14px;font-weight:700;cursor:pointer;margin-top:4px}'
      + 'button:hover{background:#3de89e}.err{color:#ff4466;font-size:13px;margin-bottom:10px;display:none}.ok{color:#4fffb0;font-size:13px;margin-bottom:10px;display:none}'
      + '</style></head><body><div class="card">'
      + (valid
        ? '<h2>🔑 Nové heslo</h2><p>Zvol si nové heslo pro tvůj NexusChat účet.</p>'
          + '<div class="err" id="err"></div><div class="ok" id="ok"></div>'
          + '<label>Nové heslo</label><input type="password" id="p1" placeholder="Min. 6 znaků" minlength="6">'
          + '<label>Zopakuj heslo</label><input type="password" id="p2" placeholder="Stejné heslo">'
          + '<button onclick="doReset()">Nastavit heslo →</button>'
          + '<script>function doReset(){'
          + 'var p1=document.getElementById("p1").value,p2=document.getElementById("p2").value,e=document.getElementById("err"),ok=document.getElementById("ok");'
          + 'e.style.display="none";ok.style.display="none";'
          + 'if(p1.length<6){e.textContent="Heslo musí mít alespoň 6 znaků";e.style.display="block";return;}'
          + 'if(p1!==p2){e.textContent="Hesla se neshodují";e.style.display="block";return;}'
          + 'fetch("/auth/reset",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({token:"' + token + '",password:p1})})'
          + '.then(function(r){return r.json();})'
          + '.then(function(d){if(d.ok){ok.textContent="Heslo bylo změněno! Přihlas se v NexusChat.";ok.style.display="block";document.querySelector("button").disabled=true;}'
          + 'else{e.textContent=d.error||"Chyba";e.style.display="block";}})'
          + '.catch(function(){e.textContent="Síťová chyba";e.style.display="block";});}'
          + '<\/script>'
        : '<h2>⚠️ Neplatný odkaz</h2><p>Tento odkaz pro reset hesla je neplatný nebo vypršela jeho platnost.</p><p style="margin-top:10px">Požádej o nový reset v aplikaci NexusChat.</p>'
      )
      + '</div></body></html>';
    res.writeHead(200,'',{'Content-Type':'text/html;charset=UTF-8'});
    res.end(html);
    return;
  }

  res.writeHead(404); res.end('404');
});

// ── WebSocket server ──
const wss     = new WebSocket.Server({ server: httpServer });
const clients      = new Map();
const ipToId       = {}; // ip -> persistent userId

// ── Persistent bans — saved to disk ──
const BANS_FILE    = '/tmp/nexus_bans.json';
const OFFLINE_FILE = '/tmp/nexus_offline.json';
const MEMBERS_FILE = '/tmp/nexus_members.json';

let bannedUsers  = {}; // { srvId: { userId: { reason, ts, name } } }
let savedOffline = {}; // { userId: memberInfo } — persistent offline members
let savedMembers = {}; // { srvId: { userId: memberInfo } } — all known members per server

const ACCOUNTS_FILE = '/tmp/nexus_accounts.json';
let accounts = {}; // { userId: { name, color, servers: {...}, roles: {...}, ts } }

function loadBans() {
  try {
    if (fs.existsSync(BANS_FILE))    bannedUsers  = JSON.parse(fs.readFileSync(BANS_FILE, 'utf8'));
    if (fs.existsSync(OFFLINE_FILE)) savedOffline = JSON.parse(fs.readFileSync(OFFLINE_FILE, 'utf8'));
    if (fs.existsSync(MEMBERS_FILE)) savedMembers = JSON.parse(fs.readFileSync(MEMBERS_FILE, 'utf8'));
    if (fs.existsSync(ACCOUNTS_FILE)) {
      accounts = JSON.parse(fs.readFileSync(ACCOUNTS_FILE, 'utf8'));
      console.log('[Accounts] Loaded', Object.keys(accounts).length, 'accounts from disk');
    }
    // Load from JSONBin bulk store if ACCOUNTS_BIN_ID is set
    loadBulkAccounts(function() {
      console.log('[Accounts] Total after bulk load:', Object.keys(accounts).length);
    });
    // Note: /tmp/ is wiped on Render restart - set ACCOUNTS_BIN_ID env var for persistence
    console.log('[Data] Bans:', Object.keys(bannedUsers).length, '| Offline:', Object.keys(savedOffline).length, '| Members:', Object.keys(savedMembers).length);
  } catch(e) { console.warn('[Data] Load error:', e.message); }
}

function saveBans()     { try { fs.writeFileSync(BANS_FILE,     JSON.stringify(bannedUsers));  } catch(e) {} }
function saveOffline()  { try { fs.writeFileSync(OFFLINE_FILE,  JSON.stringify(savedOffline)); } catch(e) {} }
function saveMembers()  { try { fs.writeFileSync(MEMBERS_FILE,  JSON.stringify(savedMembers)); } catch(e) {} }
function saveAccounts() { try { fs.writeFileSync(ACCOUNTS_FILE, JSON.stringify(accounts));     } catch(e) {} }

loadBans();
loadAuth();
const history      = {};
const vcState      = {};
const offlineState = {};

// ── Stats ──
const stats = { msgsByDay: {}, usersByDay: {} };
function todayKey() { return new Date().toISOString().slice(0,10); }
function trackMsg() {
  const k = todayKey();
  stats.msgsByDay[k] = (stats.msgsByDay[k] || 0) + 1;
}
function trackUser(id) {
  const k = todayKey();
  if (!stats.usersByDay[k]) stats.usersByDay[k] = new Set();
  stats.usersByDay[k].add(id);
} // id -> memberInfo — kdo se odpojil
const MAX_HIST     = 300;
const serverData   = {}; // srvId -> server structure (pro sync)
const HISTORY_FILE = '/tmp/nexus_history.json';

function loadHistory() {
  try {
    if (fs.existsSync(HISTORY_FILE)) {
      const data = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
      Object.assign(history, data);
      const total = Object.values(data).reduce((s, a) => s + a.length, 0);
      console.log('[History] Loaded', total, 'messages across', Object.keys(data).length, 'channels');
    }
  } catch(e) { console.warn('[History] Load error:', e.message); }
}

function saveHistory() {
  try { fs.writeFileSync(HISTORY_FILE, JSON.stringify(history)); } catch(e) {}
}

loadHistory();

wss.on('connection', (ws, req) => {
  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || '?';
  clients.set(ws, { id: null, name: '?' });
  console.log('[+] ' + ip + ' | celkem: ' + clients.size);

  if (Object.keys(history).length > 0)
    try { ws.send(JSON.stringify({ type: 'history', msgs: history })); } catch {}

  if (Object.keys(vcState).length > 0)
    try { ws.send(JSON.stringify({ type: 'vc_state_sync', state: vcState })); } catch {}

  // Send saved server structures to new client
  if (Object.keys(serverData).length > 0)
    try { ws.send(JSON.stringify({ type: 'servers_sync', servers: serverData })); } catch {}

  // Merge in-memory + persistent offline and send to new client
  const mergedOffline = { ...savedOffline, ...offlineState };
  // Remove anyone currently online
  for (const [client, info] of clients) {
    if (info.id && mergedOffline[info.id]) delete mergedOffline[info.id];
  }
  if (Object.keys(mergedOffline).length > 0)
    try { ws.send(JSON.stringify({ type: 'offline_sync', offline: mergedOffline })); } catch {}
  // Send per-server member lists
  if (Object.keys(savedMembers).length > 0)
    try { ws.send(JSON.stringify({ type: 'members_sync', members: savedMembers })); } catch {}
  // Send ban list so client can enforce locally
  if (Object.keys(bannedUsers).length > 0)
    try { ws.send(JSON.stringify({ type: 'all_bans', bans: bannedUsers })); } catch {}

  ws.on('message', data => {
    let msg;
    try { msg = JSON.parse(data.toString()); } catch { return; }

    if (msg.type === 'presence' && msg.m) {
      const info = clients.get(ws) || {};
      clients.set(ws, { id: msg.m.id, name: msg.m.name || '?', info: msg.m, ip: info.ip });
      if (info.ip && msg.m.id) ipToId[info.ip] = msg.m.id;
      if (msg.m.id && offlineState[msg.m.id]) delete offlineState[msg.m.id];
      // Save account data for cross-browser sync
      if (msg.m.id && msg.m.name) {
        if (!accounts[msg.m.id]) accounts[msg.m.id] = {};
        accounts[msg.m.id].profile = {
          name: msg.m.name, color: msg.m.color, tag: msg.m.tag,
          avatar: msg.m.avatar, font: msg.m.font, status: msg.m.status
        };
        accounts[msg.m.id].ts = Date.now();
        saveAccounts();
        trackUser(msg.m.id);
      }
      // Remove from persistent offline when online
      if (msg.m.id && savedOffline[msg.m.id]) {
        delete savedOffline[msg.m.id];
        saveOffline();
      }
      // Save to per-server member list
      if (msg.m.servers && Array.isArray(msg.m.servers)) {
        for (const srvId of msg.m.servers) {
          if (!savedMembers[srvId]) savedMembers[srvId] = {};
          savedMembers[srvId][msg.m.id] = { ...msg.m, lastSeen: Date.now() };
        }
        saveMembers();
      }
    }

    if (msg.type === 'vc_join' && msg.chId && msg.m) {
      if (!vcState[msg.chId]) vcState[msg.chId] = {};
      vcState[msg.chId][msg.m.id] = { ...msg.m, vcChId: msg.chId };
    }
    if (msg.type === 'vc_leave' && msg.id) {
      for (const ch of Object.keys(vcState)) delete vcState[ch][msg.id];
    }

    // Store IP-level ban
    if ((msg.type === 'ip_ban' || msg.type === 'ip_ban_temp') && msg.targetId && msg.srvId) {
      const isPermBan = msg.type === 'ip_ban';
      if (isPermBan) {
        // Permanent ban — store by userId
        if (!bannedUsers[msg.srvId]) bannedUsers[msg.srvId] = {};
        bannedUsers[msg.srvId][msg.targetId] = {
          reason: msg.reason || '', ts: Date.now(), name: msg.targetName || '?'
        };
        saveBans();
        console.log('[Ban] ' + msg.targetId + ' permanently banned from ' + msg.srvId);
      }
      // Remove from savedOffline and savedMembers regardless of ban type
      if (savedOffline[msg.targetId]) {
        delete savedOffline[msg.targetId]; saveOffline();
      }
      if (savedMembers[msg.srvId] && savedMembers[msg.srvId][msg.targetId]) {
        delete savedMembers[msg.srvId][msg.targetId]; saveMembers();
      }
      // Also remove from in-memory offlineState
      if (offlineState[msg.targetId]) delete offlineState[msg.targetId];
      // Kick/notify the target user if currently connected
      for (const [client, info] of clients) {
        if (info.id === msg.targetId && client.readyState === 1) {
          const msgType = isPermBan ? 'you_are_banned' : 'you_are_kicked';
          try { client.send(JSON.stringify({ type: msgType, srvId: msg.srvId, reason: msg.reason || '' })); } catch {}
        }
      }
    }

    // Account sync — client sends their servers, we merge and send back saved ones
    if (msg.type === 'account_save' && msg.userId) {
      if (!accounts[msg.userId]) accounts[msg.userId] = {};
      if (msg.servers) accounts[msg.userId].servers = msg.servers;
      if (msg.roles)   accounts[msg.userId].roles   = msg.roles;
      if (msg.profile) {
        // Always overwrite profile including empty avatar (intentional deletion)
        accounts[msg.userId].profile = msg.profile;
      }
      accounts[msg.userId].ts = Date.now();
      saveAccounts();
      bulkSaveAccounts(); // periodic bulk backup
      // Save to cloud (JSONBin) for cross-browser access
      const cloudData = {
        userId: msg.userId,
        profile: accounts[msg.userId].profile,
        servers: accounts[msg.userId].servers,
        roles:   accounts[msg.userId].roles,
        ts:      Date.now()
      };
      cloudSaveAccount(msg.userId, cloudData);
    }

    if (msg.type === 'account_req' && msg.userId) {
      const acc = accounts[msg.userId];
      if (acc && (acc.servers || acc.profile)) {
        try { ws.send(JSON.stringify({ type: 'account_data', account: acc })); } catch {}
      } else {
        // Try loading from cloud
        cloudLoadAccount(msg.userId, (err, cloudAcc) => {
          if (cloudAcc) {
            if (!accounts[msg.userId]) accounts[msg.userId] = {};
            Object.assign(accounts[msg.userId], cloudAcc);
            saveAccounts();
            try { ws.send(JSON.stringify({ type: 'account_data', account: cloudAcc })); } catch {}
          } else {
            try { ws.send(JSON.stringify({ type: 'account_data', account: null, notFound: true })); } catch {}
          }
        });
      }
    }

    // Check if this client is banned
    if (msg.type === 'check_ban' && msg.srvId) {
      const info = clients.get(ws) || {};
      const srvBans = bannedUsers[msg.srvId] || {};
      if (info.id && srvBans[info.id]) {
        try { ws.send(JSON.stringify({ type: 'you_are_banned', srvId: msg.srvId, reason: srvBans[info.id].reason })); } catch {}
      }
    }

    // Send full ban list to new connections (so clients can enforce locally)
    if (msg.type === 'get_bans' && msg.srvId) {
      const srvBans = bannedUsers[msg.srvId] || {};
      try { ws.send(JSON.stringify({ type: 'ban_list', srvId: msg.srvId, bans: srvBans })); } catch {}
    }

    if (msg.type === 'vc_state_req') {
      try { ws.send(JSON.stringify({ type: 'vc_state_sync', state: vcState })); } catch {}
      return;
    }
    if (msg.type === 'offline_req') {
      const merged = { ...savedOffline, ...offlineState };
      for (const [cl, inf] of clients) { if (inf.id && merged[inf.id]) delete merged[inf.id]; }
      try { ws.send(JSON.stringify({ type: 'offline_sync', offline: merged })); } catch {}
      return;
    }

    if (msg.type === 'chat' && msg.ch && msg.msg) {
      if (!history[msg.ch]) history[msg.ch] = [];
      history[msg.ch].push(msg.msg);
      if (history[msg.ch].length > MAX_HIST)
        history[msg.ch] = history[msg.ch].slice(-MAX_HIST);
      saveHistory();
    }

    const str = data.toString();

    // Audio relay — send only to others in same voice channel
    if (msg.type === 'audio' && msg.chId) {
      // Relay only to clients in the same voice channel
      for (const [client, info] of clients) {
        if (client !== ws && client.readyState === WebSocket.OPEN && info.id !== msg.from) {
          // Check if this client is in the same VC channel
          const clientVcCh = vcState[info.id]?.chId;
          if (clientVcCh === msg.chId) {
            try { client.send(str); } catch { clients.delete(client); }
          }
        }
      }
      return;
    }

    // Handle avatar deletion
    if (msg.type === 'avatar_delete' && msg.userId) {
      if (!accounts[msg.userId]) accounts[msg.userId] = {};
      if (!accounts[msg.userId].profile) accounts[msg.userId].profile = {};
      accounts[msg.userId].profile.avatar = ''; // clear avatar on server
      accounts[msg.userId].profile.avatarDeleted = Date.now();
      accounts[msg.userId].ts = Date.now();
      saveAccounts();
      console.log('[Server] Avatar deleted for user', msg.userId.slice(0,8));
      return;
    }

    // Store server structure updates for new clients
    if (msg.type === 'srv_update' && msg.srvId && msg.srv) {
      serverData[msg.srvId] = msg.srv;
    }

    // Server deleted - remove from memory and relay to all
    if (msg.type === 'srv_delete' && msg.srvId) {
      // Clear server data and all channel histories for this server
      delete serverData[msg.srvId];
      // Clear histories for channels of this server (we don't track per-server so clear all orphaned)
      console.log('[Server] srv_delete:', msg.srvId);
      // Relay to all connected clients
      for (const [client] of clients) {
        if (client !== ws && client.readyState === WebSocket.OPEN) {
          try { client.send(str); } catch {}
        }
      }
      return;
    }

    // Send channel history to requester
    if (msg.type === 'get_history' && msg.ch) {
      const hist = history[msg.ch] || [];
      try { ws.send(JSON.stringify({ type: 'msg_history', ch: msg.ch, msgs: hist })); } catch {}
      return;
    }

    // Delete message from history + broadcast
    if (msg.type === 'msg_delete' && msg.ch && msg.mid) {
      if (history[msg.ch]) {
        const before = history[msg.ch].length;
        history[msg.ch] = history[msg.ch].filter(m => m.mid !== msg.mid);
        if (history[msg.ch].length !== before) {
          saveHistory();
          // Broadcast to all clients
          const delPacket = JSON.stringify({ type: 'msg_delete', ch: msg.ch, mid: msg.mid });
          for (const [client] of clients) {
            if (client !== ws && client.readyState === WebSocket.OPEN) {
              try { client.send(delPacket); } catch {}
            }
          }
        }
      }
      return;
    }

    // Delete account
    if (msg.type === 'account_delete' && msg.userId) {
      delete accounts[msg.userId];
      saveAccounts();
      return;
    }

    // Screen share relay — only to VC members in same channel
    if ((msg.type === 'screen_frame' || msg.type === 'screen_start' || msg.type === 'screen_stop') && msg.chId) {
      for (const [client, info] of clients) {
        if (client !== ws && client.readyState === WebSocket.OPEN) {
          try { client.send(str); } catch {}
        }
      }
      return;
    }

    // Audio relay — only to others in same voice channel (don't broadcast to everyone)
    if (msg.type === 'audio' && msg.chId) {
      for (const [client] of clients) {
        if (client !== ws && client.readyState === WebSocket.OPEN) {
          try { client.send(str); } catch { clients.delete(client); }
        }
      }
      return;
    }

    // Broadcast to all others
    for (const [client] of clients)
      if (client !== ws && client.readyState === WebSocket.OPEN)
        try { client.send(str); } catch { clients.delete(client); }
  });

  ws.on('close', () => {
    const info = clients.get(ws);
    console.log('[-] ' + (info?.name || '?') + ' | celkem: ' + (clients.size - 1));
    if (info?.id) {
      if (info.info) {
        offlineState[info.id] = { ...info.info, status: 'offline' };
        // Also save to persistent offline file
        savedOffline[info.id] = { ...info.info, status: 'offline', lastSeen: Date.now() };
        saveOffline();
      }
      for (const ch of Object.keys(vcState)) delete vcState[ch][info.id];
      // Send leave WITH member info so clients can show offline
      const leaveMsg = JSON.stringify({ type: 'leave', id: info.id, m: info.info || null });
      for (const [c] of clients)
        if (c !== ws && c.readyState === WebSocket.OPEN)
          try { c.send(leaveMsg); } catch {}
    }
    clients.delete(ws);
  });

  ws.on('error', () => clients.delete(ws));
});

setInterval(() => {
  for (const [ws] of clients) {
    if (ws.readyState === WebSocket.OPEN) try { ws.ping(); } catch { clients.delete(ws); }
    else clients.delete(ws);
  }
}, 25000);

httpServer.listen(PORT, '0.0.0.0', () => {
  console.log('\n=== NexusChat Server ===');
  if (process.env.RENDER_EXTERNAL_HOSTNAME) {
    const h = process.env.RENDER_EXTERNAL_HOSTNAME;
    console.log('Web:    https://' + h);
    console.log('Invite: https://' + h + '/invite');
    console.log('WSS:    wss://'   + h);
  } else if (process.env.RAILWAY_PUBLIC_DOMAIN) {
    const h = process.env.RAILWAY_PUBLIC_DOMAIN;
    console.log('Web:    https://' + h);
    console.log('Invite: https://' + h + '/invite');
    console.log('WSS:    wss://'   + h);
  } else {
    console.log('Local:  http://localhost:' + PORT);
    console.log('Invite: http://localhost:' + PORT + '/invite');
    const nets = os.networkInterfaces();
    for (const n of Object.keys(nets))
      for (const i of nets[n])
        if (i.family === 'IPv4' && !i.internal) {
          console.log('Sit:    http://' + i.address + ':' + PORT);
          console.log('WS:     ws://'   + i.address + ':' + PORT);
        }
  }
  console.log('========================\n');
});

process.on('SIGTERM', () => wss.close(() => httpServer.close(() => process.exit(0))));
