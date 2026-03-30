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
setTimeout(() => { serverReady = true; }, 5000); // 5s — enough to show changelog

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
<meta http-equiv="refresh" content="8">
<title>NexusChat — Loading</title>
<link href="https://fonts.googleapis.com/css2?family=Syne:wght@400;600;700&display=swap" rel="stylesheet">
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{background:#070809;font-family:'Syne',system-ui,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;padding:20px}
.wrap{width:min(500px,100%);display:flex;flex-direction:column;gap:12px}
.card{background:#0d0f12;border:1px solid #1f2836;border-radius:18px;padding:32px 28px;text-align:center}
.logo{font-size:40px;margin-bottom:12px;display:inline-block;animation:pulse 2s ease infinite}
@keyframes pulse{0%,100%{transform:scale(1)}50%{transform:scale(1.1)}}
h1{font-size:20px;font-weight:700;color:#e2e8f0;margin-bottom:6px}
.sub{font-size:13px;color:#64748b;margin-bottom:20px}
.badge{display:inline-flex;align-items:center;gap:8px;background:rgba(79,255,176,.07);border:1px solid rgba(79,255,176,.2);border-radius:20px;padding:6px 16px;font-size:12px;color:#4fffb0;margin-bottom:18px;font-weight:600}
.dot{width:7px;height:7px;border-radius:50%;background:#4fffb0;animation:blink 1.2s ease infinite}
@keyframes blink{0%,100%{opacity:1}50%{opacity:.2}}
.bar{background:#1a1f2e;border-radius:8px;height:3px;overflow:hidden;margin-bottom:14px}
.bar-fill{height:100%;background:linear-gradient(90deg,#4fffb0,#7c6aff);border-radius:8px;animation:prog 8s linear forwards}
@keyframes prog{from{width:0}to{width:100%}}
.note{font-size:11px;color:#3a4654}
.note a{color:#4fffb0;cursor:pointer;text-decoration:none}
.changelog{background:#0d0f12;border:1px solid #1f2836;border-radius:18px;padding:22px 24px}
.cl-header{display:flex;align-items:center;gap:8px;margin-bottom:14px;padding-bottom:10px;border-bottom:1px solid #1f2836}
.cl-title{font-size:13px;font-weight:700;color:#e2e8f0;flex:1}
.cl-version{font-size:11px;background:rgba(79,255,176,.1);color:#4fffb0;padding:2px 8px;border-radius:6px;border:1px solid rgba(79,255,176,.2)}
.cl-date{font-size:11px;color:#3a4654}
.cl-item{display:flex;align-items:flex-start;gap:8px;padding:5px 0;border-bottom:1px solid #131720;font-size:12px;color:#94a3b8;line-height:1.5}
.cl-item:last-child{border-bottom:none}
.cl-badge{font-size:9px;font-weight:700;padding:2px 5px;border-radius:4px;flex-shrink:0;margin-top:2px;letter-spacing:.4px;text-transform:uppercase}
.cl-badge.new{background:rgba(79,255,176,.12);color:#4fffb0}
.cl-badge.fix{background:rgba(124,106,255,.12);color:#7c6aff}
.cl-badge.imp{background:rgba(255,203,107,.12);color:#ffcb6b}
.cl-badge.rem{background:rgba(255,83,112,.12);color:#ff5370}
</style>
</head>
<body>
<div class="wrap">
<div class="card">
  <div class="logo">⚡</div>
  <h1>NexusChat</h1>
  <p class="sub">Server se spouští, chvilku počkej...</p>
  <div class="badge"><div class="dot"></div>Deploying...</div>
  <div class="bar"><div class="bar-fill"></div></div>
  <p class="note">Automaticky se obnoví &nbsp;·&nbsp; <a href="javascript:location.reload()">Obnovit teď</a></p>
</div>
${buildChangelogHtml()}
</div>
<script>
setTimeout(function(){location.reload();},8000);
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
    const acceptsHtml = (req.headers['accept'] || '').includes('text/html');
    if (!serverReady && acceptsHtml) {
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
const offlineState = {}; // id -> memberInfo — kdo se odpojil
const MAX_HIST     = 300;
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
      if (msg.profile) accounts[msg.userId].profile = msg.profile;
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
      for (const [client, info] of clients) {
        if (client !== ws && client.readyState === WebSocket.OPEN && info.id !== msg.from) {
          try { client.send(str); } catch { clients.delete(client); }
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
