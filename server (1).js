const WebSocket=require('ws'),http=require('http'),fs=require('fs'),path=require('path'),os=require('os');
const PORT=process.env.PORT||3001;
const httpServer=http.createServer((req,res)=>{
  res.setHeader('Access-Control-Allow-Origin','*');
  const f=path.join(__dirname,'NexusChat.html');
  if(req.url==='/'&&fs.existsSync(f)){res.writeHead(200,{'Content-Type':'text/html;charset=utf-8'});fs.createReadStream(f).pipe(res);return;}
  if(req.url==='/health'){res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({status:'ok',clients:clients.size}));return;}
  res.writeHead(200,{'Content-Type':'text/html'});res.end('<h2>NexusChat Server &#x2713;</h2>');
});
const wss=new WebSocket.Server({server:httpServer});
const clients=new Map();
const history={};
const MAX=300;
wss.on('connection',(ws)=>{
  clients.set(ws,{id:null,name:'?'});
  if(Object.keys(history).length>0)try{ws.send(JSON.stringify({type:'history',msgs:history}))}catch{}
  ws.on('message',data=>{
    let msg;try{msg=JSON.parse(data.toString())}catch{return;}
    if(msg.type==='presence'&&msg.m)clients.set(ws,{id:msg.m.id,name:msg.m.name});
    if(msg.type==='chat'&&msg.ch&&msg.msg){
      if(!history[msg.ch])history[msg.ch]=[];
      history[msg.ch].push(msg.msg);
      if(history[msg.ch].length>MAX)history[msg.ch]=history[msg.ch].slice(-MAX);
    }
    const str=data.toString();
    for(const[c]of clients)if(c!==ws&&c.readyState===WebSocket.OPEN)try{c.send(str)}catch{clients.delete(c);}
  });
  ws.on('close',()=>{
    const info=clients.get(ws);
    if(info&&info.id){const leave=JSON.stringify({type:'leave',id:info.id});for(const[c]of clients)if(c!==ws&&c.readyState===WebSocket.OPEN)try{c.send(leave)}catch{}}
    clients.delete(ws);
  });
  ws.on('error',()=>clients.delete(ws));
});
setInterval(()=>{for(const[ws]of clients){if(ws.readyState===WebSocket.OPEN)try{ws.ping()}catch{clients.delete(ws);}else clients.delete(ws);}},25000);
httpServer.listen(PORT,'0.0.0.0',()=>{
  console.log('NexusChat Server na portu '+PORT);
  if(process.env.RENDER_EXTERNAL_HOSTNAME){console.log('WSS: wss://'+process.env.RENDER_EXTERNAL_HOSTNAME);}
  else{const nets=os.networkInterfaces();for(const n of Object.keys(nets))for(const i of nets[n])if(i.family==='IPv4'&&!i.internal)console.log('WS: ws://'+i.address+':'+PORT);}
});
