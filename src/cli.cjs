#!/usr/bin/env node
// Envie. Copyright (c) 2026 GOL Productions (https://golproductions.com). See LICENSE.
// MCP server + CLI.
// Commands:
//   envie render <composition.html> -o out.mp4 [--narration "text" | --audio track.wav] [--voice NAME] [--fps N] [--format ...]
//   (renders are free: no charge, no watermark, no account. Runs entirely on
//    your machine. It never contacts GOL servers.)
//   envie verify <video.mp4>
//   envie translate <video.mp4> [-o dir]   (read a finished video back as data)
//   envie guide            (the authoring contract for AI agents)
//   envie mcp              (run as an MCP stdio server)
//   envie install          (print MCP config for Claude Code / Cursor)

const fs = require('fs');
const path = require('path');
const os = require('os');
const { render, snapshot, framesFromVideo } = require('./render.cjs');
const { speak } = require('./tts.cjs');

const { runGates, formatReport } = require('./gates.cjs');
// translate.cjs ships its own formatReport; alias it so it cannot shadow the
// gates report that `envie verify` prints.
const { translate, formatReport: formatTranslateReport } = require('./translate.cjs');

const GUIDE = `ENVIE AUTHORING CONTRACT (v0.1)

You (the AI agent) write ONE self-contained HTML file. Envie renders it to MP4 deterministically and verifies the result before delivery.

RULES
1. <body data-duration-ms="N"> is required. 3000-300000. This IS the video length.
2. Canvas defaults to 1920x1080. Override with <body data-width="W" data-height="H">
   (even numbers, 320-3840). Vertical 1080x1920 for TikTok/Reels/Shorts, 1080x1080 square.
   Design for the fixed frame: body { margin:0; width:Wpx; height:Hpx; overflow:hidden; }
3. Animate with ANYTHING the browser can do. Envie virtualizes time itself:
   CSS animations, Web Animations API, requestAnimationFrame, setTimeout/setInterval,
   canvas 2D, WebGL, JS physics, new Date()/Date.now()/performance.now clocks,
   requestIdleCallback, and embedded <video>/<audio> elements all advance frame-locked
   to the render timeline. Math.random and crypto.getRandomValues are seeded:
   the same composition renders the same video every time.
   NOT virtualized (avoid): Web Workers, WebAudio-driven visuals.
   Animated images (GIF/WebP/APNG/AVIF) ARE virtualized as of 0.6.0: the engine decodes each image
   once and shows the correct looped frame at every seek. Confirmed working (receipt: G-H, ENVIE-GAPS.md).
4. Everything inline: styles in <style>, no external network requests (fonts: system stack or data: URIs).
5. Motion must persist through the FULL duration. A static stretch longer than 8s FAILS verification (G5).
   The last 15% of the timeline must still be moving (G6). Design an ending, not a die-out.
6. Scene pattern: absolutely-positioned full-frame <section>s, opacity keyframed by delay:
   section { position:absolute; inset:0; opacity:0; }
   @keyframes scene1 { 0%,100%{opacity:0} 5%,95%{opacity:1} } etc.
7. Audio is passed separately and is REQUIRED: a video with no audio stream fails G2 and G3.
   - narration: "..."  generates a voiceover with local TTS. WINDOWS ONLY.
   - audio_path: "..."  lays over an existing wav/mp3/m4a. Works everywhere, wins over narration.
   On macOS or Linux, narration throws; use audio_path. Keep either in sync with your scene timings.

THE LOOP (write -> run -> LOOK -> MEASURE -> fix)
1. Write the composition HTML.
2. envie_render it. The 6 gates (container, streams, silence, black, freeze, dead-end)
   machine-check that the video is ALIVE. A failing gate report tells you what to fix.
3. envie_see it. Gates cannot judge taste; your eyes can. Look at the returned frames:
   overlapping elements, unreadable text, broken layout, dead compositions, bad pacing.
4. envie_translate it. Stills are blind BETWEEN frames and deaf to the whole audio
   track, so this reads the finished file back as numbers you can act on: per-frame
   motion, every cut, still holds, integrated loudness (LUFS), true peak, every audio
   transient, and how many milliseconds each audio hit sits from the nearest cut.
   If you scored this video, you cannot hear it. This is how you check the score landed.
5. Fix the composition and render again. Do not deliver a video you have not looked at
   AND measured.

INTENT ASSERTIONS (optional)
Declare what the composition must achieve. Envie checks it after render.
Add to <body>:

   data-expect-sync-ms="120"            audio hits must land within 120ms of a picture event
   data-expect-no-holds-longer-than="3" no still hold may exceed 3 seconds

Failures are reported in test-failure style:
   SYNC FAIL: mean audio-to-picture offset 380ms exceeds tolerance 120ms
   HOLD FAIL: 2 hold(s) exceed 3s: 4.20s @0.40s, 3.10s @7.80s

verified is false when any assertion fails -- the composition is rejected
even if all six gates pass.

WHAT THE GATES DO NOT DO
The gates prove a file is alive. They do not know what you INTENDED. They cannot tell
you the headline was illegible, the beat missed the cut, or scene 2 overlapped scene 3.
That judgement is still yours: use envie_see for what a frame looks like and
envie_translate for what the motion and sound actually measure.

Renders are free, unwatermarked, and unlimited.`;

// build.cjs substitutes __ENVIE_VERSION__ via esbuild --define, so the shipped
// core carries a literal. Running src/ directly (dev, tests) has no define, so
// fall back to package.json rather than throwing a ReferenceError.
const ENVIE_VERSION = (typeof __ENVIE_VERSION__ !== 'undefined')
  ? __ENVIE_VERSION__
  : (() => { try { return require('../package.json').version; } catch { return '0.0.0'; } })();

// Local render authorization. No server, no grant, no network.
// All formats, all fps, no watermark, no restrictions.
function acquireRenderToken(log) {
  log('render authorized: local (free, no watermark)');
  return {
    watermark: false,
    mark: null,
    caps: { formats: ['h264', 'h265', 'prores', 'prores4444', 'dnxhr'] },
    nonce: null
  };
}

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-o' || a === '--out') out.out = argv[++i];
    else if (a === '--narration') out.narration = argv[++i];
    else if (a === '--voice') out.voice = argv[++i];
    else if (a === '--fps') out.fps = parseInt(argv[++i], 10);
    else if (a === '--at') out.at = argv[++i];
    else if (a === '--format') out.format = argv[++i];
    else if (a === '--audio') out.audio = argv[++i];
    else if (a === '--no-watermark') out.noWatermark = true;
    else out._.push(a);
  }
  return out;
}

// G-A: Parse data-expect-* declarations from the composition HTML.
function parseIntentAssertions(htmlPath) {
  const assertions = {};
  try {
    const html = fs.readFileSync(htmlPath, 'utf8');
    const syncM = html.match(/data-expect-sync-ms=["'](\d+)["']/);
    if (syncM) assertions.syncMs = parseInt(syncM[1], 10);
    const holdsM = html.match(/data-expect-no-holds-longer-than=["']([\d.]+)["']/);
    if (holdsM) assertions.noHoldsLongerThan = parseFloat(holdsM[1]);
  } catch (e) {}
  return assertions;
}

// Check intent assertions against translate output. Returns failure strings (empty = all pass).
function checkAssertions(outPath, assertions, log) {
  const failures = [];
  if (!Object.keys(assertions).length) return failures;
  log('checking intent assertions...');
  try {
    const tr = require('./translate.cjs');
    const res = tr.translate(outPath, {});
    const s = res.syncSummary;
    if (assertions.syncMs != null) {
      const offset = s.meanAbsOffsetMs != null ? s.meanAbsOffsetMs : (s.meanContentOffsetMs != null ? Math.abs(s.meanContentOffsetMs) : null);
      if (offset != null && offset > assertions.syncMs) {
        failures.push('SYNC FAIL: mean audio-to-picture offset ' + offset + 'ms exceeds tolerance ' + assertions.syncMs + 'ms');
      }
    }
    if (assertions.noHoldsLongerThan != null) {
      const longHolds = (res.holds || []).filter(function(h) { return h.dur > assertions.noHoldsLongerThan; });
      if (longHolds.length) {
        failures.push('HOLD FAIL: ' + longHolds.length + ' hold(s) exceed ' + assertions.noHoldsLongerThan + 's: ' +
          longHolds.map(function(h) { return h.dur.toFixed(2) + 's @' + h.start.toFixed(2) + 's'; }).join(', '));
      }
    }
    if (failures.length) log('assertion failures: ' + failures.join(' | '));
    else log('all assertions passed');
  } catch (e) {
    log('assertion check error: ' + e.message);
  }
  return failures;
}
async function doRender(a, log) {
  const htmlPath = a._[0];
  const intentAssertions = htmlPath ? parseIntentAssertions(path.resolve(htmlPath)) : {};
  if (!htmlPath) throw new Error('usage: envie render <composition.html> -o out.mp4 [--narration "..." | --audio track.wav] [--fps N] [--format h264|h265|prores|prores4444|dnxhr]');
  const outPath = path.resolve(a.out || htmlPath.replace(/\.html?$/i, '') + '.mp4');

  // Audio, in priority order: a file the caller supplies, else local TTS.
  //
  // --audio exists because local TTS is Windows-only (SAPI), and G2/G3 require a
  // real audio stream. Without a way to bring your own track, a macOS or Linux
  // user could not produce a VERIFIED video at all: narration threw, and no
  // narration meant no audio stream, which fails two gates. That made the whole
  // product Windows-only in practice while the docs claimed otherwise.
  let narrationWav = null;
  let ownAudio = false;
  if (a.audio) {
    const ap = path.resolve(a.audio);
    if (!fs.existsSync(ap)) throw new Error('audio file not found: ' + ap);
    narrationWav = ap;
    ownAudio = true;
    log('audio: ' + path.basename(ap));
  } else if (a.narration) {
    if (process.platform !== 'win32') {
      throw new Error('local narration needs Windows (SAPI). On macOS/Linux, supply your own track with --audio <file.wav|mp3|m4a>, or an MCP client can pass audio_path.');
    }
    narrationWav = path.join(os.tmpdir(), 'envie-voice-' + Date.now() + '.wav');
    log('narration: generating voice…');
    speak(a.narration, narrationWav, a.voice);
  }

  // Local authorization: no server, no restrictions.
  const token = acquireRenderToken(log);
  const finalWatermark = token.watermark;

  const format = String(a.format || 'h264').toLowerCase();
  const fps = a.fps || 24;

  const r = await render({ htmlPath, outPath, fps, format, watermark: finalWatermark, mark: token.mark, narrationWav, log });
  // Only clean up the temp WAV we generated. A caller's own file is theirs.
  if (narrationWav && !ownAudio) { try { fs.unlinkSync(narrationWav); } catch {} }

  log('verifying…');
  const res = runGates(outPath);
  const assertionFailures = checkAssertions(outPath, intentAssertions, log);
  return { outPath: r.outPath, durationMs: r.durationMs, verified: res.pass && assertionFailures.length === 0, gates: res.gates, watermark: finalWatermark, format, assertionFailures };
}

// ---------- MCP stdio server ----------
function mcpServer() {
  const TOOLS = [
    {
      name: 'envie_guide',
      description: 'Read this FIRST. Returns the authoring contract: how to write a composition HTML file that Envie can render into a verified video.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false }
    },
    {
      name: 'envie_render',
      description: 'Render a composition HTML file into an MP4 video with optional voiceover, then machine-verify it (6 gates: container, streams, silence, black frames, freezes, dead endings). Returns the verification report and output path. Only use after reading envie_guide.',
      inputSchema: {
        type: 'object',
        properties: {
          html_path: { type: 'string', description: 'Absolute path to the composition HTML file' },
          out_path: { type: 'string', description: 'Absolute path for the output MP4' },
          narration: { type: 'string', description: 'Voiceover script, spoken over the video using local TTS. WINDOWS ONLY. On macOS or Linux use audio_path instead. Videos with no audio at all fail verification (G2/G3).' },
          audio_path: { type: 'string', description: 'Absolute path to an audio file (wav/mp3/m4a) to lay over the video. Works on every platform, and takes priority over narration. This is how you supply sound on macOS and Linux, where local TTS is unavailable.' },
          voice: { type: 'string', description: 'Optional TTS voice name hint' },
          fps: { type: 'number', description: 'Frames per second, default 24' },
          format: {
            type: 'string',
            enum: ['h264', 'h265', 'prores', 'prores4444', 'dnxhr'],
            description: 'Delivery codec, default h264 (.mp4). prores/prores4444/dnxhr require a .mov out_path. h265 is 10-bit.'
          }
        },
        required: ['html_path', 'out_path'],
        additionalProperties: false
      }
    },
    {
      name: 'envie_verify',
      description: 'Run the 6 Envie verification gates against any existing MP4 and get the pass/fail report.',
      inputSchema: {
        type: 'object',
        properties: { video_path: { type: 'string', description: 'Absolute path to the MP4' } },
        required: ['video_path'],
        additionalProperties: false
      }
    },
    {
      name: 'envie_see',
      description: 'LOOK at your work. Returns actual frames (as images) from a composition HTML or a rendered MP4 at chosen timestamps. Use this to visually inspect layout, text readability, overlaps, and scene composition with your own eyes, then fix the composition and render again. The verification gates prove a video is alive; envie_see is how you judge whether it is good. Default: frames at 0%, 25%, 50%, 75%, 95% of the timeline.',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Absolute path to a composition .html or a rendered .mp4' },
          timestamps_ms: { type: 'array', items: { type: 'number' }, description: 'Timeline positions in milliseconds to capture (max 12). Omit for the default five.' }
        },
        required: ['path'],
        additionalProperties: false
      }
    },
    {
      name: 'envie_translate',
      description: 'HEAR and MEASURE your work. Reads a finished video back as data you can act on without eyes or ears: per-frame motion, every cut, still holds, integrated loudness (LUFS), true peak, every audio transient, and how far each audio hit sits from the nearest cut in milliseconds. envie_see shows you stills and is blind between them; envie_translate measures motion and sound across the whole file. Use it after envie_render to judge pacing and audio sync, then fix the composition and render again.',
      inputSchema: {
        type: 'object',
        properties: {
          video_path: { type: 'string', description: 'Absolute path to the rendered video' },
          out_dir: { type: 'string', description: 'Optional directory for the receipt assets (keyframes, spectrogram, timeline strip, contact sheet, HTML report)' }
        },
        required: ['video_path'],
        additionalProperties: false
      }
    }
  ];

  const reply = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
  const replyErr = (id, message) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32000, message } }) + '\n');
  const text = (t) => ({ content: [{ type: 'text', text: t }] });

  let buf = '';
  process.stdin.on('data', async (d) => {
    buf += d;
    let nl;
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      const { id, method, params } = msg;
      try {
        if (method === 'initialize') {
          reply(id, {
            protocolVersion: params && params.protocolVersion ? params.protocolVersion : '2024-11-05',
            capabilities: { tools: {} },
            serverInfo: { name: 'envie', version: ENVIE_VERSION }
          });
        } else if (method === 'notifications/initialized') {
          // notification, no reply
        } else if (method === 'tools/list') {
          reply(id, { tools: TOOLS });
        } else if (method === 'tools/call') {
          const { name, arguments: args = {} } = params;
          if (name === 'envie_guide') {
            reply(id, text(GUIDE));
          } else if (name === 'envie_verify') {
            reply(id, text(JSON.stringify(runGates(args.video_path), null, 2)));
          } else if (name === 'envie_see') {
            const p = String(args.path || '');
            const res = /\.(mp4|webm|mov)$/i.test(p)
              ? framesFromVideo(p, args.timestamps_ms || [])
              : await snapshot({ htmlPath: p, timestamps: args.timestamps_ms || [] });
            reply(id, { content: [
              { type: 'text', text: `${res.frames.length} frames from ${p} (duration ${(res.durationMs / 1000).toFixed(1)}s). Timestamps: ${res.frames.map(f => (f.t / 1000).toFixed(1) + 's').join(', ')}. Look at each frame: layout, readability, overlap, pacing.` },
              ...res.frames.map(f => ({ type: 'image', data: f.data, mimeType: f.mimeType }))
            ] });
          } else if (name === 'envie_translate') {
            const res = translate(String(args.video_path || ''), args.out_dir ? { out: path.resolve(args.out_dir) } : {});
            reply(id, text(formatTranslateReport(res) + '\n' + JSON.stringify({
              style: res.style,
              motion: { mean: res.motionMean, sd: res.motionSd, cuts: res.cuts, holds: res.holds },
              sound: res.loudness,
              transients: res.transients,
              sync: res.syncSummary,
              assets: res.assets,
            }, null, 2)));
          } else if (name === 'envie_render') {
            const logs = [];
            const res = await doRender(
              { _: [args.html_path], out: args.out_path, narration: args.narration, audio: args.audio_path, voice: args.voice, fps: args.fps, format: args.format },
              (m) => logs.push(m)
            );
            reply(id, text(JSON.stringify({
              ok: res.verified,
              video: res.outPath,
              duration_s: res.durationMs / 1000,
              watermark: res.watermark,
              format: res.format,
              verification: res.gates,
              note: res.verified
                ? 'Video passed all gates and is deliverable.'
                : 'Video FAILED verification. Read the gate report, fix the composition, render again. Do not deliver this file.',
              assertionFailures: res.assertionFailures || [],
              log: logs
            }, null, 2)));
          } else {
            replyErr(id, 'unknown tool: ' + name);
          }
        } else if (id !== undefined) {
          replyErr(id, 'unknown method: ' + method);
        }
      } catch (e) {
        if (id !== undefined) replyErr(id, e.message);
      }
    }
  });
}

(async () => {
  const [cmd, ...rest] = process.argv.slice(2);
  const a = parseArgs(rest);
  const log = (m) => console.error('[envie] ' + m);

  if (cmd === 'render') {
    const res = await doRender(a, log);
    console.log(JSON.stringify(res, null, 2));
    // process.exitCode, never process.exit: forcing an exit after more than one
    // network call trips a libuv teardown assertion on Windows/Node 24
    // (!(handle->flags & UV_HANDLE_CLOSING), srcwinasync.c:76). Every render
    // has already fetched a grant by this point. Let the loop drain instead.
    process.exitCode = res.verified ? 0 : 1;
  } else if (cmd === 'verify') {
    const res = runGates(a._[0]);
    console.log(formatReport(res));
    process.exitCode = res.pass ? 0 : 1;
  } else if (cmd === 'see') {
    const p = a._[0];
    if (!p) throw new Error('usage: envie see <composition.html|video.mp4> [--at 1000,4000] [-o dir]');
    const at = (a.at ? String(a.at).split(',').map(Number) : []);
    const res = /\.(mp4|webm|mov)$/i.test(p)
      ? framesFromVideo(p, at)
      : await snapshot({ htmlPath: p, timestamps: at, log });
    const dir = path.resolve(a.out || '.');
    fs.mkdirSync(dir, { recursive: true });
    for (const f of res.frames) {
      const fp = path.join(dir, `see-${String(f.t).padStart(6, '0')}ms.jpg`);
      fs.writeFileSync(fp, Buffer.from(f.data, 'base64'));
      console.log(fp);
    }
  } else if (cmd === 'translate') {
    const p = a._[0];
    if (!p) throw new Error('usage: envie translate <video.mp4> [-o dir]');
    const res = translate(p, { out: a.out ? path.resolve(a.out) : undefined });
    console.log(formatTranslateReport(res));
  } else if (cmd === 'guide') {
    console.log(GUIDE);
  } else if (cmd === 'mcp') {
    mcpServer();
  } else if (cmd === 'setup') {
    // One-liner: detect Claude Code, register MCP, done.
    const { execSync: ex } = require('child_process');
    let hasClaude = false;
    try { ex('claude --version', { stdio: 'pipe', windowsHide: true }); hasClaude = true; } catch {}
    if (hasClaude) {
      console.log('[envie] Registering MCP server with Claude Code...');
      const config = JSON.stringify({ command: 'npx', args: ['-y', '@golproductions/envie', 'mcp'] });
      const escaped = process.platform === 'win32' ? config.replace(/"/g, '\\"') : config.replace(/'/g, "'\\''");
      const cmd2 = process.platform === 'win32'
        ? `claude mcp add-json --scope user envie "${escaped}"`
        : `claude mcp add-json --scope user envie '${escaped}'`;
      try {
        ex(cmd2, { stdio: 'pipe', windowsHide: true });
        console.log('[envie] Done. Envie is registered.');
        console.log('[envie] Ask your AI: "make me a 15-second launch video for my app"');
        console.log('[envie] golproductions.com/envie');
      } catch (e) {
        console.error('[envie] Auto-register failed: ' + (e.message || e));
        console.log('[envie] Manual: claude mcp add envie -- npx -y @golproductions/envie mcp');
      }
    } else {
      console.log('[envie] Claude Code not found. Add Envie to any MCP client:\n');
      console.log(JSON.stringify({ mcpServers: { envie: { command: 'npx', args: ['-y', '@golproductions/envie', 'mcp'] } } }, null, 2));
      console.log('\nOr install Claude Code first: https://claude.ai/code');
    }
  } else if (cmd === 'install') {
    // Legacy alias for setup
    console.log('Add Envie to Claude Code:\n');
    console.log('  npx @golproductions/envie setup\n');
    console.log('Or manually:\n');
    console.log('  claude mcp add envie -- npx -y @golproductions/envie mcp\n');
    console.log('Any MCP config (Cursor, etc):\n');
    console.log(JSON.stringify({ mcpServers: { envie: { command: 'npx', args: ['-y', '@golproductions/envie', 'mcp'] } } }, null, 2));
  } else {
    console.log('envie <render|see|verify|translate|guide|mcp|setup>');
    console.log('Type into your AI. Get a verified video. golproductions.com/envie');
  }
})().catch(e => {
  console.error('[envie] ERROR: ' + e.message);
  // Same reason as above: a failed render has already fetched a grant, so
  // process.exit() here aborts the runtime and prints a libuv assertion on top
  // of the real error message.
  process.exitCode = 1;
});
