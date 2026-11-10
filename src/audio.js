// Tiny synthesized sound kit (no audio files needed) + optional narrator TTS.
let ctx = null;
let noiseBuf = null;
export const audio = { enabled: true, voice: true, listener: { x: 0, z: 0 } };

function ensure() {
  if (!audio.enabled) return null;
  if (!ctx) {
    try {
      ctx = new (window.AudioContext || window.webkitAudioContext)();
      noiseBuf = ctx.createBuffer(1, ctx.sampleRate * 1.5, ctx.sampleRate);
      const d = noiseBuf.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    } catch (e) { audio.enabled = false; return null; }
  }
  if (ctx.state === 'suspended') ctx.resume();
  return ctx;
}

function vol(x, z) {
  if (x == null) return 1;
  const d = Math.hypot(x - audio.listener.x, z - audio.listener.z);
  return Math.max(0.05, 1 - d / 60);
}

function burst({ freq = 1200, q = 0.8, dur = 0.12, gain = 0.4, type = 'bandpass', x, z }) {
  const c = ensure();
  if (!c) return;
  const src = c.createBufferSource();
  src.buffer = noiseBuf;
  const f = c.createBiquadFilter();
  f.type = type; f.frequency.value = freq; f.Q.value = q;
  const g = c.createGain();
  const v = gain * vol(x, z);
  const t = c.currentTime;
  g.gain.setValueAtTime(v, t);
  g.gain.exponentialRampToValueAtTime(0.0008, t + dur);
  src.connect(f); f.connect(g); g.connect(c.destination);
  src.start(t, Math.random() * 0.5, dur + 0.05);
}

export const sfx = {
  shot(team, x, z, heavy) {
    burst({ freq: heavy ? 700 : team === 'blue' ? 1500 : 1100, q: 0.7, dur: heavy ? 0.16 : 0.1, gain: heavy ? 0.5 : 0.35, x, z });
    burst({ freq: 180, q: 0.5, dur: 0.08, gain: 0.25, type: 'lowpass', x, z });
  },
  boom(x, z, big = 1) {
    burst({ freq: 140, q: 0.4, dur: 1.1 * big, gain: 0.9, type: 'lowpass', x, z });
    burst({ freq: 900, q: 0.4, dur: 0.25, gain: 0.5, x, z });
  },
  click() { burst({ freq: 3000, q: 3, dur: 0.03, gain: 0.15 }); },
  pop(x, z) { burst({ freq: 500, q: 1, dur: 0.3, gain: 0.3, x, z }); },
  whistle() {
    const c = ensure();
    if (!c) return;
    const o = c.createOscillator();
    const g = c.createGain();
    const t = c.currentTime;
    o.frequency.setValueAtTime(1800, t);
    o.frequency.exponentialRampToValueAtTime(500, t + 1.2);
    g.gain.setValueAtTime(0.05, t);
    g.gain.linearRampToValueAtTime(0.0, t + 1.25);
    o.connect(g); g.connect(c.destination);
    o.start(t); o.stop(t + 1.3);
  },
  beep(hi) {
    const c = ensure();
    if (!c) return;
    const o = c.createOscillator();
    const g = c.createGain();
    const t = c.currentTime;
    o.type = 'square';
    o.frequency.value = hi ? 1320 : 660;
    g.gain.setValueAtTime(0.05, t);
    g.gain.exponentialRampToValueAtTime(0.0008, t + 0.12);
    o.connect(g); g.connect(c.destination);
    o.start(t); o.stop(t + 0.13);
  },
};

export function speak(text) {
  if (!audio.voice || !('speechSynthesis' in window)) return;
  try {
    const u = new SpeechSynthesisUtterance(text.replace(/[^\w\s.,!?'%°:-]/g, ''));
    u.rate = 1.12;
    u.pitch = 0.9;
    window.speechSynthesis.speak(u);
  } catch (e) { /* ignore */ }
}
export function stopSpeech() {
  try { if ('speechSynthesis' in window) window.speechSynthesis.cancel(); } catch (e) { /* ignore */ }
}
