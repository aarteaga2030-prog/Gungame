// Multiplayer transport. Two interchangeable backends with the same small API:
//   - the claude.ai artifact `room` capability (when the game runs as an artifact)
//   - a WebSocket relay (server.js) when the game is served by `node server.js`
// Room API: { me, emit(topic, data), on(topic, fn), presence(patch), peers(), onPeers(fn), leave() }
// peers(): [{ peer, isMe, presence }]

export async function detectNet() {
  // artifact runtime
  if (window.claude && typeof window.claude.use === 'function') {
    try {
      const room = await window.claude.use('room');
      if (room) return { kind: 'room', join: (code) => joinArtifactRoom(room, code) };
    } catch (e) { /* fall through */ }
  }
  // WebSocket relay served by server.js
  if (location.protocol.startsWith('http')) {
    const ok = await probeWs();
    if (ok) return { kind: 'ws', join: (code) => joinWsRoom(code) };
  }
  return null;
}

const roomName = (code) => 'kh-' + String(code).toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 12);

async function joinArtifactRoom(lobby, code) {
  const r = await lobby.join(roomName(code));
  const handlers = new Map();
  const wrapPeers = () => r.peers().map((p) => ({ peer: p.peer, isMe: p.isMe && p.sameTab, presence: p.presence || {} }));
  const api = {
    get me() { const m = r.peers().find((p) => p.isMe && p.sameTab); return m ? m.peer : null; },
    emit: (topic, data) => r.emit(topic, data).catch(() => {}),
    on(topic, fn) { return r.on(topic, (msg) => fn(msg.data, msg.peer, msg.isMe && msg.sameTab)); },
    presence: (patch) => r.presence(patch).catch(() => {}),
    peers: wrapPeers,
    onPeers(fn) { return r.onPeers(() => fn(wrapPeers())); },
    leave: () => r.leave().catch(() => {}),
    connected: () => r.connected(),
  };
  // wait briefly until we know our own peer id
  for (let i = 0; i < 50 && !api.me; i++) await new Promise((res) => setTimeout(res, 100));
  void handlers;
  return api;
}

function wsUrl() { return (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws'; }

function probeWs() {
  return new Promise((resolve) => {
    let done = false;
    let ws;
    try { ws = new WebSocket(wsUrl()); } catch (e) { resolve(false); return; }
    const t = setTimeout(() => { if (!done) { done = true; try { ws.close(); } catch (e) { /* */ } resolve(false); } }, 1500);
    ws.onopen = () => { if (!done) { done = true; clearTimeout(t); ws.close(); resolve(true); } };
    ws.onerror = () => { if (!done) { done = true; clearTimeout(t); resolve(false); } };
  });
}

function joinWsRoom(code) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl());
    const topics = new Map();
    const peerFns = new Set();
    let me = null;
    let peers = [];
    let pres = {};
    let presTimer = null;
    const send = (o) => { if (ws.readyState === 1) ws.send(JSON.stringify(o)); };
    const api = {
      get me() { return me; },
      emit: async (topic, data) => send({ op: 'emit', topic, data }),
      on(topic, fn) {
        if (!topics.has(topic)) topics.set(topic, new Set());
        topics.get(topic).add(fn);
        return () => topics.get(topic).delete(fn);
      },
      presence: async (patch) => {
        Object.assign(pres, patch);
        for (const k of Object.keys(patch)) if (patch[k] === null) delete pres[k];
        // coalesce to ~30/s like the artifact room
        if (!presTimer) presTimer = setTimeout(() => { presTimer = null; send({ op: 'presence', presence: pres }); }, 33);
      },
      peers: () => peers.map((p) => ({ ...p, isMe: p.peer === me })),
      onPeers(fn) { peerFns.add(fn); return () => peerFns.delete(fn); },
      leave: async () => ws.close(),
      connected: () => ws.readyState === 1,
    };
    ws.onopen = () => send({ op: 'join', room: roomName(code) });
    ws.onerror = () => reject(new Error('WebSocket error'));
    ws.onmessage = (ev) => {
      let m;
      try { m = JSON.parse(ev.data); } catch (e) { return; }
      if (m.op === 'welcome') { me = m.peer; resolve(api); }
      else if (m.op === 'peers') { peers = m.peers; for (const fn of peerFns) fn(api.peers()); }
      else if (m.op === 'msg') { const set = topics.get(m.topic); if (set) for (const fn of set) fn(m.data, m.peer, m.peer === me); }
    };
  });
}

/** Keep a JSON payload under the room's 4 KiB message limit by trimming the event list. */
export function fitSnapshot(snap, events) {
  let ev = events;
  for (let i = 0; i < 6; i++) {
    const msg = { ...snap, ev };
    const len = JSON.stringify(msg).length;
    if (len < 3900) return msg;
    // drop shots first, then everything but tile/end/msg/death
    ev = i < 3 ? ev.filter((e, k) => e.k !== 'shot' || k % 2 === 0) : ev.filter((e) => e.k !== 'shot' && e.k !== 'blast');
  }
  return { ...snap, ev: ev.filter((e) => e.k === 'end' || e.k === 'tile') };
}
