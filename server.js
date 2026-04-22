// NexusChat Server
// Spuštění: node server.js
// Připojení: wss://TVOJE-URL

const WebSocket = require('ws');
const http      = require('http');
const https     = require('https');
const fs        = require('fs');
const path      = require('path');
const os        = require('os');

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

  // ── DEV PANEL ──────────────────────────────
  if (urlPath === '/dev' || urlPath === '/dev/') {
    const DEV_KEY = process.env.DEV_KEY || 'nexus-dev-2026';
    const key = new URL('http://x' + req.url).searchParams.get('key');
    if (key !== DEV_KEY) {
      res.writeHead(200, {'Content-Type':'text/html;charset=UTF-8'});
      res.end(`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>NexusChat Dev</title>
<style>*{margin:0;padding:0;box-sizing:border-box}body{background:#050507;font-family:'Courier New',monospace;display:flex;align-items:center;justify-content:center;height:100vh;color:#00ff88}
.box{width:340px;padding:32px;border:1px solid #00ff8844;border-radius:4px;background:#0a0a0f}
h2{font-size:16px;letter-spacing:4px;margin-bottom:24px;color:#00ff88}
input{width:100%;background:#050507;border:1px solid #1a1a2e;border-radius:2px;padding:10px;color:#00ff88;font-family:'Courier New';font-size:13px;margin-bottom:12px;outline:none}
input:focus{border-color:#00ff8866}
button{width:100%;background:#00ff8811;border:1px solid #00ff8844;color:#00ff88;padding:10px;font-family:'Courier New';font-size:13px;cursor:pointer;letter-spacing:2px}
button:hover{background:#00ff8822}</style></head>
<body><div class="box"><h2>// DEV_ACCESS</h2>
<input type="password" id="k" placeholder="dev key..." onkeydown="if(event.key==='Enter')auth()">
<button onclick="auth()">CONNECT →</button></div>
<script>function auth(){location.href='/dev?key='+document.getElementById('k').value}</script></body></html>`);
      return;
    }

    // Build accounts data for display
    const accList = Object.entries(accounts).map(([id, acc]) => ({
      id,
      name: acc.profile?.name || '?',
      color: acc.profile?.color || '#888',
      avatar: acc.profile?.avatar ? true : false,
      status: acc.profile?.status || 'unknown',
      servers: Object.keys(acc.servers || {}).length,
      lastSeen: acc.ts ? new Date(acc.ts).toISOString().slice(0,16).replace('T',' ') : 'never',
      binId: acc._binId || null,
    })).sort((a,b) => (b.lastSeen > a.lastSeen ? 1 : -1));

    const onlineIds = new Set([...clients.values()].map(i => i.id));
    const today = new Date().toISOString().slice(0,10);
    const yesterday = new Date(Date.now()-86400000).toISOString().slice(0,10);

    res.writeHead(200, {'Content-Type':'text/html;charset=UTF-8'});
    res.end(`<!DOCTYPE html>
<html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>NexusChat DevPanel</title>
<link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;600;700&family=Syne:wght@600;800&display=swap" rel="stylesheet">
<style>
:root{--bg:#050507;--bg1:#0a0a0f;--bg2:#0f0f1a;--bg3:#141420;--acc:#00ff88;--acc2:#7c6aff;--red:#ff4466;--yel:#ffcc00;--t1:#e2e8f0;--t2:#94a3b8;--t3:#475569;--bd:#1a1a2e}
*{margin:0;padding:0;box-sizing:border-box}
html{background:var(--bg);color:var(--t1);font-family:'JetBrains Mono',monospace;min-height:100vh;font-size:13px}
body{display:flex;flex-direction:column;min-height:100vh}

/* Nav */
nav{display:flex;align-items:center;gap:16px;padding:12px 24px;background:var(--bg1);border-bottom:1px solid var(--bd);position:sticky;top:0;z-index:100}
.nav-logo{font-family:'Syne',sans-serif;font-size:18px;font-weight:800;color:var(--acc);letter-spacing:-0.5px}
.nav-tag{font-size:10px;color:var(--t3);letter-spacing:2px;text-transform:uppercase}
.nav-status{display:flex;align-items:center;gap:6px;margin-left:auto;font-size:11px;color:var(--acc)}
.dot{width:7px;height:7px;border-radius:50%;background:var(--acc);box-shadow:0 0 8px var(--acc);animation:pulse 2s infinite}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.4}}
.nav-btn{background:transparent;border:1px solid var(--bd);color:var(--t3);padding:5px 12px;border-radius:3px;cursor:pointer;font-family:'JetBrains Mono';font-size:11px;letter-spacing:1px;transition:all .2s}
.nav-btn:hover{border-color:var(--acc);color:var(--acc)}

/* Layout */
.page{display:grid;grid-template-columns:200px 1fr;flex:1}
.sidebar{background:var(--bg1);border-right:1px solid var(--bd);padding:16px 0}
.sitem{padding:10px 20px;cursor:pointer;font-size:11px;letter-spacing:1px;color:var(--t3);transition:all .15s;display:flex;align-items:center;gap:8px;text-transform:uppercase}
.sitem:hover,.sitem.act{color:var(--acc);background:rgba(0,255,136,.05)}
.sitem.act{border-left:2px solid var(--acc)}
.sitem-dot{width:5px;height:5px;border-radius:50%;background:currentColor;flex-shrink:0}

.content{padding:24px;overflow-y:auto}
.panel{display:none}.panel.act{display:block}

/* Stats row */
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:12px;margin-bottom:24px}
.stat{background:var(--bg2);border:1px solid var(--bd);border-radius:6px;padding:16px;transition:border-color .2s}
.stat:hover{border-color:rgba(0,255,136,.3)}
.stat-val{font-size:28px;font-weight:700;color:var(--t1);margin-bottom:2px;font-family:'Syne',sans-serif}
.stat-lbl{font-size:10px;color:var(--t3);letter-spacing:1px;text-transform:uppercase}
.stat-acc{color:var(--acc)}
.stat-pur{color:var(--acc2)}
.stat-red{color:var(--red)}
.stat-yel{color:var(--yel)}

/* Table */
.tbl-wrap{background:var(--bg2);border:1px solid var(--bd);border-radius:6px;overflow:hidden;margin-bottom:20px}
.tbl-head{display:grid;padding:10px 16px;background:var(--bg3);font-size:10px;letter-spacing:1px;color:var(--t3);text-transform:uppercase;border-bottom:1px solid var(--bd)}
.tbl-row{display:grid;padding:10px 16px;border-bottom:1px solid rgba(26,26,46,.8);transition:background .15s;align-items:center}
.tbl-row:hover{background:rgba(0,255,136,.03)}
.tbl-row:last-child{border-bottom:none}
.badge{display:inline-flex;align-items:center;gap:4px;padding:2px 8px;border-radius:3px;font-size:10px;font-weight:600;letter-spacing:.5px}
.badge-on{background:rgba(0,255,136,.12);color:var(--acc);border:1px solid rgba(0,255,136,.2)}
.badge-off{background:rgba(71,85,105,.12);color:var(--t3);border:1px solid var(--bd)}
.avatar-dot{width:28px;height:28px;border-radius:50%;display:inline-flex;align-items:center;justify-content:center;font-size:12px;font-weight:700;flex-shrink:0}
.mono{font-family:'JetBrains Mono';font-size:11px;color:var(--t2)}
.sec-title{font-size:11px;letter-spacing:2px;text-transform:uppercase;color:var(--t3);margin-bottom:12px;display:flex;align-items:center;gap:8px}
.sec-title::after{content:'';flex:1;height:1px;background:var(--bd)}

/* Action buttons */
.act-btn{background:transparent;border:1px solid var(--bd);color:var(--t2);padding:3px 10px;border-radius:3px;cursor:pointer;font-family:'JetBrains Mono';font-size:10px;transition:all .15s}
.act-btn:hover{border-color:var(--acc);color:var(--acc)}
.act-btn.danger:hover{border-color:var(--red);color:var(--red)}

/* Search */
.search-bar{display:flex;gap:10px;margin-bottom:16px}
.search-inp{flex:1;background:var(--bg2);border:1px solid var(--bd);border-radius:4px;padding:8px 12px;color:var(--t1);font-family:'JetBrains Mono';font-size:12px;outline:none}
.search-inp:focus{border-color:var(--acc)}

/* Logs */
.log-box{background:#020204;border:1px solid var(--bd);border-radius:4px;padding:12px;font-size:11px;line-height:1.7;max-height:400px;overflow-y:auto;color:#64748b}
.log-ok{color:var(--acc)}.log-er{color:var(--red)}.log-inf{color:var(--acc2)}

/* Modal */
.modal-bg{display:none;position:fixed;inset:0;background:rgba(0,0,0,.8);z-index:200;align-items:center;justify-content:center}
.modal-bg.open{display:flex}
.modal{background:var(--bg1);border:1px solid var(--bd);border-radius:8px;padding:24px;width:min(480px,90vw);max-height:80vh;overflow-y:auto}
.modal h3{font-size:14px;letter-spacing:2px;text-transform:uppercase;margin-bottom:16px;color:var(--acc)}
.form-row{margin-bottom:12px}
.form-lbl{font-size:10px;letter-spacing:1px;text-transform:uppercase;color:var(--t3);margin-bottom:5px}
.form-inp{width:100%;background:var(--bg);border:1px solid var(--bd);border-radius:3px;padding:8px 10px;color:var(--t1);font-family:'JetBrains Mono';font-size:12px;outline:none}
.form-inp:focus{border-color:var(--acc)}
.modal-btns{display:flex;gap:8px;justify-content:flex-end;margin-top:16px}
</style></head>
<body>
<nav>
  <span class="nav-logo">⚡ NexusChat</span>
  <span class="nav-tag">// DEV_PANEL</span>
  <div class="nav-status"><div class="dot"></div>SERVER ONLINE · ${clients.size} connected</div>
  <button class="nav-btn" onclick="location.reload()">↻ REFRESH</button>
  <button class="nav-btn" onclick="location.href='/admin?key=${process.env.ADMIN_KEY||'nexus-admin-2026'}'">STATS →</button>
</nav>

<div class="page">
  <div class="sidebar">
    <div class="sitem act" onclick="show('accounts')"><div class="sitem-dot"></div>ACCOUNTS</div>
    <div class="sitem" onclick="show('servers')"><div class="sitem-dot"></div>SERVERS</div>
    <div class="sitem" onclick="show('online')"><div class="sitem-dot"></div>ONLINE NOW</div>
    <div class="sitem" onclick="show('bans')"><div class="sitem-dot"></div>BANS</div>
    <div class="sitem" onclick="show('actions')"><div class="sitem-dot"></div>ACTIONS</div>
  </div>

  <div class="content">

    <!-- ACCOUNTS -->
    <div class="panel act" id="panel-accounts">
      <div class="stats">
        <div class="stat"><div class="stat-val stat-acc">${Object.keys(accounts).length}</div><div class="stat-lbl">Total accounts</div></div>
        <div class="stat"><div class="stat-val stat-pur">${clients.size}</div><div class="stat-lbl">Online now</div></div>
        <div class="stat"><div class="stat-val stat-yel">${stats.usersByDay[today]?.size||0}</div><div class="stat-lbl">Active today</div></div>
        <div class="stat"><div class="stat-val stat-red">${Object.keys(bannedUsers||{}).length}</div><div class="stat-lbl">Banned</div></div>
      </div>

      <div class="sec-title">USER ACCOUNTS</div>
      <div class="search-bar">
        <input class="search-inp" id="acc-search" placeholder="search by name or id..." oninput="filterAccounts(this.value)">
      </div>
      <div class="tbl-wrap" id="acc-table">
        <div class="tbl-head" style="grid-template-columns:28px 1fr 140px 80px 80px 100px 100px">
          <span></span><span>NAME / ID</span><span>LAST SEEN</span><span>SERVERS</span><span>STATUS</span><span>ONLINE</span><span>ACTIONS</span>
        </div>
        ${accList.map(a => `
        <div class="tbl-row" style="grid-template-columns:28px 1fr 140px 80px 80px 100px 100px" data-name="${(a.name||'').toLowerCase()}" data-id="${a.id}">
          <div class="avatar-dot" style="background:${a.color||'#7c6aff'};color:#000">${(a.name||'?')[0].toUpperCase()}</div>
          <div>
            <div style="color:var(--t1);font-weight:600">${a.name||'Unknown'}</div>
            <div class="mono">${a.id.slice(0,20)}...</div>
          </div>
          <div class="mono">${a.lastSeen}</div>
          <div style="color:var(--acc2)">${a.servers}</div>
          <div class="mono" style="color:var(--t3)">${a.status}</div>
          <div><span class="badge ${onlineIds.has(a.id)?'badge-on':'badge-off'}">${onlineIds.has(a.id)?'● ONLINE':'○ OFFLINE'}</span></div>
          <div style="display:flex;gap:4px">
            <button class="act-btn" onclick="viewAccount('${a.id}')">VIEW</button>
            <button class="act-btn danger" onclick="banUser('${a.id}','${(a.name||'').replace(/'/g,'\'')}')" title="Ban user">BAN</button>
          </div>
        </div>`).join('')}
      </div>
    </div>

    <!-- SERVERS -->
    <div class="panel" id="panel-servers">
      <div class="sec-title">ACTIVE SERVERS (in memory)</div>
      <div class="tbl-wrap">
        <div class="tbl-head" style="grid-template-columns:1fr 120px 80px 100px"><span>SERVER NAME</span><span>ID</span><span>CHANNELS</span><span>ACTIONS</span></div>
        ${Object.entries(serverData).map(([id,s])=>`
        <div class="tbl-row" style="grid-template-columns:1fr 120px 80px 100px">
          <div style="color:var(--t1);font-weight:600">${s.name||'?'}</div>
          <div class="mono">${id.slice(0,12)}...</div>
          <div style="color:var(--acc2)">${(s.cats||[]).reduce((a,c)=>a+(c.chs||[]).length,0)}</div>
          <div><button class="act-btn" onclick="joinServer('${id}','${(s.name||'').replace(/'/g,'\'')}')" title="Join without invite">JOIN</button></div>
        </div>`).join('') || '<div style="padding:20px;color:var(--t3);text-align:center">No server data in memory</div>'}
      </div>
    </div>

    <!-- ONLINE -->
    <div class="panel" id="panel-online">
      <div class="sec-title">CONNECTED CLIENTS (${clients.size})</div>
      <div class="tbl-wrap">
        <div class="tbl-head" style="grid-template-columns:1fr 120px 100px 80px"><span>USER</span><span>ID</span><span>IP</span><span>ACTIONS</span></div>
        ${[...clients.values()].map(info=>`
        <div class="tbl-row" style="grid-template-columns:1fr 120px 100px 80px">
          <div style="color:var(--acc);font-weight:600">● ${info.name||'?'}</div>
          <div class="mono">${(info.id||'?').slice(0,16)}...</div>
          <div class="mono">${info.ip||'?'}</div>
          <div><button class="act-btn danger" onclick="kickUser('${info.id}','${(info.name||'').replace(/'/g,'\'')}')" >KICK</button></div>
        </div>`).join('') || '<div style="padding:20px;color:var(--t3);text-align:center">No users online</div>'}
      </div>
    </div>

    <!-- BANS -->
    <div class="panel" id="panel-bans">
      <div class="sec-title">BANNED USERS</div>
      <div class="tbl-wrap">
        <div class="tbl-head" style="grid-template-columns:1fr 1fr 100px"><span>USER ID</span><span>REASON</span><span>ACTIONS</span></div>
        ${Object.entries(bannedUsers||{}).map(([id,info])=>`
        <div class="tbl-row" style="grid-template-columns:1fr 1fr 100px">
          <div class="mono">${id.slice(0,24)}...</div>
          <div style="color:var(--t2)">${info.reason||'No reason'}</div>
          <div><button class="act-btn" onclick="unban('${id}')">UNBAN</button></div>
        </div>`).join('') || '<div style="padding:20px;color:var(--t3);text-align:center">No bans</div>'}
      </div>
    </div>

    <!-- ACTIONS -->
    <div class="panel" id="panel-actions">
      <div class="sec-title">SERVER ACTIONS</div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
        <div style="background:var(--bg2);border:1px solid var(--bd);border-radius:6px;padding:20px">
          <div style="font-size:10px;letter-spacing:1px;color:var(--acc);margin-bottom:8px;text-transform:uppercase">Broadcast Message</div>
          <textarea id="broadcast-msg" style="width:100%;background:var(--bg);border:1px solid var(--bd);border-radius:3px;padding:8px;color:var(--t1);font-family:'JetBrains Mono';font-size:11px;resize:vertical;min-height:80px;outline:none" placeholder="Message to send to all online users..."></textarea>
          <button class="act-btn" style="margin-top:8px;width:100%" onclick="broadcastMsg()">SEND TO ALL</button>
        </div>
        <div style="background:var(--bg2);border:1px solid var(--bd);border-radius:6px;padding:20px">
          <div style="font-size:10px;letter-spacing:1px;color:var(--acc);margin-bottom:8px;text-transform:uppercase">Server Info</div>
          <div class="log-box">
<span class="log-ok">✓ Server online</span>
<span class="log-inf"> Connected: ${clients.size}</span>
<span class="log-inf"> Accounts: ${Object.keys(accounts).length}</span>
<span class="log-inf"> Servers: ${Object.keys(serverData).length}</span>
<span class="log-inf"> History channels: ${Object.keys(history).length}</span>
<span class="log-ok"> Msgs today: ${stats.msgsByDay[today]||0}</span>
<span class="log-ok"> Build: ${new Date().toISOString()}</span>
          </div>
        </div>
      </div>
    </div>

  </div>
</div>

<!-- Account detail modal -->
<div class="modal-bg" id="acc-modal">
  <div class="modal">
    <h3>// ACCOUNT_DETAIL</h3>
    <div id="acc-modal-content"></div>
    <div class="modal-btns">
      <button class="act-btn" onclick="closeModal()">CLOSE</button>
    </div>
  </div>
</div>

<!-- Join server modal -->
<div class="modal-bg" id="join-modal">
  <div class="modal">
    <h3>// JOIN_SERVER</h3>
    <p style="color:var(--t2);font-size:12px;margin-bottom:16px">Get invite link for this server to join without invitation.</p>
    <div id="join-content"></div>
    <div class="modal-btns">
      <button class="act-btn" onclick="document.getElementById('join-modal').classList.remove('open')">CLOSE</button>
    </div>
  </div>
</div>

<script>
const DEV_KEY = '${process.env.DEV_KEY||'nexus-dev-2026'}';
const SERVER_URL = location.origin;

function show(tab) {
  document.querySelectorAll('.panel').forEach(p => p.classList.remove('act'));
  document.querySelectorAll('.sitem').forEach(s => s.classList.remove('act'));
  document.getElementById('panel-' + tab).classList.add('act');
  event.currentTarget.classList.add('act');
}

function filterAccounts(q) {
  const rows = document.querySelectorAll('#acc-table .tbl-row');
  rows.forEach(r => {
    const match = !q || r.dataset.name.includes(q.toLowerCase()) || r.dataset.id.includes(q.toLowerCase());
    r.style.display = match ? '' : 'none';
  });
}

function viewAccount(id) {
  fetch(SERVER_URL + '/dev/api?key=' + DEV_KEY + '&action=account&id=' + id)
    .then(r=>r.json()).then(d=>{
      const m = document.getElementById('acc-modal-content');
      const acc = d.account || {};
      const p = acc.profile || {};
      m.innerHTML = '<div style="font-size:11px;line-height:1.9">'
        + '<div><span style="color:var(--t3)">ID: </span><span style="color:var(--acc)">' + id + '</span></div>'
        + '<div><span style="color:var(--t3)">Name: </span>' + (p.name||'?') + '</div>'
        + '<div><span style="color:var(--t3)">Color: </span><span style="color:' + (p.color||'#888') + '">' + (p.color||'?') + '</span></div>'
        + '<div><span style="color:var(--t3)">Status: </span>' + (p.status||'?') + '</div>'
        + '<div><span style="color:var(--t3)">Servers: </span>' + Object.keys(acc.servers||{}).length + '</div>'
        + '<div><span style="color:var(--t3)">Last seen: </span>' + (acc.ts ? new Date(acc.ts).toLocaleString() : 'never') + '</div>'
        + '<div><span style="color:var(--t3)">Has avatar: </span>' + (p.avatar ? 'yes' : 'no') + '</div>'
        + '</div>';
      document.getElementById('acc-modal').classList.add('open');
    }).catch(()=>alert('Error'));
}

function closeModal() {
  document.getElementById('acc-modal').classList.remove('open');
}

function banUser(id, name) {
  if (!confirm('Ban user ' + name + '?')) return;
  const reason = prompt('Reason:') || 'Banned by admin';
  fetch(SERVER_URL + '/dev/api?key=' + DEV_KEY + '&action=ban&id=' + id + '&reason=' + encodeURIComponent(reason))
    .then(r=>r.json()).then(d=>{ if(d.ok){alert('Banned ✓');location.reload();}else alert('Error'); });
}

function kickUser(id, name) {
  if (!confirm('Kick ' + name + '?')) return;
  fetch(SERVER_URL + '/dev/api?key=' + DEV_KEY + '&action=kick&id=' + id)
    .then(r=>r.json()).then(d=>{ if(d.ok){alert('Kicked ✓');location.reload();}else alert('Error'); });
}

function unban(id) {
  if (!confirm('Unban?')) return;
  fetch(SERVER_URL + '/dev/api?key=' + DEV_KEY + '&action=unban&id=' + id)
    .then(r=>r.json()).then(d=>{ if(d.ok){alert('Unbanned ✓');location.reload();}else alert('Error'); });
}

function joinServer(id, name) {
  const url = SERVER_URL + '/invite?id=' + id + '&s=' + encodeURIComponent(name);
  const m = document.getElementById('join-content');
  m.innerHTML = '<div style="color:var(--t2);font-size:11px;margin-bottom:8px">Server: <strong style="color:var(--t1)">' + name + '</strong></div>'
    + '<div style="background:var(--bg);border:1px solid var(--bd);border-radius:3px;padding:8px;font-size:11px;color:var(--acc);word-break:break-all;cursor:pointer" onclick="navigator.clipboard.writeText(this.textContent)">' + url + '</div>'
    + '<div style="font-size:10px;color:var(--t3);margin-top:6px">Click URL to copy · Opens web invite</div>'
    + '<div style="margin-top:10px;display:flex;gap:8px">'
    + '<button class="act-btn" onclick="window.open(\'' + url + '\',\'_blank\')">OPEN INVITE →</button>'
    + '<button class="act-btn" onclick="navigator.clipboard.writeText(\'' + url + '\');this.textContent=\'COPIED!\'" >COPY URL</button>'
    + '</div>';
  document.getElementById('join-modal').classList.add('open');
}

function broadcastMsg() {
  const msg = document.getElementById('broadcast-msg').value.trim();
  if (!msg) return;
  fetch(SERVER_URL + '/dev/api?key=' + DEV_KEY + '&action=broadcast&msg=' + encodeURIComponent(msg))
    .then(r=>r.json()).then(d=>{ alert(d.ok ? 'Sent to ' + d.count + ' users' : 'Error'); });
}

// Auto refresh every 30s
setTimeout(()=>location.reload(), 30000);
</script>
</body></html>`);
    return;
  }

  // Dev API
  if (urlPath === '/dev/api') {
    const DEV_KEY = process.env.DEV_KEY || 'nexus-dev-2026';
    const params = new URL('http://x' + req.url).searchParams;
    if (params.get('key') !== DEV_KEY) { res.writeHead(401); res.end('{}'); return; }
    const action = params.get('action');
    const id     = params.get('id');

    if (action === 'account') {
      res.writeHead(200, {'Content-Type':'application/json'});
      res.end(JSON.stringify({ account: accounts[id] || null }));
    } else if (action === 'ban') {
      const reason = params.get('reason') || 'Banned by admin';
      if (!bannedUsers) global.bannedUsers = {};
      bannedUsers[id] = { reason, ts: Date.now() };
      saveBans && saveBans();
      // Kick if online
      for (const [ws2, info] of clients) {
        if (info.id === id) {
          try { ws2.send(JSON.stringify({ type: 'you_are_banned', reason })); ws2.close(); } catch {}
        }
      }
      res.writeHead(200, {'Content-Type':'application/json'});
      res.end(JSON.stringify({ ok: true }));
    } else if (action === 'kick') {
      for (const [ws2, info] of clients) {
        if (info.id === id) {
          try { ws2.send(JSON.stringify({ type: 'you_are_kicked', reason: 'Kicked by admin' })); ws2.close(); } catch {}
        }
      }
      res.writeHead(200, {'Content-Type':'application/json'});
      res.end(JSON.stringify({ ok: true }));
    } else if (action === 'unban') {
      if (bannedUsers) delete bannedUsers[id];
      saveBans && saveBans();
      res.writeHead(200, {'Content-Type':'application/json'});
      res.end(JSON.stringify({ ok: true }));
    } else if (action === 'broadcast') {
      const msg = params.get('msg') || '';
      let count = 0;
      for (const [ws2] of clients) {
        try {
          ws2.send(JSON.stringify({ type: 'chat', ch: '__broadcast__', srvId: '__system__',
            msg: { mid: Math.random().toString(36).slice(2), author: '⚡ NexusChat System',
              authorId: '__system__', color: '#4fffb0', text: '📢 ' + msg, ts: Date.now(), reactions: [] }
          }));
          count++;
        } catch {}
      }
      res.writeHead(200, {'Content-Type':'application/json'});
      res.end(JSON.stringify({ ok: true, count }));
    } else {
      res.writeHead(400); res.end('{}');
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
    if (fs.existsSync(ACCOUNTS_FILE)) { accounts = JSON.parse(fs.readFileSync(ACCOUNTS_FILE, 'utf8')); console.log('[Accounts] Loaded', Object.keys(accounts).length, 'accounts'); }
    console.log('[Data] Bans:', Object.keys(bannedUsers).length, '| Offline:', Object.keys(savedOffline).length, '| Members:', Object.keys(savedMembers).length);
  } catch(e) { console.warn('[Data] Load error:', e.message); }
}

function saveBans()     { try { fs.writeFileSync(BANS_FILE,     JSON.stringify(bannedUsers));  } catch(e) {} }
function saveOffline()  { try { fs.writeFileSync(OFFLINE_FILE,  JSON.stringify(savedOffline)); } catch(e) {} }
function saveMembers()  { try { fs.writeFileSync(MEMBERS_FILE,  JSON.stringify(savedMembers)); } catch(e) {} }
function saveAccounts() { try { fs.writeFileSync(ACCOUNTS_FILE, JSON.stringify(accounts));     } catch(e) {} }

loadBans();
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
