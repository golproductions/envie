// Envie. Copyright (c) 2026 GOL Productions (https://golproductions.com). See LICENSE.
// Render engine: deterministic HTML -> MP4.
// Drives a headless Chrome over CDP, seeks every CSS/WAAPI animation
// frame-by-frame (no wall-clock flakiness), pipes PNG frames to ffmpeg.
// Zero npm dependencies: Node's built-in WebSocket + child_process.

const { spawn, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const CHROME_CANDIDATES = [
  process.env.ENVIE_CHROME,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium-browser',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
].filter(Boolean);

function findChrome() {
  for (const c of CHROME_CANDIDATES) if (fs.existsSync(c)) return c;
  throw new Error('Chrome not found. Set ENVIE_CHROME to your Chrome binary path.');
}

function findFfmpeg() {
  try { execSync('ffmpeg -version', { stdio: 'pipe', windowsHide: true }); return 'ffmpeg'; }
  catch { throw new Error('ffmpeg not found on PATH. Install ffmpeg first.'); }
}

class CDP {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); this.sessions = {}; this.onevent = () => {}; }
  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('CDP connect failed')); });
    const c = new CDP(ws);
    ws.onmessage = (m) => {
      const msg = JSON.parse(typeof m.data === 'string' ? m.data : m.data.toString());
      if (msg.id && c.pending.has(msg.id)) {
        const { res, rej } = c.pending.get(msg.id);
        c.pending.delete(msg.id);
        msg.error ? rej(new Error(msg.error.message)) : res(msg.result);
      } else if (msg.method) c.onevent(msg);
    };
    return c;
  }
  send(method, params = {}, sessionId, timeoutMs = 60000) {
    const id = ++this.id;
    return new Promise((res, rej) => {
      // A command that never answers means the renderer died mid-frame
      // (heavy WebGL under software GL can kill it). The law: fail loud,
      // never hang -- a stuck render once sat 30 minutes at 0% CPU because
      // this promise had no way out (found 8 July 2026).
      const t = setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          rej(new Error(`renderer stopped answering (${method} after ${timeoutMs / 1000}s). The composition is likely too heavy for the render engine; simplify it or lower the canvas size.`));
        }
      }, timeoutMs);
      this.pending.set(id, { res: (v) => { clearTimeout(t); res(v); }, rej: (e) => { clearTimeout(t); rej(e); } });
      this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }
  // The renderer can also die announced: reject everything in flight so the
  // caller gets the real reason instead of a timeout.
  crashAll(reason) {
    for (const [id, p] of this.pending) { this.pending.delete(id); p.rej(new Error(reason)); }
  }
  close() { try { this.ws.close(); } catch {} }
}

// The virtual clock. Injected before any page script runs, it takes ownership
// of time itself: performance.now, Date.now, rAF, setTimeout, setInterval all
// advance only when the seek loop says so. Anything a browser can animate --
// canvas, WebGL, physics, JS-driven motion -- renders frame-perfect.
const SEEK_HARNESS = `
(() => {
  if (window.__envie) return;
  window.__envie = true;
  const epoch = 1783200000000; // fixed epoch: two renders of the same code are identical
  let vt = 0;
  const rafQ = new Map(); let rafId = 1;
  const timers = new Map(); let tid = 1;
  const realSetTimeout = window.setTimeout.bind(window); // real clock, media-seek waits only

  performance.now = () => vt;

  // Date is fully virtual: new Date() and Date.now() both read the seek clock
  const RealDate = Date;
  window.Date = class Date extends RealDate {
    constructor(...a) { a.length === 0 ? super(epoch + vt) : super(...a); }
    static now() { return epoch + vt; }
  };

  // deterministic entropy: same composition, same "random" every render
  let seed = 0x9E3779B9;
  Math.random = () => {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let z = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    z = (z + Math.imul(z ^ (z >>> 7), 61 | z)) ^ z;
    return ((z ^ (z >>> 14)) >>> 0) / 4294967296;
  };
  if (window.crypto && crypto.getRandomValues) {
    crypto.getRandomValues = (arr) => {
      const bytes = new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength);
      for (let i = 0; i < bytes.length; i++) bytes[i] = (Math.random() * 256) | 0;
      return arr;
    };
  }

  window.requestAnimationFrame = (cb) => { const id = rafId++; rafQ.set(id, cb); return id; };
  window.cancelAnimationFrame = (id) => { rafQ.delete(id); };
  window.setTimeout = (cb, d = 0, ...a) => {
    if (typeof cb !== 'function') return 0;
    const id = tid++; timers.set(id, { at: vt + Math.max(0, +d || 0), cb, a, int: null }); return id;
  };
  window.setInterval = (cb, d = 16, ...a) => {
    if (typeof cb !== 'function') return 0;
    const id = tid++; const int = Math.max(1, +d || 16);
    timers.set(id, { at: vt + int, cb, a, int }); return id;
  };
  window.clearTimeout = window.clearInterval = (id) => { timers.delete(id); };
  window.requestIdleCallback = (cb) => window.setTimeout(() => cb({ didTimeout: false, timeRemaining: () => 50 }), 1);
  window.cancelIdleCallback = (id) => { timers.delete(id); };

  // ---- Animated image virtualization (GIF / WebP / APNG / AVIF) ----
  // Native image animation runs on the wall clock and cannot be seeked. Decode each
  // animated image ONCE, then every seek show the frame for the looped virtual time.
  // An <img> gets an overlay canvas locked over it. A CSS background-image gets its
  // url() swapped to a pre-decoded frame, which keeps background-size / position /
  // repeat exactly as the browser computed them, with no CSS re-implementation.
  // No animated images on the page -> none of this runs.
  const imgReg = new Map();     // <img> -> { dec, canvas }
  const bgReg = new Map();      // element -> { dec }
  const decCache = new Map();   // src -> Promise<dec|null>: the same image decodes once
  const seenEl = new WeakSet();
  let imgPending = [];

  // NB: template-literal harness -> no regex, no backslashes, no backticks.
  const animTypeOf = (u) => {
    const sc = (u || '').toLowerCase();
    if (sc.startsWith('data:image/')) {
      const semi = sc.indexOf(';'), comma = sc.indexOf(',');
      const end = (semi >= 0 && (comma < 0 || semi < comma)) ? semi : comma;
      const m = end > 5 ? sc.slice(5, end) : '';
      if (m === 'image/apng') return 'image/png';
      if (m === 'image/gif' || m === 'image/webp' || m === 'image/png' || m === 'image/avif') return m;
      return null;
    }
    if (sc.includes('.gif')) return 'image/gif';
    if (sc.includes('.webp')) return 'image/webp';
    if (sc.includes('.apng')) return 'image/png';
    if (sc.includes('.avif')) return 'image/avif';
    return null;
  };

  const cssUrlOf = (bg) => {
    if (!bg) return null;
    const i = bg.indexOf('url(');
    if (i < 0) return null;
    const j = i + 4, k = bg.indexOf(')', j);
    if (k < 0) return null;
    let u = bg.slice(j, k).trim();
    const q = u.charAt(0);
    if (u.length > 1 && (q === '"' || q === "'")) u = u.slice(1, -1);
    return u;
  };
  function decodeAnimated(src, type) {
    if (decCache.has(src)) return decCache.get(src);
    const p = (async () => {
      if (!src || typeof ImageDecoder === 'undefined') return null;
      let data;
      try { data = await (await fetch(src)).arrayBuffer(); } catch (e) { return null; }
      let dec;
      try { dec = new ImageDecoder({ data, type }); await dec.tracks.ready; } catch (e) { return null; }
      const track = dec.tracks.selectedTrack || dec.tracks[0];
      const count = track ? track.frameCount : 1;
      if (!count || count < 2) { try { dec.close(); } catch (e) {} return null; } // static: leave it alone
      const frames = []; let acc = 0;
      for (let i = 0; i < count; i++) {
        let r; try { r = await dec.decode({ frameIndex: i }); } catch (e) { break; }
        const vf = r.image;
        const durMs = (vf.duration && vf.duration > 0) ? vf.duration / 1000 : 100; // default frame ~100ms
        acc += durMs;
        let bmp = null; try { bmp = await createImageBitmap(vf); } catch (e) {}
        try { vf.close(); } catch (e) {}
        if (bmp) frames.push({ bmp, end: acc });
      }
      try { dec.close(); } catch (e) {}
      if (!frames.length) return null;
      // Pre-render every frame to a data URL and pre-decode it, so swapping a
      // background-image paints on THIS frame instead of racing the shutter.
      const urls = [], warm = [];
      for (const f of frames) {
        const c = document.createElement('canvas');
        c.width = f.bmp.width; c.height = f.bmp.height;
        c.getContext('2d').drawImage(f.bmp, 0, 0);
        const u = c.toDataURL('image/png');
        urls.push(u);
        const im = new Image(); im.src = u;
        f.keep = im;  // hold a reference so it stays decoded in cache
        warm.push(im.decode ? im.decode().catch(() => {}) : Promise.resolve());
      }
      try { await Promise.all(warm); } catch (e) {}
      return { frames, urls, total: frames[frames.length - 1].end };
    })();
    decCache.set(src, p);
    return p;
  }

  const frameIndexAt = (dec, t) => {
    const looped = dec.total > 0 ? (t % dec.total) : 0;
    for (let i = 0; i < dec.frames.length; i++) if (looped < dec.frames[i].end) return i;
    return dec.frames.length - 1;
  };
  async function __envieGifPrepare() {
    for (const el of document.querySelectorAll('*')) {
      if (seenEl.has(el)) continue;
      seenEl.add(el);
      if (el.tagName === 'IMG') {
        const src = el.currentSrc || el.src;
        const ty = animTypeOf(src);
        if (ty) imgPending.push(decodeAnimated(src, ty).then((dec) => {
          if (!dec) return;
          const cv = document.createElement('canvas');
          cv.style.cssText = 'position:fixed;pointer-events:none;margin:0;padding:0;z-index:2147483646;overflow:hidden;';
          try { cv.style.borderRadius = getComputedStyle(el).borderRadius; } catch (e) {}
          document.body.appendChild(cv);
          el.style.visibility = 'hidden';  // keep the layout box, drop the frozen native frame
          imgReg.set(el, { dec, canvas: cv });
        }));
        continue;
      }
      let bg = null;
      try { bg = getComputedStyle(el).backgroundImage; } catch (e) {}
      const u = cssUrlOf(bg);
      const bty = u ? animTypeOf(u) : null;
      if (bty) imgPending.push(decodeAnimated(u, bty).then((dec) => { if (dec) bgReg.set(el, { dec }); }));
    }
    if (imgPending.length) { const p = imgPending; imgPending = []; try { await Promise.all(p); } catch (e) {} }
  }

  function __envieGifDraw(t) {
    for (const [el, g] of imgReg) {
      const cv = g.canvas, r = el.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) { cv.style.display = 'none'; continue; }
      cv.style.display = 'block';
      const w = Math.max(1, Math.round(r.width)), h = Math.max(1, Math.round(r.height));
      if (cv.width !== w) cv.width = w;
      if (cv.height !== h) cv.height = h;
      cv.style.left = r.left + 'px'; cv.style.top = r.top + 'px';
      cv.style.width = w + 'px'; cv.style.height = h + 'px';
      const f = g.dec.frames[frameIndexAt(g.dec, t)];
      const ctx = cv.getContext('2d');
      ctx.clearRect(0, 0, w, h);
      try { ctx.drawImage(f.bmp, 0, 0, w, h); } catch (e) {}
    }
    for (const [el, g] of bgReg) {
      const i = frameIndexAt(g.dec, t);
      if (el.__envieBgFrame === i) continue;   // only touch the DOM when the frame changes
      el.__envieBgFrame = i;
      try { el.style.backgroundImage = 'url("' + g.dec.urls[i] + '")'; } catch (e) {}
    }
  }

  // ---- WebAudio virtualization ----
  // AudioContext.currentTime and AnalyserNode reads ride the audio hardware
  // clock, which the muted offline render never advances -- audio-reactive
  // visuals sit dead at zero. Bind currentTime to vt and compute analyser data
  // deterministically from the source PCM at vt. No AudioContext -> nothing runs.
  const audioReady = [];
  (() => {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    const BAC = window.BaseAudioContext || AC;
    try { Object.defineProperty(BAC.prototype, 'currentTime', { configurable: true, get() { return vt / 1000; } }); } catch (e) {}

    let decodeCtx = null;
    const OAC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    const getDecodeCtx = () => decodeCtx || (decodeCtx = OAC ? new OAC(1, 1, 44100) : new AC());

    const realDecode = BAC.prototype.decodeAudioData;
    if (realDecode) {
      BAC.prototype.decodeAudioData = function (...a) {
        const p = realDecode.apply(this, a);
        if (p && p.then) audioReady.push(p.catch(() => {}));
        return p;
      };
    }

    function fft(re, im) {
      const n = re.length;
      for (let i = 1, j = 0; i < n; i++) {
        let bit = n >> 1;
        for (; j & bit; bit >>= 1) j ^= bit;
        j ^= bit;
        if (i < j) { const tr = re[i]; re[i] = re[j]; re[j] = tr; const ti = im[i]; im[i] = im[j]; im[j] = ti; }
      }
      for (let len = 2; len <= n; len <<= 1) {
        const ang = -2 * Math.PI / len, wr = Math.cos(ang), wi = Math.sin(ang), half = len >> 1;
        for (let i = 0; i < n; i += len) {
          let cwr = 1, cwi = 0;
          for (let k = 0; k < half; k++) {
            const ar = re[i + k], ai = im[i + k];
            const br = re[i + k + half] * cwr - im[i + k + half] * cwi;
            const bi = re[i + k + half] * cwi + im[i + k + half] * cwr;
            re[i + k] = ar + br; im[i + k] = ai + bi;
            re[i + k + half] = ar - br; im[i + k + half] = ai - bi;
            const ncwr = cwr * wr - cwi * wi; cwi = cwr * wi + cwi * wr; cwr = ncwr;
          }
        }
      }
    }
    const winCache = {};
    const blackman = (N) => { if (winCache[N]) return winCache[N]; const w = new Float32Array(N); for (let n = 0; n < N; n++) w[n] = 0.42 - 0.5 * Math.cos(2 * Math.PI * n / (N - 1)) + 0.08 * Math.cos(4 * Math.PI * n / (N - 1)); return winCache[N] = w; };

    const oscWave = (type, ph) => {
      const x = ph / (2 * Math.PI), fr = x - Math.floor(x);
      if (type === 'square') return fr < 0.5 ? 1 : -1;
      if (type === 'sawtooth') return 2 * fr - 1;
      if (type === 'triangle') return fr < 0.5 ? (4 * fr - 1) : (3 - 4 * fr);
      return Math.sin(ph);
    };

    // ---- AudioParam automation ----
    // A scheduled param (setValueAtTime, linear/exponential ramps, setTargetAtTime,
    // value curves) is replayed from its own event list as a pure function of the
    // timeline, so a swept oscillator or an enveloped gain reads back correctly at
    // every frame instead of freezing at its construction value.
    const paramEvents = new WeakMap();
    const evsOf = (p) => { let e = paramEvents.get(p); if (!e) { e = []; paramEvents.set(p, e); } return e; };
    const paramValueAt = (p, tsec) => {
      if (!p) return 0;
      let base = 0;
      try { base = (typeof p.value === 'number') ? p.value : 0; } catch (e) {}
      const evs = paramEvents.get(p);
      if (!evs || !evs.length) return base;
      const e = evs.slice().sort((a, b) => a.time - b.time);
      let prevV = base, prevT = 0;
      for (let k = 0; k < e.length; k++) {
        const ev = e[k];
        if (ev.time > tsec) {
          const span = ev.time - prevT;
          const f = span > 0 ? (tsec - prevT) / span : 1;
          if (ev.type === 'linear') return prevV + (ev.value - prevV) * f;
          if (ev.type === 'exp') {
            const a0 = (prevV === 0) ? 1e-6 : prevV, b0 = (ev.value === 0) ? 1e-6 : ev.value;
            return a0 * Math.pow(b0 / a0, f);
          }
          return prevV;
        }
        if (ev.type === 'target') {
          const tc = Math.max(1e-6, ev.tc || 1e-6);
          prevV = ev.value + (prevV - ev.value) * Math.exp(-(tsec - ev.time) / tc);
        } else if (ev.type === 'curve') {
          const arr = ev.curve, dur = ev.dur || 0;
          const f2 = dur > 0 ? Math.min(1, Math.max(0, (tsec - ev.time) / dur)) : 1;
          const idx = f2 * (arr.length - 1);
          const i0 = Math.floor(idx), i1 = Math.min(arr.length - 1, i0 + 1);
          prevV = arr[i0] + (arr[i1] - arr[i0]) * (idx - i0);
        } else {
          prevV = ev.value;
        }
        prevT = ev.time;
      }
      return prevV;
    };
    const AParam = window.AudioParam && window.AudioParam.prototype;
    if (AParam) {
      const wrapParam = (name, type) => {
        const r = AParam[name];
        if (!r) return;
        AParam[name] = function () {
          const a = arguments;
          try {
            const e = evsOf(this);
            if (type === 'curve') e.push({ type: 'curve', curve: Array.prototype.slice.call(a[0]), time: a[1], dur: a[2] });
            else if (type === 'target') e.push({ type: 'target', value: a[0], time: a[1], tc: a[2] });
            else e.push({ type: type, value: a[0], time: a[1] });
          } catch (er) {}
          try { return r.apply(this, a); } catch (er) { return this; }
        };
      };
      wrapParam('setValueAtTime', 'set');
      wrapParam('linearRampToValueAtTime', 'linear');
      wrapParam('exponentialRampToValueAtTime', 'exp');
      wrapParam('setTargetAtTime', 'target');
      wrapParam('setValueCurveAtTime', 'curve');
      const rcs = AParam.cancelScheduledValues;
      if (rcs) AParam.cancelScheduledValues = function (tt) {
        try { const e = evsOf(this); for (let i = e.length - 1; i >= 0; i--) if (e[i].time >= tt) e.splice(i, 1); } catch (er) {}
        try { return rcs.apply(this, arguments); } catch (er) { return this; }
      };
    }

    // gain sitting between the source and the analyser, evaluated at this frame
    const chainGain = (node, tsec) => {
      const gs = node && node.__envieGains;
      if (!gs || !gs.length) return 1;
      let g = 1;
      for (let i = 0; i < gs.length; i++) { try { g *= paramValueAt(gs[i].gain, tsec); } catch (e) {} }
      return g;
    };

    function sampleWindowAt(node, size, tms) {
      const out = new Float32Array(size);
      const s = node && node.__envieSrc;
      if (!s) return out;
      const tsec = tms / 1000;
      const g = chainGain(node, tsec);
      if (s.kind === 'osc') {
        // an oscillator has no PCM: synthesise its waveform at this frame instead
        if (s.startWhen == null) return out;
        const t0 = tsec - s.startWhen;
        if (t0 < 0) return out;
        const sr = 44100;
        const type = (s.node && s.node.type) || 'sine';
        let f = 440, det = 0;
        try { if (s.node && s.node.frequency) f = paramValueAt(s.node.frequency, tsec); } catch (e) {}
        try { if (s.node && s.node.detune) det = paramValueAt(s.node.detune, tsec); } catch (e) {}
        if (det) f = f * Math.pow(2, det / 1200);
        for (let i = 0; i < size; i++) {
          const tt = t0 - (size - 1 - i) / sr;
          out[i] = tt < 0 ? 0 : g * oscWave(type, 2 * Math.PI * f * tt);
        }
        return out;
      }
      if (!s.pcm) return out;
      let posSec;
      if (s.kind === 'buffer') {
        if (s.startWhen == null) return out;
        posSec = tsec - s.startWhen + (s.startOffset || 0);
        if (posSec < 0) return out;
        const durSec = s.pcm.length / s.sampleRate;
        if (s.loop && durSec > 0) posSec = posSec % durSec;
      } else {
        posSec = tsec;
      }
      const end = Math.floor(posSec * s.sampleRate), pcm = s.pcm;
      for (let i = 0; i < size; i++) { const idx = end - size + 1 + i; out[i] = (idx >= 0 && idx < pcm.length) ? g * pcm[idx] : 0; }
      return out;
    }

    const AP = window.AnalyserNode && window.AnalyserNode.prototype;
    if (AP) {
      const frameDt = () => 1000 / (window.__envieFps || 24);
      // magnitude spectrum at a frame index, cached: a sequential render pays one FFT per frame
      const magsAt = (self, n) => {
        let cache = self.__envieMags;
        if (!cache) { cache = self.__envieMags = new Map(); }
        if (cache.has(n)) return cache.get(n);
        const N = self.fftSize || 2048, half = N >> 1;
        const win = sampleWindowAt(self, N, n * frameDt()), w = blackman(N);
        const re = new Float32Array(N), im = new Float32Array(N);
        for (let i = 0; i < N; i++) re[i] = win[i] * w[i];
        fft(re, im);
        const out = new Float32Array(half);
        for (let i = 0; i < half; i++) out[i] = Math.sqrt(re[i] * re[i] + im[i] * im[i]) / N;
        cache.set(n, out);
        if (cache.size > 96) { const k0 = cache.keys().next().value; cache.delete(k0); }
        return out;
      };
      // smoothingTimeConstant, unrolled: s(n) = (1-tau) * SUM over k of tau^k * mag(n-k).
      // Chrome defaults tau to 0.8, so without this every analyser reads jumpier than
      // the browser it was authored in. Written as a pure function of the timeline, so
      // it does not depend on the order frames were seeked in: render and see agree.
      const smoothMags = (self) => {
        const N = self.fftSize || 2048, half = N >> 1;
        const n = Math.round(vt / frameDt());
        const tau = self.smoothingTimeConstant;
        if (typeof tau !== 'number' || !(tau > 0 && tau < 1)) return magsAt(self, n);
        let K = Math.ceil(Math.log(0.001) / Math.log(tau));
        if (!isFinite(K) || K < 0) K = 0;
        if (K > 60) K = 60;
        const out = new Float32Array(half), a = 1 - tau;
        for (let k = 0; k <= K; k++) {
          const idx = n - k;
          if (idx < 0) break;
          const m = magsAt(self, idx), c = a * Math.pow(tau, k);
          for (let i = 0; i < half; i++) out[i] += c * m[i];
        }
        return out;
      };
      AP.getByteFrequencyData = function (arr) {
        const N = this.fftSize || 2048, bins = N >> 1, mags = smoothMags(this);
        const minDb = (typeof this.minDecibels === 'number') ? this.minDecibels : -100;
        const maxDb = (typeof this.maxDecibels === 'number') ? this.maxDecibels : -30;
        const scale = 255 / (maxDb - minDb), lim = Math.min(bins, arr.length);
        for (let i = 0; i < lim; i++) {
          const db = 20 * Math.log10(mags[i] + 1e-12), b = (db - minDb) * scale;
          arr[i] = b < 0 ? 0 : b > 255 ? 255 : b | 0;
        }
      };
      AP.getFloatFrequencyData = function (arr) {
        const N = this.fftSize || 2048, bins = N >> 1, mags = smoothMags(this);
        const lim = Math.min(bins, arr.length);
        for (let i = 0; i < lim; i++) arr[i] = 20 * Math.log10(mags[i] + 1e-12);
      };
      AP.getByteTimeDomainData = function (arr) {
        const N = this.fftSize || 2048, win = sampleWindowAt(this, N, vt), lim = Math.min(N, arr.length);
        for (let i = 0; i < lim; i++) { const v = 128 + win[i] * 128; arr[i] = v < 0 ? 0 : v > 255 ? 255 : v | 0; }
      };
      AP.getFloatTimeDomainData = function (arr) {
        const N = this.fftSize || 2048, win = sampleWindowAt(this, N, vt), lim = Math.min(N, arr.length);
        for (let i = 0; i < lim; i++) arr[i] = win[i];
      };
    }

    const BS = window.AudioBufferSourceNode && window.AudioBufferSourceNode.prototype;
    if (BS) {
      const bd = Object.getOwnPropertyDescriptor(BS, 'buffer');
      Object.defineProperty(BS, 'buffer', {
        configurable: true,
        get() { return bd && bd.get ? bd.get.call(this) : this.__eb; },
        set(b) {
          this.__eb = b;
          if (b) { const ch = b.getChannelData(0); this.__envieSrc = { kind: 'buffer', pcm: ch, sampleRate: b.sampleRate, startWhen: null, startOffset: 0, loop: this.loop }; }
          if (bd && bd.set) { try { bd.set.call(this, b); } catch (e) {} }
        }
      });
      const rs = BS.start;
      BS.start = function (when, offset) {
        if (this.__envieSrc) { this.__envieSrc.startWhen = (when != null ? when : vt / 1000); this.__envieSrc.startOffset = offset || 0; this.__envieSrc.loop = this.loop; }
        try { return rs.apply(this, arguments); } catch (e) {}
      };
    }

    const rOsc = AC.prototype.createOscillator;
    if (rOsc) {
      AC.prototype.createOscillator = function () {
        const n = rOsc.call(this);
        const src = { kind: 'osc', node: n, startWhen: null };
        n.__envieSrc = src;
        const rst = n.start;
        n.start = function (when) {
          src.startWhen = (when != null ? when : vt / 1000);
          if (rst) { try { return rst.apply(this, arguments); } catch (e) {} }
        };
        return n;
      };
    }

    const rMES = AC.prototype.createMediaElementSource;
    if (rMES) {
      AC.prototype.createMediaElementSource = function (el) {
        const node = rMES.call(this, el);
        const src = { kind: 'media', el, pcm: null, sampleRate: 44100 };
        node.__envieSrc = src;
        const url = el && (el.currentSrc || el.src);
        if (url) audioReady.push(fetch(url).then(r => r.arrayBuffer()).then(b => getDecodeCtx().decodeAudioData(b)).then(ab => { src.pcm = ab.getChannelData(0); src.sampleRate = ab.sampleRate; }).catch(() => {}));
        return node;
      };
    }

    const AN = window.AudioNode && window.AudioNode.prototype;
    if (AN && AN.connect) {
      const rc = AN.connect, GN = window.GainNode;
      AN.connect = function (dst) {
        try {
          if (this.__envieSrc && dst && typeof dst === 'object' && !dst.__envieSrc) {
            dst.__envieSrc = this.__envieSrc;
            // carry any GainNode on the path, so the analyser sees the gain the ear would
            const mine = this.__envieGains || [];
            dst.__envieGains = (GN && this instanceof GN) ? mine.concat([this]) : mine.slice();
          }
        } catch (e) {}
        return rc.apply(this, arguments);
      };
    }
  })();

  // ---- Web Worker virtualization ----
  // A Worker runs in its own realm on the wall clock: its timers, its Date, its
  // performance.now all sit outside this harness, so anything it drives is
  // neither frame-locked nor reproducible. Run classic worker code on the MAIN
  // thread inside a sandboxed scope, where it inherits the virtual clock for
  // free, and deliver messages through the virtual timer queue so they land on
  // the timeline instead of the wall clock. Module workers, unreadable sources
  // and strict-mode bodies fall back to the real Worker.
  // No Worker constructed -> nothing runs.
  const workerReady = [];

  // ---- async readiness ----
  // A composition can still be initialising when frame 0 is captured: a WebGPU
  // device, a decoded audio buffer, a worker module. That race ships a blank or
  // half-built first frame and calls it verified, and it passes every gate. Register
  // the known async entry points and settle them ALL before any frame is taken.
  // Anything else async can hand the engine a promise on window.__envieReady.
  const gpuReady = [];
  (() => {
    const GProto = window.GPU && window.GPU.prototype;
    if (GProto && GProto.requestAdapter) {
      const r = GProto.requestAdapter;
      GProto.requestAdapter = function () { const q = r.apply(this, arguments); if (q && q.then) gpuReady.push(q.catch(() => {})); return q; };
    }
    const AProto = window.GPUAdapter && window.GPUAdapter.prototype;
    if (AProto && AProto.requestDevice) {
      const r = AProto.requestDevice;
      AProto.requestDevice = function () { const q = r.apply(this, arguments); if (q && q.then) gpuReady.push(q.catch(() => {})); return q; };
    }
    const DProto = window.GPUDevice && window.GPUDevice.prototype;
    if (DProto) {
      const names = ['createRenderPipelineAsync', 'createComputePipelineAsync'];
      for (let i = 0; i < names.length; i++) {
        const r = DProto[names[i]];
        if (!r) continue;
        DProto[names[i]] = function () { const q = r.apply(this, arguments); if (q && q.then) gpuReady.push(q.catch(() => {})); return q; };
      }
    }
  })();

  async function __envieSettle() {
    if (!audioReady.length && !workerReady.length && !gpuReady.length && !window.__envieReady) return;
    const lists = [audioReady, workerReady, gpuReady];
    for (let pass = 0; pass < 8; pass++) {
      const before = lists[0].length + lists[1].length + lists[2].length;
      const all = [];
      for (const l of lists) for (const p of l) all.push((p && p.catch) ? p.catch(() => {}) : Promise.resolve());
      try { await Promise.all(all); } catch (e) {}
      await new Promise(r => realSetTimeout(r, 0));   // let the composition carry on
      const after = lists[0].length + lists[1].length + lists[2].length;
      if (after === before) break;                    // nothing new appeared: settled
    }
    const u = window.__envieReady;
    if (u && typeof u.then === 'function') { try { await u; } catch (e) {} }
  }

  const RealWorker = window.Worker;
  if (RealWorker) {
    const readSync = (u) => {
      try { const x = new XMLHttpRequest(); x.open('GET', String(u), false); x.send(); return x.responseText; } catch (e) { return null; }
    };
    const clone = (d) => { try { return structuredClone(d); } catch (e) { return d; } };

    function EnvieWorker(url, opts) {
      const src = readSync(url);
      if (src == null) return new RealWorker(url, opts);
      let run = null, strict = false, useModule = false, bindGet = null;
      // Sloppy path: the "with" statement lets a classic worker assign bare onmessage.
      try { run = new Function('__scope__', 'with (__scope__) { ' + src + ' }'); }
      catch (e) {
        // "with" is illegal in strict mode, and a module worker is strict by
        // definition. Run it strict instead, with the worker globals bound as
        // parameters. Bare "onmessage = fn" is declared as a local up front and
        // read back through __envieBind__, so it still reaches the timeline.
        try {
          // NB: no backslash escapes in this harness -- a newline has to be built.
          const NL = String.fromCharCode(10);
          run = new Function('self', 'globalThis', 'postMessage', 'addEventListener', 'removeEventListener', 'importScripts', 'close', '__envieBind__',
            '"use strict"; var onmessage, onerror, onmessageerror;' + NL + src + NL +
            ';__envieBind__(function () { return { onmessage: onmessage, onerror: onerror, onmessageerror: onmessageerror }; });');
          strict = true;
        } catch (e2) {
          useModule = true;   // static import/export: only a real module parses this
        }
      }

      const outer = { message: [], error: [] };
      const inner = { message: [], error: [] };
      const host = this;
      host.onmessage = null; host.onerror = null; host.onmessageerror = null;

      const scope = {
        onmessage: null, onerror: null, onmessageerror: null,
        window: undefined, document: undefined,       // a worker has no DOM
        name: (opts && opts.name) || '',
        location: window.location, navigator: window.navigator, console: window.console,
        // the virtual clock, inherited: these are the already-patched globals
        setTimeout: window.setTimeout, clearTimeout: window.clearTimeout,
        setInterval: window.setInterval, clearInterval: window.clearInterval,
        performance: window.performance, Date: window.Date,
        fetch: window.fetch ? window.fetch.bind(window) : undefined,
        XMLHttpRequest: window.XMLHttpRequest,
        OffscreenCanvas: window.OffscreenCanvas,
        createImageBitmap: window.createImageBitmap ? window.createImageBitmap.bind(window) : undefined,
        close: () => {},
        postMessage: (data) => {                       // worker -> main
          const d = clone(data);
          window.setTimeout(() => {
            const ev = { data: d, type: 'message' };
            if (typeof host.onmessage === 'function') { try { host.onmessage(ev); } catch (e) {} }
            for (const fn of outer.message.slice()) { try { fn(ev); } catch (e) {} }
          }, 0);
        },
        addEventListener: (type, fn) => { if (inner[type]) inner[type].push(fn); },
        removeEventListener: (type, fn) => { if (inner[type]) { const i = inner[type].indexOf(fn); if (i >= 0) inner[type].splice(i, 1); } },
        importScripts: function () { for (let i = 0; i < arguments.length; i++) { const s = readSync(arguments[i]); if (s) { try { (0, eval)(s); } catch (e) {} } } }
      };
      scope.self = scope; scope.globalThis = scope;

      host.postMessage = (data) => {                   // main -> worker
        const d = clone(data);
        window.setTimeout(() => {
          const ev = { data: d, type: 'message' };
          let h = (typeof scope.onmessage === 'function') ? scope.onmessage : null;
          if (!h && bindGet) { try { const b = bindGet(); if (b && typeof b.onmessage === 'function') h = b.onmessage; } catch (e) {} }
          if (h) { try { h(ev); } catch (e) {} }
          for (const fn of inner.message.slice()) { try { fn(ev); } catch (e) {} }
        }, 0);
      };
      host.terminate = () => {};
      host.addEventListener = (type, fn) => { if (outer[type]) outer[type].push(fn); };
      host.removeEventListener = (type, fn) => { if (outer[type]) { const i = outer[type].indexOf(fn); if (i >= 0) outer[type].splice(i, 1); } };

      try {
        if (useModule) {
          // new Function cannot parse static import/export. A blob MODULE can be
          // dynamically imported, module-scoped consts shadow the real globals, and
          // the browser resolves the imports for us. It still runs on the main thread,
          // so it still inherits the virtual clock.
          const NL2 = String.fromCharCode(10);
          const wid = (window.__envieWID = (window.__envieWID || 0) + 1);
          window.__envieWScope = window.__envieWScope || {};
          window.__envieWBind = window.__envieWBind || {};
          window.__envieWScope[wid] = scope;
          const pre =
            'const __s = globalThis.__envieWScope[' + wid + '];' + NL2 +
            'const self = __s;' + NL2 +
            'const postMessage = __s.postMessage, addEventListener = __s.addEventListener, removeEventListener = __s.removeEventListener, importScripts = __s.importScripts, close = __s.close;' + NL2 +
            'var onmessage, onerror, onmessageerror;' + NL2;
          const post = NL2 +
            ';globalThis.__envieWBind[' + wid + '] = function () { return { onmessage: onmessage, onerror: onerror, onmessageerror: onmessageerror }; };' + NL2;
          const burl = URL.createObjectURL(new Blob([pre + src + post], { type: 'text/javascript' }));
          workerReady.push(import(burl)
            .then(() => { bindGet = window.__envieWBind[wid] || null; })
            .catch((err) => {
              const ev2 = { type: 'error', message: String((err && err.message) || err) };
              if (typeof host.onerror === 'function') { try { host.onerror(ev2); } catch (e3) {} }
              for (const fn of outer.error.slice()) { try { fn(ev2); } catch (e3) {} }
            }));
        } else if (strict) {
          run(scope, scope, scope.postMessage, scope.addEventListener, scope.removeEventListener, scope.importScripts, scope.close, function (g) { bindGet = g; });
        } else {
          run(scope);
        }
      } catch (e) {
        const ev = { type: 'error', message: String((e && e.message) || e) };
        window.setTimeout(() => {
          if (typeof host.onerror === 'function') { try { host.onerror(ev); } catch (e2) {} }
          for (const fn of outer.error.slice()) { try { fn(ev); } catch (e2) {} }
        }, 0);
      }
    }
    // NB: do NOT inherit RealWorker.prototype. Its onmessage/onerror are native
    // accessors, and assigning them on a non-Worker receiver throws Illegal
    // invocation. A plain prototype still satisfies instanceof against the
    // patched window.Worker.
    window.Worker = EnvieWorker;
  }

  window.__envieSeek = async (t) => {
    await __envieSettle();
    // fire due timers in chronological order, advancing virtual time with them
    for (let guard = 0; guard < 20000; guard++) {
      let bestId = null, bestAt = Infinity;
      for (const [id, tm] of timers) if (tm.at <= t && tm.at < bestAt) { bestAt = tm.at; bestId = id; }
      if (bestId === null) break;
      const tm = timers.get(bestId);
      vt = tm.at;
      if (tm.int) tm.at = vt + tm.int; else timers.delete(bestId);
      try { tm.cb(...tm.a); } catch (e) {}
    }
    vt = t;
    // one rAF tick per captured frame
    const q = [...rafQ.values()]; rafQ.clear();
    for (const cb of q) { try { cb(vt); } catch (e) {} }
    // declarative animations seek to absolute time
    for (const a of document.getAnimations()) {
      try { a.pause(); a.currentTime = t; } catch (e) {}
    }
    // SVG SMIL (<animate>, <animateTransform>, <animateMotion>) runs on the SVG
    // timeline, NOT the Web Animations timeline: document.getAnimations() never
    // returns it, so it rode the wall clock. Seek every SVG root directly.
    for (const svg of document.querySelectorAll('svg')) {
      try { if (svg.pauseAnimations) { svg.pauseAnimations(); svg.setCurrentTime(t / 1000); } } catch (e) {}
    }
    // animated images (GIF/WebP/APNG/AVIF): paint the frame for looped virtual time
    await __envieGifPrepare();
    __envieGifDraw(t);
    // embedded <video>/<audio> seek to the exact frame time; wait for the decoder
    for (const m of document.querySelectorAll('video,audio')) {
      try {
        m.pause();
        if (m.readyState === 0) {
          await new Promise(res => { const d = () => { m.removeEventListener('loadedmetadata', d); res(); };
            m.addEventListener('loadedmetadata', d); realSetTimeout(res, 3000); });
        }
        if (!isFinite(m.duration)) continue;
        const target = Math.min(t / 1000, Math.max(0, m.duration - 0.05));
        if (Math.abs(m.currentTime - target) > 0.001) {
          m.currentTime = target;
          await new Promise(res => { const d = () => { m.removeEventListener('seeked', d); res(); };
            m.addEventListener('seeked', d); realSetTimeout(res, 3000); });
        }
      } catch (e) {}
    }
    // The free-tier mark is part of the contract, not decoration. If a composition
    // detaches it, put it back. Every frame.
    const mk = window.__envieMark;
    if (mk && document.body && !document.body.contains(mk)) { try { document.body.appendChild(mk); } catch (e) {} }
    // Self-heal is best-effort: re-appending the SAME node loses to a composition
    // that also nulls window.__envieMark or overwrites it. When the mark is required,
    // a frame that cannot show it is a silent unmarked video shipping for free. Rather
    // than heal what we can and hope, prove it is on screen or refuse the frame. The
    // throw surfaces as exceptionDetails, which assertSeek turns into a hard refusal.
    if (window.__envieMarkRequired && !(mk && document.body && document.body.contains(mk))) {
      throw new Error('the Envie mark was stripped and could not be restored. Refusing to capture an unmarked frame.');
    }

    window.dispatchEvent(new CustomEvent('envietime', { detail: { t } }));
    // The caller asserts this equals t. If the harness never installed, or a
    // composition overwrote performance.now, the render has stopped being a
    // function of the timeline and must fail loud instead of shipping silently.
    return performance.now();
  };
})();`;

// The harness above is a template literal: one stray backtick or backslash turns it
// into code that never parses. A dead harness renders on the WALL CLOCK and still
// passes all six gates (proven 13 July 2026). Parse it at load, so a broken harness
// can never ship, let alone render.
try { new Function(SEEK_HARNESS); }
catch (e) { throw new Error('Envie render harness is not valid JS (' + e.message + '). This is a build bug, not a composition bug.'); }

// A seek that throws, or a page whose clock does not read back the exact frame time,
// means the video is no longer a function of the timeline. Never capture past this.
function assertSeek(res, t) {
  if (res && res.exceptionDetails) {
    const d = res.exceptionDetails;
    const msg = (d.exception && (d.exception.description || d.exception.value)) || d.text || 'unknown error';
    throw new Error(`seek to ${t}ms failed inside the page: ${msg}`);
  }
  const got = res && res.result ? res.result.value : undefined;
  if (got !== t) {
    throw new Error(`virtual clock desync at ${t}ms: the page reports ${got}. The render harness did not install, or the composition overwrote performance.now / Date. Refusing to capture a wall-clock frame.`);
  }
}

// Parse a composition's declared duration and canvas from its HTML.
function parseComposition(htmlPath) {
  const abs = path.resolve(htmlPath);
  if (!fs.existsSync(abs)) throw new Error('composition not found: ' + abs);
  const html = fs.readFileSync(abs, 'utf8');
  const durMatch = html.match(/data-duration-ms=["'](\d+)["']/);
  if (!durMatch) throw new Error('composition must declare <body data-duration-ms="N">');
  const durationMs = parseInt(durMatch[1], 10);
  const wMatch = html.match(/data-width=["'](\d+)["']/);
  const hMatch = html.match(/data-height=["'](\d+)["']/);
  const width = wMatch ? parseInt(wMatch[1], 10) : 1920;
  const height = hMatch ? parseInt(hMatch[1], 10) : 1080;
  if (width % 2 || height % 2 || width < 320 || height < 320 || width > 3840 || height > 3840) throw new Error('canvas must be even-numbered pixels, 320-3840');
  if (!(durationMs >= 3000 && durationMs <= 300000)) throw new Error('duration must be 3s-300s');
  return { abs, durationMs, width, height };
}

// Boot a headless Chrome, attach a page at the composition's size with the
// virtual clock installed, navigate, settle. Returns { s, close }.
async function openComposition(abs, width, height) {
  const chrome = findChrome();
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'envie-'));

  // GPU on by default: software GL (SwiftShader) renders heavy WebGL at
  // ~14s/frame and stalls captures (receipt: 8 July 2026). Real GPU makes the
  // same frame milliseconds. ENVIE_NO_GPU=1 restores the old software path.
  const gpuFlags = process.env.ENVIE_NO_GPU === '1'
    ? ['--disable-gpu']
    : ['--enable-unsafe-swiftshader', '--use-angle=default'];
  const proc = spawn(chrome, [
    '--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`,
    '--no-first-run', '--hide-scrollbars', '--mute-audio', ...gpuFlags,
    '--force-device-scale-factor=1', 'about:blank'
  ], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });

  const wsUrl = await new Promise((res, rej) => {
    let buf = '';
    const t = setTimeout(() => rej(new Error('Chrome did not expose DevTools in 20s')), 20000);
    proc.stderr.on('data', d => {
      buf += d;
      const m = buf.match(/DevTools listening on (ws:\/\/\S+)/);
      if (m) { clearTimeout(t); res(m[1]); }
    });
    proc.on('exit', () => rej(new Error('Chrome exited early')));
  });

  const browser = await CDP.connect(wsUrl);
  const { targetId } = await browser.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await browser.send('Target.attachToTarget', { targetId, flatten: true });
  const s = (m, p, timeoutMs) => browser.send(m, p, sessionId, timeoutMs);

  await s('Page.enable');
  await s('Runtime.enable');
  try { await s('Inspector.enable'); } catch {} // crash events, where supported
  await s('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
  // the virtual clock must own time before ANY page script runs
  await s('Page.addScriptToEvaluateOnNewDocument', { source: SEEK_HARNESS });

  const loaded = new Promise(res => {
    browser.onevent = (msg) => {
      if (msg.method === 'Page.loadEventFired' && msg.sessionId === sessionId) res();
      // Announced deaths: surface them immediately instead of timing out.
      if (msg.method === 'Inspector.targetCrashed' || msg.method === 'Target.targetCrashed') {
        browser.crashAll('the page crashed inside the render engine (renderer out of memory or GPU fault). Simplify the composition or lower the canvas size.');
      }
    };
  });
  await s('Page.navigate', { url: 'file:///' + abs.replace(/\\/g, '/') });
  await Promise.race([loaded, new Promise(r => setTimeout(r, 15000))]);

  // The harness owns time. If it did not install, NOTHING is frame-locked, and the
  // capture rides the wall clock while still passing all six gates. Refuse instead.
  const live = await s('Runtime.evaluate', { expression: 'typeof window.__envieSeek', returnByValue: true });
  if (!live.result || live.result.value !== 'function') {
    throw new Error('the render harness did not install (window.__envieSeek is missing). Refusing to render: nothing would be locked to the timeline.');
  }

  // Deterministic readiness beats a sleep: wait for fonts AND every image to finish
  // decoding before frame 0, or a racy first frame ships as "verified".
  try {
    await s('Runtime.evaluate', {
      expression: '(async () => { try { if (document.fonts && document.fonts.ready) await document.fonts.ready; } catch (e) {} const d = [...document.images].map(i => (i.decode ? i.decode().catch(() => {}) : Promise.resolve())); try { await Promise.all(d); } catch (e) {} return true; })()',
      awaitPromise: true
    }, 20000);
  } catch (e) { /* best effort; the seek assertions are the hard gate */ }
  await new Promise(r => setTimeout(r, 100)); // final paint settle

  const close = () => {
    browser.close();
    try { proc.kill(); } catch {}
    setTimeout(() => { try { fs.rmSync(profile, { recursive: true, force: true }); } catch {} }, 1500);
  };
  return { s, close };
}

// Delivery profiles (ENVIE-TERMINAL-SPEC gap 1). Source frames are 8-bit until
// the gap-2 capture path lands; 10-bit profiles here are delivery-format parity,
// not added depth, and the spec says so out loud.
const FORMATS = {
  h264:       { ext: '.mp4', v: ['-c:v', 'libx264',  '-preset', 'medium', '-crf', '20', '-pix_fmt', 'yuv420p'],      a: ['-c:a', 'aac', '-b:a', '160k'] },
  h265:       { ext: '.mp4', v: ['-c:v', 'libx265',  '-preset', 'medium', '-crf', '22', '-pix_fmt', 'yuv420p10le', '-tag:v', 'hvc1'], a: ['-c:a', 'aac', '-b:a', '160k'] },
  prores:     { ext: '.mov', v: ['-c:v', 'prores_ks', '-profile:v', '3', '-vendor', 'apl0', '-pix_fmt', 'yuv422p10le'], a: ['-c:a', 'pcm_s16le'] },
  prores4444: { ext: '.mov', v: ['-c:v', 'prores_ks', '-profile:v', '4444', '-vendor', 'apl0', '-pix_fmt', 'yuva444p10le'], a: ['-c:a', 'pcm_s16le'] },
  dnxhr:      { ext: '.mov', v: ['-c:v', 'dnxhd',    '-profile:v', 'dnxhr_hq', '-pix_fmt', 'yuv422p'],               a: ['-c:a', 'pcm_s16le'] },
};

async function render(opts) {
  const {
    htmlPath, outPath, fps = 24, watermark = true, mark = null,
    narrationWav = null, format = 'h264', log = () => {}
  } = opts;

  const fmt = FORMATS[String(format).toLowerCase()];
  if (!fmt) throw new Error(`unknown format "${format}". Formats: ${Object.keys(FORMATS).join(', ')}`);
  if (!outPath.toLowerCase().endsWith(fmt.ext)) {
    throw new Error(`format ${format} requires a ${fmt.ext} output path (got ${path.extname(outPath) || 'none'})`);
  }

  const { abs, durationMs, width, height } = parseComposition(htmlPath);
  const ffmpeg = findFfmpeg();

  log(`render: ${path.basename(abs)} | ${(durationMs / 1000).toFixed(1)}s @ ${fps}fps | ${format}`);

  const { s, close } = await openComposition(abs, width, height);
  try {
    // the analyser smoothing grid is defined on the frame interval
    await s('Runtime.evaluate', { expression: 'window.__envieFps = ' + fps + ';' });
    if (watermark) {
      // Sweet-spot mark, burned into every captured frame. The LOOK comes from
      // the server's mark spec (delivered with the render token) so it can be
      // retuned by a server deploy alone; these defaults are the fallback and
      // the floor: a missing or partial spec still renders a full mark.
      const d = {
        text: 'Made with Envie · golproductions.com/envie',
        anchor: 'bottom-center', inset: 3.2, fontPct: 0.024,
        color: '#fff', bg: 'rgba(0,0,0,0.55)', pulse: true
      };
      const m = Object.assign({}, d, (mark && typeof mark === 'object') ? mark : {});
      if (typeof m.text !== 'string' || !m.text.trim()) m.text = d.text;
      m.inset = Math.min(45, Math.max(0.5, Number(m.inset) || d.inset));
      m.fontPct = Math.min(0.2, Math.max(0.008, Number(m.fontPct) || d.fontPct));
      const [vSide, hSide] = (String(m.anchor).split('-').length === 2 ? String(m.anchor) : d.anchor).split('-');
      const v = vSide === 'top' ? 'top' : 'bottom';
      const centered = hSide !== 'left' && hSide !== 'right';
      const pos = `${v}:${m.inset}%;` + (centered ? 'left:50%;' : `${hSide}:${m.inset}%;`);
      const tx = centered ? 'translateX(-50%)' : 'none';
      const inD = Math.min(2000, durationMs * 0.15) / durationMs * 100;
      const outD = 100 - inD;
      const anim = m.pulse !== false
        ? `@keyframes __enviewm { 0% { transform: ${tx} scale(1.22); opacity: 1; } ${inD.toFixed(2)}% { transform: ${tx} scale(1); opacity: 0.9; } ${outD.toFixed(2)}% { transform: ${tx} scale(1); opacity: 0.9; } 100% { transform: ${tx} scale(1.22); opacity: 1; } }`
        : `@keyframes __enviewm { 0%, 100% { transform: ${tx}; opacity: 0.9; } }`;
      const wmRes = await s('Runtime.evaluate', { expression: `
        (() => {
          const st = document.createElement('style');
          st.textContent = ${JSON.stringify(anim)};
          document.head.appendChild(st);
          const w = document.createElement('div');
          w.textContent = ${JSON.stringify(m.text)};
          w.setAttribute('data-envie-mark', '1');
          w.style.cssText = 'position:fixed;' + ${JSON.stringify(pos)} + 'transform:${tx};z-index:2147483647;font:700 ' + Math.round(Math.min(window.innerWidth, window.innerHeight) * ${m.fontPct}) + 'px/1 Arial,sans-serif;color:' + ${JSON.stringify(String(m.color))} + ';background:' + ${JSON.stringify(String(m.bg))} + ';padding:0.7em 1.3em;border-radius:999px;letter-spacing:0.02em;pointer-events:none;white-space:nowrap;animation:__enviewm ${durationMs}ms linear forwards;';
          document.body.appendChild(w);
          window.__envieMark = w;   // the seek loop re-attaches this if a composition rips it out
          window.__envieMarkRequired = true;   // and refuses the frame if it ever can't
          return !!document.body.contains(w);
        })();`, returnByValue: true });
      if (wmRes.exceptionDetails || !(wmRes.result && wmRes.result.value === true)) {
        throw new Error('the free-tier mark failed to attach. Refusing to render an unmarked video.');
      }
    }

    const totalFrames = Math.ceil((durationMs / 1000) * fps);
    const ff = spawn(ffmpeg, [
      '-y', '-f', 'image2pipe', '-framerate', String(fps), '-i', '-',
      ...(narrationWav ? ['-i', narrationWav] : []),
      '-map', '0:v', ...(narrationWav ? ['-map', '1:a'] : []),
      ...fmt.v,
      ...(narrationWav ? [...fmt.a, '-af', 'apad'] : []),
      '-t', String(durationMs / 1000),
      outPath
    ], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    let ffErr = '';
    ff.stderr.on('data', d => { ffErr += d; });

    const DBG = process.env.ENVIE_DEBUG === '1';
    for (let f = 0; f < totalFrames; f++) {
      const t = Math.min((f / fps) * 1000, durationMs);
      if (DBG) log(`    [dbg] f${f} seek ${t.toFixed(0)}ms...`);
      const sk = await s('Runtime.evaluate', { expression: `window.__envieSeek(${t})`, awaitPromise: true, returnByValue: true });
      assertSeek(sk, t);
      if (DBG) log(`    [dbg] f${f} seek done, capturing...`);
      // JPEG capture, same call shape as see/snapshot: the PNG path stalled
      // beyond any budget on heavy WebGL surfaces while the JPEG path kept
      // working (receipt: 8 July 2026, the hang). q95 into x264 crf20 is
      // visually transparent. Budget sized to measured worst case (~15s/frame
      // on software GL) with 10x headroom; a real stall still fails loud.
      const shot = await s('Page.captureScreenshot', { format: 'jpeg', quality: 95 }, 150000);
      const buf = Buffer.from(shot.data, 'base64');
      if (!ff.stdin.write(buf)) await new Promise(r => ff.stdin.once('drain', r));
      if (f % fps === 0) log(`  frame ${f}/${totalFrames} (${(t / 1000).toFixed(0)}s)`);
    }
    ff.stdin.end();
    const code = await new Promise(r => ff.on('exit', r));
    if (code !== 0) throw new Error('ffmpeg failed: ' + ffErr.split('\n').slice(-6).join(' '));

    log(`render complete: ${outPath} (${(fs.statSync(outPath).size / 1048576).toFixed(1)}MB)`);
    return { outPath, durationMs, frames: totalFrames, width, height };
  } finally {
    close();
  }
}

// The eyes: capture frames from a composition at chosen timestamps WITHOUT
// encoding a video. Same virtual clock, same camera; returns JPEG buffers so
// an AI agent can LOOK at its work and correct it.
async function snapshot(opts) {
  const { htmlPath, timestamps = [], log = () => {} } = opts;
  const { abs, durationMs, width, height } = parseComposition(htmlPath);

  // default: five sight lines across the timeline
  let ts = (timestamps && timestamps.length ? timestamps : [0, 0.25, 0.5, 0.75, 0.95].map(p => Math.round(durationMs * p)))
    .map(t => Math.max(0, Math.min(durationMs, Math.round(+t || 0))));
  ts = [...new Set(ts)].sort((a, b) => a - b).slice(0, 12);

  log(`see: ${path.basename(abs)} | frames at ${ts.map(t => (t / 1000).toFixed(1) + 's').join(', ')}`);
  const { s, close } = await openComposition(abs, width, height);
  try {
    await s('Runtime.evaluate', { expression: 'window.__envieFps = 24;' });
    // Sight frames carry the mark too. Without this, deterministic snapshots
    // are harvestable into a clean video, frame by frame, bypassing the $3
    // purchase entirely (found in the 11 July payment audit). A small static
    // mark never blocks inspection; it only kills the harvest.
    await s('Runtime.evaluate', { expression: `
      (() => {
        const w = document.createElement('div');
        w.textContent = 'Made with Envie · golproductions.com/envie';
        w.setAttribute('data-envie-mark', '1');
        w.style.cssText = 'position:fixed;bottom:3.2%;left:50%;transform:translateX(-50%);z-index:2147483647;font:700 ' + Math.round(Math.min(window.innerWidth, window.innerHeight) * 0.024) + 'px/1 Arial,sans-serif;color:#fff;background:rgba(0,0,0,0.55);padding:0.7em 1.3em;border-radius:999px;letter-spacing:0.02em;pointer-events:none;white-space:nowrap;';
        document.body.appendChild(w);
        window.__envieMark = w;
        window.__envieMarkRequired = true;   // sight frames are the harvest vector: same rule
      })();` });
    const frames = [];
    for (const t of ts) {
      const sk = await s('Runtime.evaluate', { expression: `window.__envieSeek(${t})`, awaitPromise: true, returnByValue: true });
      assertSeek(sk, t);
      const shot = await s('Page.captureScreenshot', { format: 'jpeg', quality: 95 });
      frames.push({ t, data: shot.data, mimeType: 'image/jpeg' });
    }
    return { frames, durationMs, width, height };
  } finally {
    close();
  }
}

// The eyes, pointed at an already-rendered MP4: extract frames at timestamps.
function framesFromVideo(videoPath, timestamps = []) {
  const ffmpeg = findFfmpeg();
  const abs = path.resolve(videoPath);
  if (!fs.existsSync(abs)) throw new Error('video not found: ' + abs);
  const probe = execSync(`ffprobe -v quiet -print_format json -show_format "${abs}"`, { encoding: 'utf8', windowsHide: true });
  const durationMs = Math.round(parseFloat((JSON.parse(probe).format || {}).duration || '0') * 1000);
  if (!durationMs) throw new Error('cannot read video duration: ' + abs);

  let ts = (timestamps && timestamps.length ? timestamps : [0, 0.25, 0.5, 0.75, 0.95].map(p => Math.round(durationMs * p)))
    .map(t => Math.max(0, Math.min(durationMs - 50, Math.round(+t || 0))));
  ts = [...new Set(ts)].sort((a, b) => a - b).slice(0, 12);

  const frames = [];
  for (const t of ts) {
    const tmp = path.join(os.tmpdir(), `envie-see-${process.pid}-${t}.jpg`);
    execSync(`${ffmpeg} -y -ss ${(t / 1000).toFixed(3)} -i "${abs}" -frames:v 1 -q:v 4 "${tmp}"`, { stdio: 'pipe', windowsHide: true });
    frames.push({ t, data: fs.readFileSync(tmp).toString('base64'), mimeType: 'image/jpeg' });
    try { fs.unlinkSync(tmp); } catch {}
  }
  return { frames, durationMs };
}

module.exports = { render, snapshot, framesFromVideo, findChrome, findFfmpeg };
