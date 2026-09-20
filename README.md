# Envie

**AI video, verified.**

Describe a video to your AI. Get a real file back.

Envie gives Claude Code and any MCP client a deterministic render engine: headless Chrome filmed frame by frame, six verification gates, and a full read-back layer. Free. No watermark. No account.

By [GOL Productions](https://golproductions.com).

---

## The Problem

AI can write code. AI can describe video. But AI can't see what it made—so it guesses, you render, it's wrong, you describe what's wrong, repeat.

## The Solution

```
You: "Make me a 15-second launch video for my app"
AI:  [writes HTML composition]
AI:  [calls envie_render]
AI:  [calls envie_see to check frames]
AI:  "Done. Video at output.mp4. All 6 gates passed."
```

Envie renders what your AI writes, verifies it machine-checks, and lets your AI see the result. No guessing.

---

## Install

```
npx @golproductions/envie setup
```

Detects Claude Code, Cursor, Windsurf—registers with all of them. Then just ask:

> "Make me a 15-second vertical launch video for my app"

<details>
<summary>Manual install</summary>

```json
{ "mcpServers": { "envie": { "command": "npx", "args": ["-y", "@golproductions/envie", "mcp"] } } }
```

Or for Claude Code:
```
claude mcp add envie -- npx -y @golproductions/envie mcp
```

</details>

---

## How It Works

```
┌─────────────┐     ┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│   WRITE     │ ──► │   RENDER    │ ──► │   VERIFY    │ ──► │    SEE      │
│             │     │             │     │             │     │             │
│ AI writes   │     │ Chrome films│     │ 6 gates     │     │ AI checks   │
│ HTML comp   │     │ frame by    │     │ machine-    │     │ frames at   │
│             │     │ frame       │     │ check video │     │ timestamps  │
└─────────────┘     └─────────────┘     └─────────────┘     └─────────────┘
```

### 1. Write

Your AI reads `envie_guide` and writes a composition: one self-contained HTML file with CSS animations, WebGL, Canvas, GIFs—whatever the browser can render.

### 2. Render

`envie_render` films it deterministically. Headless Chrome with a virtualized clock: `performance.now()`, `Date.now()`, `requestAnimationFrame`, `setTimeout`—all seeked frame by frame.

**Same composition = same video. Every time.**

### 3. Verify

Six gates machine-check the result before delivery:

| Gate | What it checks |
|------|----------------|
| **G1** | File exists, valid container, ≥2.9s duration |
| **G2** | Has both video and audio streams |
| **G3** | Audio isn't silent (mean > -50dB) |
| **G4** | No black segment > 2 seconds |
| **G5** | No freeze > 8 seconds, < 60% total still time |
| **G6** | Final 15% isn't dead (frozen or black) |

A failing video is **never delivered**. Your AI gets the report and fixes it.

### 4. See

`envie_see` returns frames at chosen timestamps so your AI can judge layout and pacing—not just whether the file exists.

### 5. Translate

`envie_translate` reads the finished file as data: per-frame motion, every cut and fade, still holds, LUFS, true peak, and how each audio hit sits against the nearest picture event.

---

## Requirements

| Requirement | Notes |
|-------------|-------|
| **Node 24+** | Or later |
| **Chrome** | Or set `ENVIE_CHROME` to your binary |
| **ffmpeg + ffprobe** | Must be on PATH |
| **Audio** | Required. Videos with no audio fail G2 and G3 |

### Audio options

| Option | Platform | Description |
|--------|----------|-------------|
| `--narration "text"` | Windows only | Local TTS voiceover (SAPI) |
| `--audio file.wav` | All platforms | Overlay any wav/mp3/m4a |

Runs entirely on your machine. Nothing reaches GOL servers.

---

## Formats

| Flag | Container | Codec |
|------|-----------|-------|
| `--format h264` | .mp4 | libx264 (default) |
| `--format h265` | .mp4 | libx265 10-bit |
| `--format prores` | .mov | ProRes 422 HQ 10-bit |
| `--format prores4444` | .mov | ProRes 4444 10-bit |
| `--format dnxhr` | .mov | DNxHR HQ |

---

## CLI

```
npx @golproductions/envie setup                          # register MCP server
envie render <comp.html> -o out.mp4 [options]            # render video
envie see    <comp.html|video.mp4> [--at 1000,4000]      # extract frames
envie verify <video.mp4>                                 # run gates
envie translate <video.mp4>                              # analyze motion/audio
envie guide                                              # print authoring guide
envie mcp                                                # start MCP server
```

### Render options

```
--narration "text"     # TTS voiceover (Windows)
--audio file.wav       # Overlay audio file
--fps 24               # Frame rate (default: 24)
--format h264          # Output codec
-o output.mp4          # Output path
```

---

## Composition Format

One self-contained HTML file:

```html
<!DOCTYPE html>
<html>
<head>
<style>
  body { margin: 0; width: 1080px; height: 1920px; overflow: hidden; }
  /* your animations */
</style>
</head>
<body data-duration-ms="15000" data-width="1080" data-height="1920">
  <!-- your content -->
</body>
</html>
```

### Required attributes

| Attribute | Description |
|-----------|-------------|
| `data-duration-ms` | Video length in milliseconds (3000–300000) |
| `data-width` | Canvas width (default: 1920) |
| `data-height` | Canvas height (default: 1080) |

### What's virtualized

Everything the browser can animate:
- CSS animations, transitions
- Web Animations API
- `requestAnimationFrame`
- `setTimeout`, `setInterval`
- Canvas 2D, WebGL
- `performance.now()`, `Date.now()`, `new Date()`
- Animated images (GIF, WebP, APNG, AVIF)
- `Math.random()`, `crypto.getRandomValues` (seeded)

**NOT virtualized** (avoid):
- Web Workers
- WebAudio-driven visuals

---

## Intent Assertions

Declare what the composition must achieve:

```html
<body data-duration-ms="12000"
      data-expect-sync-ms="120"
      data-expect-no-holds-longer-than="3">
```

| Assertion | Meaning |
|-----------|---------|
| `data-expect-sync-ms="120"` | Audio hits must land within 120ms of a picture event |
| `data-expect-no-holds-longer-than="3"` | No still hold may exceed 3 seconds |

Failures are reported test-style:

```
SYNC FAIL: mean audio-to-picture offset 380ms exceeds tolerance 120ms
HOLD FAIL: 2 hold(s) exceed 3s: 4.20s @0.40s, 3.10s @7.80s
```

---

## Deterministic Rendering

The render engine virtualizes time itself:

```javascript
// Inside the page during render:
performance.now()  // → virtual clock
Date.now()         // → virtual clock
new Date()         // → virtual clock
Math.random()      // → seeded PRNG

// Same seed, same composition = identical output
```

This is how the same HTML produces the same video, every render.

### What "deterministic" means

**Same machine + same Chrome version + same composition = bit-identical output.**

Cross-environment, you may see variation from:
- Font rendering (anti-aliasing, hinting differ by OS/GPU)
- WebGL/Canvas floating-point precision
- Chrome version changes
- System font fallbacks (embed fonts to avoid)

The guarantee is reproducibility on your machine, not cross-platform bit-identity. That's the right scope: your AI iterates locally, re-renders, gets the same result.

---

## Your Work Is Yours

GOL claims no ownership over your compositions or videos. Envie runs on your machine. Nothing you make reaches us.

---

## License

MIT. Free and open source. See [LICENSE](./LICENSE).

"Envie" and "GOL Productions" are trademarks. Forks must use a different name.

---

## GOL Productions

Envie is part of the [GOL Productions](https://golproductions.com) toolchain.

- **[Check](https://golproductions.com/check)** — Anti-hallucination layer for Claude Code
- **[Exnos](https://golproductions.com/exnos)** — Live browser verification

[Product page](https://golproductions.com/envie) · [GitHub](https://github.com/golproductions/envie)
