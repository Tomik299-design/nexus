// ═══════════════════════════════════════════════
//  NexusChat Server — veřejný WebSocket server
//  Nasazení: Render.com (zdarma)
//  Lokální spuštění: node server.js
// ═══════════════════════════════════════════════

const WebSocket = require('ws');
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

const PORT = process.env.PORT || 3001;

// ── HTTP server (servíruje NexusChat.html) ──
const httpServer = http.createServer((req, res) => {
  // CORS headers pro přístup odkudkoli
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');

  const htmlFile = path.join(__dirname, 'NexusChat.html');

  if (req.url === '/' || req.url === '/index.html') {
    if (fs.existsSync(htmlFile)) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      fs.createReadStream(htmlFile).pipe(res);
    } else {
      // Fallback stránka pokud NexusChat.html chybí
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>NexusChat Server</title>
        <style>body{background:#0a0c0f;color:#4fffb0;font-family:monospace;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;flex-direction:column;gap:12px}
        h1{font-size:24px}p{color:#6b7c8f;font-size:14px}code{background:#1c2029;padding:4px 8px;border-radius:4px}</style></head>
        <body><h1>⚡ NexusChat Server běží</h1>
        <p>WebSocket: <code>wss://${req.headers.host}</code></p>
        <p>Umísti <code>NexusChat.html</code> do stejné složky pro přímý přístup.</p>
        <p style="color:#3a4654">Připojených klientů: ${clients.size}</p></body></html>`);
    }
    return;
  }

  // Health check pro Render.com
  if (req.url === '/health' || req.url === '/ping') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', clients: clients.size, uptime: process.uptime() }));
    return;
  }

  res.writeHead(404); res.end('Not found');
});

// ── WebSocket server ──
const wss = new WebSocket.Server({ server: httpServer });
const clients = new Map(); // ws -> {id, name}

// Uložené zprávy v paměti (max 200 na kanál)
const messageHistory = {};
const MAX_HISTORY = 200;

wss.on('connection', (ws, req) => {
  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
  console.log(`[+] Nové připojení z ${ip}, celkem: ${clients.size + 1}`);

  clients.set(ws, { id: null, name: 'neznámý' });

  // Pošli historii zpráv novému klientovi
  if (Object.keys(messageHistory).length > 0) {
    try {
      ws.send(JSON.stringify({
        type: 'history',
        msgs: messageHistory
      }));
    } catch (e) {}
  }

  ws.on('message', (data) => {
    let msg;
    try { msg = JSON.parse(data.toString()); } catch { return; }

    // Ulož info o klientovi
    if (msg.type === 'presence' && msg.m) {
      clients.set(ws, { id: msg.m.id, name: msg.m.name || 'neznámý' });
    }

    // Ulož zprávy do historie
    if (msg.type === 'chat' && msg.ch && msg.msg) {
      if (!messageHistory[msg.ch]) messageHistory[msg.ch] = [];
      messageHistory[msg.ch].push(msg.msg);
      // Ořízni historii
      if (messageHistory[msg.ch].length > MAX_HISTORY) {
        messageHistory[msg.ch] = messageHistory[msg.ch].slice(-MAX_HISTORY);
      }
    }

    // Broadcast všem ostatním připojeným klientům
    const dataStr = data.toString();
    for (const [client] of clients) {
      if (client !== ws && client.readyState === WebSocket.OPEN) {
        try { client.send(dataStr); } catch (e) { clients.delete(client); }
      }
    }
  });

  ws.on('close', () => {
    const info = clients.get(ws);
    console.log(`[-] Odpojeno: ${info?.name || 'neznámý'}, celkem: ${clients.size - 1}`);
    // Oznámit ostatním odpojení
    if (info?.id) {
      const leaveMsg = JSON.stringify({ type: 'leave', id: info.id });
      for (const [client] of clients) {
        if (client !== ws && client.readyState === WebSocket.OPEN) {
          try { client.send(leaveMsg); } catch (e) {}
        }
      }
    }
    clients.delete(ws);
  });

  ws.on('error', () => clients.delete(ws));
});

// ── Ping klientů každých 30s (udržuje spojení na Render.com) ──
setInterval(() => {
  for (const [ws] of clients) {
    if (ws.readyState === WebSocket.OPEN) {
      try { ws.ping(); } catch (e) { clients.delete(ws); }
    } else {
      clients.delete(ws);
    }
  }
}, 30000);

// ── Spuštění ──
httpServer.listen(PORT, '0.0.0.0', () => {
  console.log('\n╔══════════════════════════════════════╗');
  console.log('║       NexusChat Server               ║');
  console.log('╚══════════════════════════════════════╝');
  console.log(`\nPort: ${PORT}`);

  if (process.env.RENDER) {
    // Jsme na Render.com
    console.log(`\nRender URL: https://${process.env.RENDER_EXTERNAL_HOSTNAME}`);
    console.log(`WS adresa:  wss://${process.env.RENDER_EXTERNAL_HOSTNAME}`);
    console.log('\n→ Tuto WSS adresu vlož do NexusChatuu!');
  } else {
    // Lokální spuštění
    console.log('\nLokálně: http://localhost:' + PORT);
    const nets = os.networkInterfaces();
    for (const name of Object.keys(nets)) {
      for (const net of nets[name]) {
        if (net.family === 'IPv4' && !net.internal) {
          console.log(`Síť:      http://${net.address}:${PORT}`);
          console.log(`WS:       ws://${net.address}:${PORT}`);
        }
      }
    }
  }

  console.log('\nČekám na připojení... (Ctrl+C pro ukončení)\n');
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('\nUkončuji server...');
  wss.close(() => httpServer.close(() => process.exit(0)));
});
