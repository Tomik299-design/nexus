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
const MAINTENANCE_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="refresh" content="10">
<title>NexusChat — Maintenance</title>
<style>
  * { margin:0; padding:0; box-sizing:border-box; }
  body {
    background: #0a0c0f; color: #cdd6e0;
    font-family: 'Segoe UI', system-ui, sans-serif;
    display: flex; align-items: center; justify-content: center;
    min-height: 100vh; padding: 20px;
  }
  .card {
    text-align: center; max-width: 420px; width: 100%;
    background: #151920; border: 1px solid #1f2836;
    border-radius: 16px; padding: 48px 36px;
    box-shadow: 0 24px 60px rgba(0,0,0,.6);
    animation: fadeIn .5s ease;
  }
  @keyframes fadeIn { from{opacity:0;transform:translateY(12px)} to{opacity:1;transform:translateY(0)} }
  .icon { font-size: 52px; margin-bottom: 20px; animation: spin 3s linear infinite; display:inline-block; }
  @keyframes spin { 0%,100%{transform:rotate(0deg)} 25%{transform:rotate(-8deg)} 75%{transform:rotate(8deg)} }
  h1 { font-size: 22px; font-weight: 600; color: #e2e8f0; margin-bottom: 10px; }
  p  { font-size: 14px; color: #64748b; line-height: 1.7; margin-bottom: 24px; }
  .badge {
    display: inline-flex; align-items: center; gap: 8px;
    background: rgba(79,255,176,.08); border: 1px solid rgba(79,255,176,.2);
    border-radius: 20px; padding: 8px 18px;
    font-size: 13px; color: #4fffb0; margin-bottom: 28px;
  }
  .dot { width:8px; height:8px; border-radius:50%; background:#4fffb0; animation: pulse 1.4s ease infinite; }
  @keyframes pulse { 0%,100%{opacity:1;transform:scale(1)} 50%{opacity:.4;transform:scale(.8)} }
  .progress {
    background: #1c2029; border-radius: 8px; height: 4px;
    overflow: hidden; margin-bottom: 16px;
  }
  .progress-bar {
    height: 100%; background: linear-gradient(90deg, #4fffb0, #7c6aff);
    border-radius: 8px; animation: progress 10s linear infinite;
    width: 0%;
  }
  @keyframes progress { from{width:0%} to{width:100%} }
  small { font-size: 12px; color: #3a4654; }
  a { color: #4fffb0; text-decoration: none; }
</style>
</head>
<body>
<div class="card">
  <div class="icon">⚡</div>
  <h1>Under Maintenance</h1>
  <p>NexusChat is being updated to a newer version.<br>This will only take a few seconds.</p>
  <div class="badge">
    <div class="dot"></div>
    Deploying update...
  </div>
  <div class="progress"><div class="progress-bar"></div></div>
  <p style="margin-bottom:8px">The page will automatically refresh in <strong style="color:#e2e8f0">10 seconds</strong>.</p>
  <small>If the page doesn't load, <a href="javascript:location.reload()">click here to refresh</a>.</small>
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
