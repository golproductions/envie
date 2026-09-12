#!/usr/bin/env node
// Envie. Copyright (c) 2026 GOL Productions (https://golproductions.com). See LICENSE.
// Translation engine: read a rendered video back in full, in a language
// an AI actually consumes. Not sampling (5 stills), not catastrophe gates
// (not-black, not-silent). This walks EVERY frame and the WHOLE audio track and
// turns the file into numbers + images:
//
//   MOTION   per-frame luma + frame-to-frame difference (YDIF). Motion is the
//            delta between frames, so with every frame measured, every fact of
//            the motion is present: what held still, where it cut, how hard.
//   SOUND    integrated loudness (LUFS, EBU R128), true peak, per-window RMS
//            envelope, plus a spectrogram image of the entire track.
//   SYNC     audio transients vs picture cuts, as a millisecond offset. "Does
//            the boom land on the frame that changes" stops being a feeling.
//
// The seam kept honest, out loud: this does not HEAR and does not experience
// motion as motion. It translates every fact of both into a number or an image
// the reader fully consumes. The aesthetic verdict stays the human's. The tool
// never claims to watch. It translates, and shows the receipt of the translation.
//
// Usage: node translate.cjs <video> [--json] [--fps-meta] [--out DIR]
// Zero npm deps: ffmpeg + ffprobe (already required by the engine).

const { spawnSync, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

function findBin(name) {
  try { execSync(`${name} -version`, { stdio: 'pipe', windowsHide: true }); return name; }
  catch { throw new Error(`${name} not found on PATH. Install ffmpeg (ships ffmpeg + ffprobe).`); }
}

// Run ffmpeg and return its stderr log. ffmpeg writes filter/metadata prints and
// the ebur128 summary to stderr; we run it in a scratch cwd so metadata files
// written with a BARE filename (no drive-letter colon, no backslash) never
// collide with lavfi's escaping rules on Windows.
function ffLog(ffmpeg, args, cwd) {
  const r = spawnSync(ffmpeg, args, { cwd, encoding: 'utf8', windowsHide: true, maxBuffer: 256 * 1024 * 1024 });
  return (r.stdout || '') + (r.stderr || '');
}

// Parse ffmpeg's metadata=print output. Lines are:
//   frame:12   pts:... pts_time:0.5
//   lavfi.signalstats.YDIF=3.21
//   lavfi.scd.score=0.004
// -> [{ t, tags:{...} }] one entry per frame.
function parseMeta(text) {
  const out = [];
  let cur = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    const fm = line.match(/^frame:\d+.*?pts_time:([-\d.]+)/);
    if (fm) { cur = { t: parseFloat(fm[1]), tags: {} }; out.push(cur); continue; }
    const kv = line.match(/^lavfi\.([^=]+)=(-?[\d.eE+-]+)/);
    if (kv && cur) cur.tags[kv[1]] = parseFloat(kv[2]);
  }
  return out;
}

function probeContainer(ffprobe, file) {
  const raw = execSync(`${ffprobe} -v quiet -print_format json -show_format -show_streams "${file}"`,
    { encoding: 'utf8', windowsHide: true, maxBuffer: 32 * 1024 * 1024 });
  const p = JSON.parse(raw);
  const fmt = p.format || {};
  const v = (p.streams || []).find(s => s.codec_type === 'video') || null;
  const a = (p.streams || []).find(s => s.codec_type === 'audio') || null;
  const fps = v && v.avg_frame_rate && v.avg_frame_rate !== '0/0'
    ? (n => n[1] ? +n[0] / +n[1] : 0)(v.avg_frame_rate.split('/')) : 0;
  return {
    file, sizeMB: +(fs.statSync(file).size / 1048576).toFixed(1),
    durationSec: +parseFloat(fmt.duration || '0').toFixed(3),
    video: v ? { codec: v.codec_name, w: v.width, h: v.height, fps: +fps.toFixed(3), pixfmt: v.pix_fmt,
      frames: v.nb_frames ? +v.nb_frames : null } : null,
    audio: a ? { codec: a.codec_name, sampleRate: +a.sample_rate, channels: a.channels } : null,
  };
}

// MOTION: one decode pass, signalstats (YAVG luma, YDIF frame-diff) + scdet (cut
// score) printed per frame. YDIF is the average absolute luma change from the
// previous frame: the motion magnitude, built in, no approximation.
function motionSeries(ffmpeg, file, work) {
  const metaFile = `envie_motion_${process.pid}.txt`;
  ffLog(ffmpeg, ['-hide_banner', '-i', file, '-an',
    '-vf', `signalstats,scdet=threshold=0,metadata=mode=print:file=${metaFile}`,
    '-f', 'null', '-'], work);
  const full = path.join(work, metaFile);
  const text = fs.existsSync(full) ? fs.readFileSync(full, 'utf8') : '';
  try { fs.unlinkSync(full); } catch {}
  return parseMeta(text).map(f => ({
    t: f.t,
    yavg: f.tags['signalstats.YAVG'] ?? null,   // 0-255 average brightness
    ydif: f.tags['signalstats.YDIF'] ?? 0,       // motion: frame-to-frame luma delta
    scd: f.tags['scd.score'] ?? 0,               // scene-cut score 0-100
  }));
}

// SOUND envelope: reframe audio into fixed time windows, one RMS per window.
function audioSeries(ffmpeg, file, work, windowsPerSec, sampleRate) {
  const n = Math.max(1, Math.round(sampleRate / windowsPerSec));
  const metaFile = `envie_audio_${process.pid}.txt`;
  ffLog(ffmpeg, ['-hide_banner', '-i', file, '-map', '0:a:0',
    '-af', `asetnsamples=n=${n}:p=0,astats=metadata=1:reset=1,ametadata=mode=print:file=${metaFile}`,
    '-f', 'null', '-'], work);
  const full = path.join(work, metaFile);
  const text = fs.existsSync(full) ? fs.readFileSync(full, 'utf8') : '';
  try { fs.unlinkSync(full); } catch {}
  return parseMeta(text).map(f => ({
    t: f.t,
    rms: f.tags['astats.Overall.RMS_level'] ?? -99,   // dBFS, per window
  })).filter(w => Number.isFinite(w.rms));
}

// SOUND loudness: EBU R128 integrated loudness, range, and true peak. The
// broadcast standard, not a homemade average.
function loudness(ffmpeg, file, work) {
  const log = ffLog(ffmpeg, ['-hide_banner', '-i', file, '-map', '0:a:0',
    '-af', 'ebur128=peak=true', '-f', 'null', '-'], work);
  // ebur128 prints a running line every 100ms (I: sits at the -70 LUFS floor
  // until it accumulates) and then a final "Summary:" block with the real
  // numbers. Parse ONLY the summary tail, or you report the uninitialized floor
  // as the loudness (caught 11 July: a full -14 LUFS master read as -70).
  const sIdx = log.lastIndexOf('Summary:');
  const tail = sIdx >= 0 ? log.slice(sIdx) : log;
  const grab = re => { const m = tail.match(re); return m ? parseFloat(m[1]) : null; };
  return {
    integratedLUFS: grab(/I:\s*(-?[\d.]+)\s*LUFS/),
    rangeLU: grab(/LRA:\s*(-?[\d.]+)\s*LU/),
    truePeakDb: grab(/Peak:\s*(-?[\d.]+)\s*dBFS/),
  };
}

// Assets: whole-track spectrogram + waveform images (I look at these directly),
// and lossless PNG keyframes at the moments the data says matter.
function writeAssets(ffmpeg, file, outDir, keyTimes) {
  fs.mkdirSync(outDir, { recursive: true });
  // Clear last run's keyframes first. A cut list changes between runs, so stale
  // kf-*.png from a prior render would linger beside the fresh ones and lie
  // about what this translation actually saw (caught 11 July, first self-test).
  for (const f of fs.readdirSync(outDir)) if (/^kf-.*\.png$/.test(f)) { try { fs.unlinkSync(path.join(outDir, f)); } catch {} }
  const spec = path.join(outDir, 'spectrogram.png');
  const wave = path.join(outDir, 'waveform.png');
  ffLog(ffmpeg, ['-y', '-hide_banner', '-i', file,
    '-lavfi', 'showspectrumpic=s=1400x600:legend=1:gain=3', spec], outDir);
  ffLog(ffmpeg, ['-y', '-hide_banner', '-i', file,
    '-filter_complex', 'showwavespic=s=1400x400:split_channels=1', wave], outDir);
  const keyframes = [];
  keyTimes.forEach((t, i) => {
    const kf = path.join(outDir, `kf-${String(i).padStart(2, '0')}-${Math.round(t * 1000)}ms.png`);
    // -ss before -i = fast seek; PNG = lossless, true pixels (never JPEG here).
    ffLog(ffmpeg, ['-y', '-hide_banner', '-ss', t.toFixed(3), '-i', file,
      '-frames:v', '1', kf], outDir);
    if (fs.existsSync(kf)) keyframes.push({ t, file: kf });
  });
  return { spectrogram: fs.existsSync(spec) ? spec : null, waveform: fs.existsSync(wave) ? wave : null, keyframes };
}

// Derive the human-legible facts from the raw series.
function derive(motion, audio, duration) {
  const ydif = motion.map(f => f.ydif);
  const mMean = ydif.reduce((a, b) => a + b, 0) / (ydif.length || 1);
  const mSd = Math.sqrt(ydif.reduce((a, b) => a + (b - mMean) ** 2, 0) / (ydif.length || 1));

  // Cuts: hard scene-detect score spikes first.
  const hardCuts = [];
  for (const f of motion) {
    if (f.scd >= 8 || f.ydif > mMean + 4 * mSd) {
      if (!hardCuts.length || f.t - hardCuts[hardCuts.length - 1] > 0.3) hardCuts.push(+f.t.toFixed(3));
    }
  }

  // G-B: opacity-crossfade boundary detection. The GUIDE recommends opacity keyframes as
  // the scene pattern, which produce no YDIF spike -- only sustained moderate motion.
  // Detect runs of >= fadeMinFrames frames above fadeThresh where no frame is a hard cut.
  // The midpoint of each run is the scene boundary.
  const fps = motion.length > 1 ? Math.round(1 / (motion[1].t - motion[0].t)) : 24;
  const fadeCuts = [];
  const fadeThresh = Math.max(0.05, mMean * 1.2);
  const fadeMinFrames = Math.max(3, Math.round(fps * 0.15));
  let fadeRun = [];
  for (let i = 0; i < motion.length; i++) {
    const f = motion[i];
    const isHard = f.scd >= 8 || f.ydif > mMean + 4 * mSd;
    if (!isHard && f.ydif > fadeThresh) {
      fadeRun.push(f);
    } else {
      if (fadeRun.length >= fadeMinFrames) {
        const mid = fadeRun[Math.floor(fadeRun.length / 2)];
        const t = +mid.t.toFixed(3);
        if (!fadeCuts.length || t - fadeCuts[fadeCuts.length - 1] > 0.5) fadeCuts.push(t);
      }
      fadeRun = [];
    }
  }
  if (fadeRun.length >= fadeMinFrames) {
    const mid = fadeRun[Math.floor(fadeRun.length / 2)];
    fadeCuts.push(+mid.t.toFixed(3));
  }

  // Merge hard cuts and fade midpoints, deduplicated within 0.3s.
  const allCuts = [...hardCuts, ...fadeCuts].sort(function(a, b) { return a - b; });
  const cuts = [];
  for (const t of allCuts) {
    if (!cuts.length || t - cuts[cuts.length - 1] > 0.3) cuts.push(t);
  }

  // Still holds: contiguous runs with almost no frame-to-frame change.
  const holds = [];
  let run = null;
  const eps = Math.max(0.15, mMean * 0.25);
  for (const f of motion) {
    if (f.ydif <= eps) { if (!run) run = { start: f.t, end: f.t }; else run.end = f.t; }
    else if (run) { if (run.end - run.start >= 1.0) holds.push({ start: +run.start.toFixed(2), end: +run.end.toFixed(2), dur: +(run.end - run.start).toFixed(2) }); run = null; }
  }
  if (run && run.end - run.start >= 1.0) holds.push({ start: +run.start.toFixed(2), end: +run.end.toFixed(2), dur: +(run.end - run.start).toFixed(2) });

  // Motion peaks: local YDIF maxima well above the mean (for sync targets).
  const peaks = [];
  for (let i = 1; i < motion.length - 1; i++) {
    const f = motion[i];
    if (f.ydif > mMean + 2 * mSd && f.ydif >= motion[i - 1].ydif && f.ydif >= motion[i + 1].ydif) {
      if (!peaks.length || f.t - peaks[peaks.length - 1].t > 0.25) peaks.push({ t: +f.t.toFixed(3), ydif: +f.ydif.toFixed(2) });
    }
  }

  // Audio transients: rising edges in the RMS envelope, above a floor.
  const transients = [];
  for (let i = 1; i < audio.length; i++) {
    const jump = audio[i].rms - audio[i - 1].rms;
    if (jump >= 6 && audio[i].rms > -35) {
      if (!transients.length || audio[i].t - transients[transients.length - 1].t > 0.35)
        transients.push({ t: +audio[i].t.toFixed(3), rms: +audio[i].rms.toFixed(1) });
    }
  }

  // SYNC: each audio transient to its nearest picture event (cut or motion peak).
  const events = [...cuts.map(t => ({ t, kind: 'cut' })), ...peaks.map(p => ({ t: p.t, kind: 'peak' }))]
    .sort((a, b) => a.t - b.t);
  const sync = transients.map(tr => {
    let best = null;
    for (const e of events) { const d = e.t - tr.t; if (best === null || Math.abs(d) < Math.abs(best.offsetSec)) best = { pictureT: e.t, kind: e.kind, offsetSec: +d.toFixed(3) }; }
    return best ? { audioT: tr.t, ...best, offsetMs: Math.round(best.offsetSec * 1000) } : { audioT: tr.t, pictureT: null, offsetMs: null };
  });
  const matched = sync.filter(s => s.pictureT !== null && Math.abs(s.offsetMs) <= 400);
  const meanAbsOffset = matched.length ? Math.round(matched.reduce((a, s) => a + Math.abs(s.offsetMs), 0) / matched.length) : null;

  // Content presence: average luma (YAVG) tracks how much bright content is on
  // screen. For a text-on-dark cinematic, a YAVG peak IS a line fully bloomed.
  // This is what turns the by-eye finding ("the words arrive after the hit") into
  // a measured number, automatically, for every hit.
  const yavg = motion.map(f => f.yavg ?? 0);
  const yMean = yavg.reduce((a, b) => a + b, 0) / (yavg.length || 1);
  const contentPeaks = [];
  for (let i = 2; i < motion.length - 2; i++) {
    const v = motion[i].yavg ?? 0;
    const w = motion.slice(i - 2, i + 3).map(f => f.yavg ?? 0);
    if (v > yMean * 1.15 && v === Math.max(...w)) {
      if (!contentPeaks.length || motion[i].t - contentPeaks[contentPeaks.length - 1].t > 1.0)
        contentPeaks.push({ t: +motion[i].t.toFixed(3), yavg: +v.toFixed(1) });
    }
  }

  // Each hit to its nearest content bloom. Positive offset = the sound lands
  // first and the words arrive after; negative = the words are already up.
  const hitOffsets = transients.map(tr => {
    let best = null;
    for (const cp of contentPeaks) { const d = cp.t - tr.t; if (best === null || Math.abs(d) < Math.abs(best.offsetSec)) best = { contentT: cp.t, offsetSec: +d.toFixed(3) }; }
    return best ? { hitT: tr.t, contentT: best.contentT, offsetMs: Math.round(best.offsetSec * 1000) } : { hitT: tr.t, contentT: null, offsetMs: null };
  });
  const withContent = hitOffsets.filter(h => h.contentT !== null);
  const meanContentOffsetMs = withContent.length ? Math.round(withContent.reduce((a, h) => a + h.offsetMs, 0) / withContent.length) : null;
  const medianAbsContentMs = withContent.length ? withContent.map(h => Math.abs(h.offsetMs)).sort((a, b) => a - b)[Math.floor(withContent.length / 2)] : null;

  // Style: a montage has cuts to sync against; a continuous piece (grain, drift,
  // slow reveals) has none, and scoring it against a cut track it never had is a
  // lie about a video that is fine. Classify, then report sync the honest way for
  // each: offset-to-cut for montage, offset-to-content-bloom for continuous.
  const style = cuts.length >= 2 ? 'cut-based' : 'continuous';

  return {
    style,
    motionMean: +mMean.toFixed(3), motionSd: +mSd.toFixed(3),
    cuts, holds, peaks: peaks.slice(0, 24), transients, sync,
    contentPeaks, hitOffsets,
    syncSummary: {
      style, transients: transients.length,
      matchedWithin400ms: matched.length, meanAbsOffsetMs: meanAbsOffset,
      contentBlooms: contentPeaks.length, meanContentOffsetMs, medianAbsContentMs,
    },
  };
}

function keyTimesFor(duration, d) {
  // Priority order matters: the cap can truncate, so the frames that carry the
  // most meaning go in first. The hits (transients) are what a human most needs
  // to eye-check, so they lead; then cuts, then even anchors, then the last frame.
  const ordered = [
    0,
    ...d.transients.map(tr => tr.t),
    ...d.cuts,
    ...[0.25, 0.5, 0.75].map(p => duration * p),
    duration - 0.05,
  ].map(t => +(+t).toFixed(2)).filter(t => t >= 0 && t <= duration);
  const seen = new Set(), out = [];
  for (const t of ordered) { const k = Math.round(t * 20); if (!seen.has(k)) { seen.add(k); out.push(t); } } // ~50ms dedupe
  return out.slice(0, 18).sort((a, b) => a - b);
}

// The sync picture: one strip where motion (purple, top) and loudness (blue,
// bottom) run left-to-right on a shared time axis, audio hits marked magenta,
// content blooms marked cyan. Where a magenta line has no cyan neighbour, the
// sound landed on nothing. Rasterized by hand to a PPM (zero deps), then ffmpeg
// turns it into a PNG the reader consumes in one look.
function timelineStrip(motion, audio, transients, contentPeaks, duration, ffmpeg, outFile, work) {
  const W = 1400, H = 500, band = H >> 1;
  const buf = Buffer.alloc(W * H * 3);
  for (let i = 0; i < W * H; i++) { buf[i * 3] = 12; buf[i * 3 + 1] = 12; buf[i * 3 + 2] = 14; }
  const set = (x, y, r, g, b) => { if (x < 0 || x >= W || y < 0 || y >= H) return; const o = (y * W + x) * 3; buf[o] = r; buf[o + 1] = g; buf[o + 2] = b; };
  const X = t => Math.round((t / duration) * (W - 1));
  for (let x = 0; x < W; x++) set(x, band, 40, 40, 46); // midline
  const ymax = Math.max(...motion.map(f => f.ydif), 0.001);
  for (const f of motion) { const x = X(f.t), h = Math.round((f.ydif / ymax) * (band - 10)); for (let y = 0; y < h; y++) set(x, band - 1 - y, 122, 92, 200); }
  for (const w of audio) { const x = X(w.t), n = Math.max(0, Math.min(1, (w.rms + 60) / 60)), h = Math.round(n * (band - 10)); for (let y = 0; y < h; y++) set(x, band + 1 + y, 90, 150, 214); }
  for (const cp of contentPeaks) { const x = X(cp.t); for (let y = 0; y < band; y++) set(x, y, 80, 210, 200); }
  for (const tr of transients) { const x = X(tr.t); for (let y = 0; y < H; y++) set(x, y, 232, 70, 180); }
  const ppm = path.join(work, 'strip.ppm');
  fs.writeFileSync(ppm, Buffer.concat([Buffer.from(`P6\n${W} ${H}\n255\n`, 'ascii'), buf]));
  ffLog(ffmpeg, ['-y', '-hide_banner', '-i', ppm, outFile], work);
  try { fs.unlinkSync(ppm); } catch {}
  return fs.existsSync(outFile) ? outFile : null;
}

// The whole film as a single tiled image, sampled evenly across the timeline.
function contactSheet(ffmpeg, file, duration, cols, rows, outFile) {
  const n = cols * rows, interval = duration / n;
  ffLog(ffmpeg, ['-y', '-hide_banner', '-i', file, '-frames:v', '1',
    '-vf', `fps=1/${interval.toFixed(4)},scale=360:-1,tile=${cols}x${rows}:padding=6:color=0x0a0a0a`, outFile], path.dirname(outFile));
  return fs.existsSync(outFile) ? outFile : null;
}

// The deliverable: one self-contained page a human opens to see the entire
// translation. Envie renders marketing; here it renders its own receipt. Images
// are referenced by sibling filename, so the .translate folder is the portable unit.
function writeReport(r, outDir) {
  const c = r.container, L = r.loudness, s = r.syncSummary;
  const rel = p => p ? path.basename(p) : null;
  const esc = v => String(v);
  const kfCells = r.assets.keyframes.map(k =>
    `<figure><img src="${rel(k.file)}" loading="lazy"><figcaption>${(k.t).toFixed(2)}s</figcaption></figure>`).join('');
  const offsetRows = (r.hitOffsets || []).map(h =>
    `<tr><td>${h.hitT.toFixed(2)}s</td><td>${h.contentT != null ? h.contentT.toFixed(2) + 's' : '--'}</td><td class="${h.offsetMs > 250 ? 'warn' : ''}">${h.offsetMs != null ? (h.offsetMs > 0 ? '+' : '') + h.offsetMs + 'ms' : '--'}</td></tr>`).join('');
  const html = `<!doctype html><html><head><meta charset="utf8"><title>Envie translation — ${esc(path.basename(r.file))}</title>
<style>
:root{color-scheme:dark}body{margin:0;background:#0a0a0c;color:#e8e8ea;font:15px/1.5 -apple-system,Segoe UI,Roboto,sans-serif;padding:40px;max-width:1180px;margin:0 auto}
h1{font-weight:600;font-size:20px;letter-spacing:-.01em}h2{font-size:13px;text-transform:uppercase;letter-spacing:.12em;color:#8a8a92;margin:38px 0 14px;font-weight:600}
.sub{color:#8a8a92;margin-top:-8px}code{color:#c9a4ff}img{max-width:100%;border-radius:8px;display:block}
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin:18px 0}
.stat{background:#141418;border:1px solid #22222a;border-radius:10px;padding:14px 16px}
.stat .k{color:#8a8a92;font-size:12px}.stat .v{font-size:19px;margin-top:4px;font-weight:600}
.legend{display:flex;gap:20px;flex-wrap:wrap;font-size:13px;color:#b8b8c0;margin:10px 0}
.legend b{display:inline-block;width:11px;height:11px;border-radius:3px;margin-right:6px;vertical-align:middle}
table{border-collapse:collapse;width:100%;font-size:14px}td,th{text-align:left;padding:7px 12px;border-bottom:1px solid #1e1e26}th{color:#8a8a92;font-weight:500}
.warn{color:#ffb454}.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(210px,1fr));gap:10px}
figure{margin:0}figcaption{font-size:12px;color:#8a8a92;margin-top:4px;text-align:center}
.note{color:#8a8a92;font-size:13px;border-left:2px solid #333;padding-left:14px;margin:14px 0}
</style></head><body>
<h1>Envie translation</h1>
<p class="sub"><code>${esc(r.file)}</code></p>
<div class="stats">
  <div class="stat"><div class="k">Duration</div><div class="v">${c.durationSec}s</div></div>
  <div class="stat"><div class="k">Frames measured</div><div class="v">${r.framesMeasured}</div></div>
  <div class="stat"><div class="k">Resolution</div><div class="v">${c.video ? c.video.w + '×' + c.video.h : '--'}</div></div>
  <div class="stat"><div class="k">Loudness</div><div class="v">${L && L.integratedLUFS != null ? L.integratedLUFS + ' LUFS' : '--'}</div></div>
  <div class="stat"><div class="k">True peak</div><div class="v">${L && L.truePeakDb != null ? L.truePeakDb + ' dB' : '--'}</div></div>
  <div class="stat"><div class="k">Style</div><div class="v" style="text-transform:capitalize">${s.style}</div></div>
</div>
<h2>Timeline · motion vs sound</h2>
<div class="legend"><span><b style="background:#7a5cc8"></b>motion</span><span><b style="background:#5a96d6"></b>loudness</span><span><b style="background:#e846b4"></b>audio hit</span><span><b style="background:#50d2c8"></b>content bloom</span></div>
${r.assets.strip ? `<img src="${rel(r.assets.strip)}">` : ''}
${s.meanContentOffsetMs != null ? `<p class="note">Mean hit→content offset ${s.meanContentOffsetMs > 0 ? '+' : ''}${s.meanContentOffsetMs}ms (median ${s.medianAbsContentMs}ms). Positive means the sound lands and the words arrive after.</p>` : ''}
<h2>Audio spectrum</h2>${r.assets.spectrogram ? `<img src="${rel(r.assets.spectrogram)}">` : ''}
<h2>Waveform</h2>${r.assets.waveform ? `<img src="${rel(r.assets.waveform)}">` : ''}
${offsetRows ? `<h2>Hit → content bloom</h2><table><tr><th>Audio hit</th><th>Nearest content bloom</th><th>Offset</th></tr>${offsetRows}</table>` : ''}
<h2>Contact sheet</h2>${r.assets.contactSheet ? `<img src="${rel(r.assets.contactSheet)}">` : ''}
<h2>Keyframes</h2><div class="grid">${kfCells}</div>
<p class="note" style="margin-top:40px">Envie does not hear, and does not see motion as motion. Every fact of both is translated here into a number or an image. The aesthetic verdict is yours.</p>
</body></html>`;
  const out = path.join(outDir, 'report.html');
  fs.writeFileSync(out, html);
  return out;
}

function translate(file, opts = {}) {
  const abs = path.resolve(file);
  if (!fs.existsSync(abs)) throw new Error('video not found: ' + abs);
  const ffmpeg = findBin('ffmpeg');
  const ffprobe = findBin('ffprobe');
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'envie-tr-'));
  const outDir = opts.out || path.join(path.dirname(abs), path.basename(abs) + '.translate');

  try {
    const container = probeContainer(ffprobe, abs);
    const duration = container.durationSec;
    const motion = motionSeries(ffmpeg, abs, work);
    const audio = container.audio ? audioSeries(ffmpeg, abs, work, opts.windowsPerSec || 20, container.audio.sampleRate) : [];
    const loud = container.audio ? loudness(ffmpeg, abs, work) : null;
    const d = derive(motion, audio, duration);
    const assets = writeAssets(ffmpeg, abs, outDir, keyTimesFor(duration, d));
    assets.strip = timelineStrip(motion, audio, d.transients, d.contentPeaks, duration, ffmpeg, path.join(outDir, 'timeline.png'), work);
    assets.contactSheet = contactSheet(ffmpeg, abs, duration, 5, 4, path.join(outDir, 'contact-sheet.png'));

    const r = {
      file: abs, outDir, container, loudness: loud,
      framesMeasured: motion.length, audioWindows: audio.length,
      ...d, assets,
      // full raw series kept for anyone who wants every number
      series: opts.keepSeries ? { motion, audio } : undefined,
    };
    r.assets.report = writeReport(r, outDir);
    return r;
  } finally {
    try { fs.rmSync(work, { recursive: true, force: true }); } catch {}
  }
}

function formatReport(r) {
  const c = r.container, L = r.loudness;
  const secs = t => (t == null ? '--' : t.toFixed(2) + 's');
  let o = '\nENVIE TRANSLATE  ' + r.file + '\n';
  o += `  container   ${c.sizeMB}MB  ${c.durationSec}s`;
  if (c.video) o += `  ${c.video.w}x${c.video.h} ${c.video.codec} ${c.video.pixfmt} @${c.video.fps}fps`;
  if (c.audio) o += `  ${c.audio.codec} ${c.audio.sampleRate}Hz x${c.audio.channels}`;
  o += '\n';
  o += `  measured    ${r.framesMeasured} frames, ${r.audioWindows} audio windows (nothing sampled)\n`;
  o += `  MOTION      mean frame-diff ${r.motionMean} (sd ${r.motionSd})\n`;
  o += `              ${r.cuts.length} cuts` + (r.cuts.length ? ' @ ' + r.cuts.map(secs).join(', ') : '') + '\n';
  if (r.holds.length) o += `              still holds: ` + r.holds.map(h => `${h.dur}s @${h.start}s`).join(', ') + '\n';
  else o += `              still holds: none over 1s (always moving)\n`;
  if (L) {
    o += `  SOUND       ${L.integratedLUFS} LUFS integrated, true peak ${L.truePeakDb} dBFS, range ${L.rangeLU} LU\n`;
    o += `              ${r.transients.length} transients` + (r.transients.length ? ' @ ' + r.transients.map(t => secs(t.t)).join(', ') : '') + '\n';
  } else o += `  SOUND       no audio stream\n`;
  const s = r.syncSummary;
  if (r.style === 'continuous') {
    o += `  SYNC        continuous composition (no cut track) — measured against content blooms\n`;
    if (s.meanContentOffsetMs != null)
      o += `              ${s.contentBlooms} content blooms; mean hit→content ${s.meanContentOffsetMs > 0 ? '+' : ''}${s.meanContentOffsetMs}ms (median ${s.medianAbsContentMs}ms)\n`;
    else
      o += `              ${s.transients} hits captured as keyframes for eye-check\n`;
  } else {
    o += `  SYNC        ${s.matchedWithin400ms}/${s.transients} transients land on a cut within 400ms`;
    o += s.meanAbsOffsetMs != null ? `, mean offset ${s.meanAbsOffsetMs}ms\n` : '\n';
  }
  o += `  RECEIPTS    ${r.assets.keyframes.length} keyframes + spectrogram + waveform + timeline + contact sheet\n`;
  o += `              report: ${r.assets.report}\n`;
  return o;
}

module.exports = { translate, formatReport };

if (require.main === module) {
  const args = process.argv.slice(2);
  const file = args.find(a => !a.startsWith('--'));
  if (!file) { console.error('usage: node translate.cjs <video> [--json] [--out DIR]'); process.exit(2); }
  const outIdx = args.indexOf('--out');
  const r = translate(file, { out: outIdx >= 0 ? args[outIdx + 1] : null, keepSeries: args.includes('--series') });
  console.log(args.includes('--json') ? JSON.stringify(r, null, 2) : formatReport(r));
}
