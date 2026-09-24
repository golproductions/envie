#!/usr/bin/env node
// Envie. Copyright (c) 2026 GOL Productions (https://golproductions.com). See LICENSE.
// Verification engine: machine-checks a rendered video before delivery.
// Gates:
//   G1 container   file exists, >100KB, valid container, duration >= 2.9s
//   G2 streams     has video stream AND audio stream
//   G3 silence     audio has real signal (mean volume above -50dB, no full-length silence)
//   G4 black       no black segment longer than 2s (blackdetect)
//   G5 freeze      no single static segment > 8s; cumulative still time must not exceed 60% of runtime
//   G6 dead-end    the final 15% of the video must not be one frozen/black stretch

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

// Programs run with an argument list and no shell: the video path is passed as
// data, so no character in it can be read as shell syntax.
const RUN_OPTS = { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, windowsHide: true };
function run(bin, args) {
  const r = spawnSync(bin, args, RUN_OPTS);
  return r.status === 0 ? (r.stdout || '') : (r.stdout || '') + (r.stderr || '');
}
function runErr(bin, args) {
  return spawnSync(bin, args, RUN_OPTS).stderr || '';
}

function runGates(file) {
  const gates = [];
  function gate(id, name, pass, detail) { gates.push({ id, name, pass, detail }); return pass; }

  function main() {
    if (!file || !fs.existsSync(file)) { gate('G1', 'container', false, 'file not found'); return report(); }
    const size = fs.statSync(file).size;
    if (size < 100 * 1024) { gate('G1', 'container', false, 'file only ' + (size / 1024).toFixed(1) + 'KB'); return report(); }

    const probeRaw = run('ffprobe', ['-v', 'quiet', '-print_format', 'json', '-show_format', '-show_streams', file]);
    let probe;
    try { probe = JSON.parse(probeRaw); } catch (ex) { gate('G1', 'container', false, 'unreadable container'); return report(); }
    const duration = parseFloat((probe.format || {}).duration || '0');
    if (!(duration >= 2.9)) { gate('G1', 'container', false, 'duration ' + duration.toFixed(1) + 's'); return report(); }
    gate('G1', 'container', true, (size / 1048576).toFixed(1) + 'MB, ' + duration.toFixed(1) + 's');

    const streams = probe.streams || [];
    const hasV = streams.some(function(s) { return s.codec_type === 'video'; });
    const hasA = streams.some(function(s) { return s.codec_type === 'audio'; });
    gate('G2', 'streams', hasV && hasA, 'video:' + hasV + ' audio:' + hasA);

    if (hasA) {
      const vol = runErr('ffmpeg', ['-hide_banner', '-i', file, '-map', '0:a:0', '-af', 'volumedetect', '-f', 'null', '-']);
      const meanMatch = vol.match(/mean_volume:\s*(-?[\d.]+)/);
      const mean = parseFloat(meanMatch ? meanMatch[1] : '-99');
      const sil = runErr('ffmpeg', ['-hide_banner', '-i', file, '-map', '0:a:0', '-af', 'silencedetect=noise=-45dB:d=5', '-f', 'null', '-']);
      const silences = [];
      const silRe = /silence_duration:\s*([\d.]+)/g;
      let sm;
      while ((sm = silRe.exec(sil)) !== null) silences.push(parseFloat(sm[1]));
      const longestSilence = silences.length ? Math.max.apply(null, silences) : 0;
      gate('G3', 'silence', mean > -50, 'mean ' + mean + 'dB, longest silent stretch ' + longestSilence.toFixed(1) + 's');
    } else {
      gate('G3', 'silence', false, 'no audio stream to measure');
    }

    const black = runErr('ffmpeg', ['-hide_banner', '-i', file, '-vf', 'blackdetect=d=2:pix_th=0.02', '-an', '-f', 'null', '-']);
    const blackSegs = [];
    const blackRe = /black_start:([\d.]+)\s+black_end:([\d.]+)\s+black_duration:([\d.]+)/g;
    let bm;
    while ((bm = blackRe.exec(black)) !== null) blackSegs.push({ start: +bm[1], end: +bm[2], dur: +bm[3] });
    gate('G4', 'black', blackSegs.length === 0,
      blackSegs.length ? blackSegs.map(function(s) { return s.dur.toFixed(1) + 's black @' + s.start.toFixed(1) + 's'; }).join(', ') : 'none');

    // G5: no single static stretch > 8s AND cumulative still time under 60% of runtime.
    // Receipt G-C: 9.25s of holds in a 12s video passed with g5="none" before this cumulative check.
    const freezeLog = runErr('ffmpeg', ['-hide_banner', '-i', file, '-vf', 'freezedetect=n=0.001:d=8', '-an', '-f', 'null', '-']);
    const fStarts = [];
    const fEnds = [];
    const frRe = /freeze_start:\s*([\d.]+)/g;
    const feRe = /freeze_end:\s*([\d.]+)/g;
    let frm;
    while ((frm = frRe.exec(freezeLog)) !== null) fStarts.push(+frm[1]);
    const freezeLog2 = freezeLog;
    while ((frm = feRe.exec(freezeLog2)) !== null) fEnds.push(+frm[1]);
    const freezes = fStarts.map(function(s, i) {
      const e = fEnds[i] !== undefined ? fEnds[i] : duration;
      return { start: s, end: e, dur: e - s };
    });

    // Second pass at d=0.5 to measure cumulative stillness from short holds.
    const shortLog = runErr('ffmpeg', ['-hide_banner', '-i', file, '-vf', 'freezedetect=n=0.001:d=0.5', '-an', '-f', 'null', '-']);
    const shStarts = [];
    const shEnds = [];
    const shRe = /freeze_start:\s*([\d.]+)/g;
    const sheRe = /freeze_end:\s*([\d.]+)/g;
    let shm;
    while ((shm = shRe.exec(shortLog)) !== null) shStarts.push(+shm[1]);
    while ((shm = sheRe.exec(shortLog)) !== null) shEnds.push(+shm[1]);
    const shortHolds = shStarts.map(function(s, i) {
      const e = shEnds[i] !== undefined ? shEnds[i] : duration;
      return { dur: e - s };
    });
    const cumSec = shortHolds.reduce(function(a, h) { return a + h.dur; }, 0);
    const cumPct = duration > 0 ? cumSec / duration : 0;
    const cumFail = cumPct > 0.6;

    const g5pass = freezes.length === 0 && !cumFail;
    let g5detail = 'none';
    if (freezes.length) {
      g5detail = freezes.map(function(f) { return f.dur.toFixed(1) + 's frozen @' + f.start.toFixed(1) + 's'; }).join(', ');
    } else if (cumFail) {
      g5detail = 'no single freeze >8s but ' + (cumPct * 100).toFixed(0) + '% runtime is still holds (' + cumSec.toFixed(1) + 's/' + duration.toFixed(1) + 's)';
    }
    gate('G5', 'freeze', g5pass, g5detail);

    const tailStart = duration * 0.85;
    const deadTail = freezes.some(function(f) { return f.start <= tailStart && f.end >= duration - 1; })
      || blackSegs.some(function(s) { return s.start <= tailStart && s.end >= duration - 1; });
    gate('G6', 'dead-end', !deadTail, deadTail ? 'video dies before it ends' : 'ending is alive');

    return report();
  }

  function report() {
    const pass = gates.every(function(x) { return x.pass; });
    return { file: file, pass: pass, gates: gates };
  }

  return main();
}

function formatReport(res) {
  let out = '\nENVIE VERIFY  ' + res.file + '\n';
  for (const g of res.gates) out += '  ' + (g.pass ? 'PASS' : 'FAIL') + '  ' + g.id + ' ' + g.name.padEnd(10) + ' ' + g.detail + '\n';
  out += res.pass ? '\n  VERDICT: DELIVERABLE' : '\n  VERDICT: REJECTED, do not deliver';
  return out;
}

module.exports = { runGates: runGates, formatReport: formatReport };

if (require.main === module) {
  const res = runGates(process.argv[2]);
  console.log(process.argv.includes('--json') ? JSON.stringify(res, null, 2) : formatReport(res));
  process.exit(res.pass ? 0 : 1);
}