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
const httpServer = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');

  // Mapování URL na soubory
  const routes = {
    '/':            'NexusChat.html',
    '/index.html':  'NexusChat.html',
    '/invite':      'invite.html',
    '/invite.html': 'invite.html',
  };

  const urlPath  = req.url.split('?')[0];
  const fileName = routes[urlPath];

  if (fileName) {
    const filePath = path.join(__dirname, fileName);
    if (fs.existsSync(filePath)) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      fs.createReadStream(filePath).pipe(res);
      return;
    }
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Soubor ' + fileName + ' nenalezen. Uloz ho do stejne slozky jako server.js');
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
const clients = new Map();
const history = {};
const vcState = {};
const MAX_HIST = 300;

wss.on('connection', (ws, req) => {
  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || '?';
  clients.set(ws, { id: null, name: '?' });
  console.log('[+] ' + ip + ' | celkem: ' + clients.size);

  if (Object.keys(history).length > 0)
    try { ws.send(JSON.stringify({ type: 'history', msgs: history })); } catch {}

  if (Object.keys(vcState).length > 0)
    try { ws.send(JSON.stringify({ type: 'vc_state_sync', state: vcState })); } catch {}

  ws.on('message', data => {
    let msg;
    try { msg = JSON.parse(data.toString()); } catch { return; }

    if (msg.type === 'presence' && msg.m)
      clients.set(ws, { id: msg.m.id, name: msg.m.name || '?' });

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

    if (msg.type === 'chat' && msg.ch && msg.msg) {
      if (!history[msg.ch]) history[msg.ch] = [];
      history[msg.ch].push(msg.msg);
      if (history[msg.ch].length > MAX_HIST)
        history[msg.ch] = history[msg.ch].slice(-MAX_HIST);
    }

    const str = data.toString();
    for (const [client] of clients)
      if (client !== ws && client.readyState === WebSocket.OPEN)
        try { client.send(str); } catch { clients.delete(client); }
  });

  ws.on('close', () => {
    const info = clients.get(ws);
    console.log('[-] ' + (info?.name || '?') + ' | celkem: ' + (clients.size - 1));
    if (info?.id) {
      for (const ch of Object.keys(vcState)) delete vcState[ch][info.id];
      const leave = JSON.stringify({ type: 'leave', id: info.id });
      for (const [c] of clients)
        if (c !== ws && c.readyState === WebSocket.OPEN)
          try { c.send(leave); } catch {}
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
