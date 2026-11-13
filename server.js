// Static file server + tiny WebSocket relay for multiplayer. No dependencies.
//   node server.js            → http://localhost:8000  (PORT env var to change)
// Every client joins a named room; messages and presence are relayed to the room.
// The game itself runs on the host player's browser — this server only relays.
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = __dirname;
const PORT = +process.env.PORT || 8000;
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.glb': 'model/gltf-binary', '.png': 'image/png', '.md': 'text/plain' };

const server = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p === '/') p = '/index.html';
  const file = path.normalize(path.join(ROOT, p));
  if (!file.startsWith(ROOT)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
});

const rooms = new Map(); // name -> Set(client)
let nextPeer = 1;

server.on('upgrade', (req, socket) => {
  if (!req.url.startsWith('/ws')) return socket.destroy();
  const key = req.headers['sec-websocket-key'];
  const accept = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  const client = { socket, peer: 'p' + (nextPeer++).toString(36) + crypto.randomBytes(3).toString('hex'), room: null, presence: {}, buf: Buffer.alloc(0) };
  socket.on('data', (chunk) => {
    client.buf = Buffer.concat([client.buf, chunk]);
    let frame;
    while ((frame = readFrame(client))) {
      if (frame.op === 8) { socket.end(); return; }
      if (frame.op === 9) { writeFrame(socket, frame.data, 10); continue; }
      if (frame.op !== 1) continue;
      let m;
      try { m = JSON.parse(frame.data.toString('utf8')); } catch (e) { continue; }
      onMessage(client, m);
    }
  });
  const bye = () => leave(client);
  socket.on('close', bye);
  socket.on('error', bye);
});

function onMessage(c, m) {
  if (m.op === 'join' && typeof m.room === 'string') {
    leave(c);
    c.room = m.room.slice(0, 64);
    if (!rooms.has(c.room)) rooms.set(c.room, new Set());
    rooms.get(c.room).add(c);
    send(c, { op: 'welcome', peer: c.peer });
    broadcastPeers(c.room);
  } else if (m.op === 'emit' && c.room) {
    const payload = JSON.stringify({ op: 'msg', topic: String(m.topic), data: m.data, peer: c.peer });
    if (payload.length > 16384) return;
    for (const o of rooms.get(c.room) || []) sendRaw(o, payload);
  } else if (m.op === 'presence' && c.room) {
    if (JSON.stringify(m.presence || {}).length > 8192) return;
    c.presence = m.presence || {};
    broadcastPeers(c.room);
  }
}

function leave(c) {
  if (!c.room) return;
  const set = rooms.get(c.room);
  if (set) { set.delete(c); if (!set.size) rooms.delete(c.room); else broadcastPeers(c.room); }
  c.room = null;
}

function broadcastPeers(room) {
  const set = rooms.get(room);
  if (!set) return;
  const payload = JSON.stringify({ op: 'peers', peers: [...set].map((o) => ({ peer: o.peer, presence: o.presence })) });
  for (const o of set) sendRaw(o, payload);
}

function send(c, o) { sendRaw(c, JSON.stringify(o)); }
function sendRaw(c, s) { try { writeFrame(c.socket, Buffer.from(s), 1); } catch (e) { /* closed */ } }

function writeFrame(socket, data, op) {
  const len = data.length;
  let head;
  if (len < 126) head = Buffer.from([0x80 | op, len]);
  else if (len < 65536) { head = Buffer.alloc(4); head[0] = 0x80 | op; head[1] = 126; head.writeUInt16BE(len, 2); }
  else { head = Buffer.alloc(10); head[0] = 0x80 | op; head[1] = 127; head.writeBigUInt64BE(BigInt(len), 2); }
  socket.write(Buffer.concat([head, data]));
}

function readFrame(c) {
  const b = c.buf;
  if (b.length < 2) return null;
  const op = b[0] & 0x0f;
  const masked = b[1] & 0x80;
  let len = b[1] & 0x7f, off = 2;
  if (len === 126) { if (b.length < 4) return null; len = b.readUInt16BE(2); off = 4; }
  else if (len === 127) { if (b.length < 10) return null; len = Number(b.readBigUInt64BE(2)); off = 10; }
  const mOff = off;
  if (masked) off += 4;
  if (b.length < off + len) return null;
  const data = Buffer.from(b.subarray(off, off + len));
  if (masked) for (let i = 0; i < len; i++) data[i] ^= b[mOff + (i % 4)];
  c.buf = b.subarray(off + len);
  return { op, data };
}

server.listen(PORT, () => console.log(`Killhouse Sim on http://localhost:${PORT}  (multiplayer relay at /ws)`));
