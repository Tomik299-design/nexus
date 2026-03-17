// NexusChat Server
// Spuštění: node server.js
// Připojení: wss://TVOJE-URL

const WebSocket = require('ws');
const http      = require('http');
const fs        = require('fs');
const path      = require('path');
const os        = require('os');

const PORT = process.env.PORT || 3001;

// ── HTTP server ──
// ══════════════════════════════════════════
//  CHANGELOG — edit this to update users
// ══════════════════════════════════════════
const CHANGELOG = [
  {
    version: '2.0',
    date: '2026-03-17',
    items: [
      { type: 'new',  text: 'Real WebRTC voice calls — hear each other!' },
      { type: 'new',  text: 'Server isolation — join only via invite link' },
      { type: 'new',  text: 'Language switcher — EN / CS' },
      { type: 'new',  text: 'Direct Messages (DM)' },
      { type: 'new',  text: 'Channel permissions — restrict who can write' },
      { type: 'new',  text: '@mention picker — type @ to tag someone' },
      { type: 'new',  text: 'Drag & drop members between voice channels' },
      { type: 'new',  text: 'Custom roles with colors' },
      { type: 'fix',  text: 'Stay on same server after page refresh' },
      { type: 'fix',  text: 'Welcome message only for truly new members' },
      { type: 'fix',  text: 'Performance optimizations for gaming' },
    ]
  }
];

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

  <div class="changelog">
    ${CHANGELOG.map(v => \`
      <div class="cl-header">
        <span class="cl-title">🚀 What's new</span>
        <span class="cl-version">v\${v.version}</span>
        <span class="cl-date">\${v.date}</span>
      </div>
      \${v.items.map(item => \`
        <div class="cl-item">
          <span class="cl-badge \${item.type}">\${item.type}</span>
          \${item.text}
        </div>
      \`).join('')}
    \`).join('')}
  </div>

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
const history      = {};
const vcState      = {};
const offlineState = {}; // id -> memberInfo — kdo se odpojil
const MAX_HIST     = 300;

wss.on('connection', (ws, req) => {
  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || '?';
  clients.set(ws, { id: null, name: '?' });
  console.log('[+] ' + ip + ' | celkem: ' + clients.size);

  if (Object.keys(history).length > 0)
    try { ws.send(JSON.stringify({ type: 'history', msgs: history })); } catch {}

  if (Object.keys(vcState).length > 0)
    try { ws.send(JSON.stringify({ type: 'vc_state_sync', state: vcState })); } catch {}

  // Send offline members to new connection
  if (Object.keys(offlineState).length > 0)
    try { ws.send(JSON.stringify({ type: 'offline_sync', offline: offlineState })); } catch {}

  ws.on('message', data => {
    let msg;
    try { msg = JSON.parse(data.toString()); } catch { return; }

    if (msg.type === 'presence' && msg.m) {
      clients.set(ws, { id: msg.m.id, name: msg.m.name || '?', info: msg.m });
      // Remove from offline when they come online
      if (msg.m.id && offlineState[msg.m.id]) delete offlineState[msg.m.id];
    }

    if (msg.type === 'vc_join' && msg.chId && msg.m) {
      if (!vcState[msg.chId]) vcState[msg.chId] = {};
      vcState[msg.chId][msg.m.id] = msg.m;
    }
    if (msg.type === 'vc_leave' && msg.id)
      for (const ch of Object.keys(vcState)) delete vcState[ch][msg.id];

    if (msg.type === 'vc_state_req') {
      try { ws.send(JSON.stringify({ type: 'vc_state_sync', state: vcState })); } catch {}
      return;
    }
    if (msg.type === 'offline_req') {
      try { ws.send(JSON.stringify({ type: 'offline_sync', offline: offlineState })); } catch {}
      return;
    }

    if (msg.type === 'chat' && msg.ch && msg.msg) {
      if (!history[msg.ch]) history[msg.ch] = [];
      history[msg.ch].push(msg.msg);
      if (history[msg.ch].length > MAX_HIST)
        history[msg.ch] = history[msg.ch].slice(-MAX_HIST);
    }

    const str = data.toString();

    // WebRTC signaling — send only to target peer
    if ((msg.type === 'rtc_offer' || msg.type === 'rtc_answer' || msg.type === 'rtc_ice') && msg.to) {
      for (const [client, info] of clients) {
        if (info.id === msg.to && client.readyState === WebSocket.OPEN) {
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
      // Save to offline state with full member info
      if (info.info) {
        offlineState[info.id] = { ...info.info, status: 'offline' };
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
