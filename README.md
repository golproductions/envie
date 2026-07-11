# Envie

**Type into your AI. Get a video.**

Describe a video to your AI and get a real, verified video file back. Envie plugs into Claude Code, Cursor, or any MCP client, renders what your AI designs frame by frame, and runs the result through six verification gates before you see it. 3 free renders a day, then $3.00 AUD per video.

Built by [GOL Productions](https://golproductions.com), on the same conviction as [Check](https://golproductions.com/check.html): never trust unverified AI output.

## Install

```
claude mcp add envie -- npx -y @golproductions/envie mcp
```

Or in any MCP config (Cursor, Windsurf, anything that speaks MCP):

```json
{ "mcpServers": { "envie": { "command": "npx", "args": ["-y", "@golproductions/envie", "mcp"] } } }
```

Then just ask your AI:

> make me a 15 second vertical launch video for my app

## What happens

1. Your AI reads the authoring contract (`envie_guide`) and writes a composition: one self-contained HTML file. Any design, any motion, any format. No templates, no stock footage.
2. `envie_render` films it deterministically: headless Chrome, every animation seeked frame-by-frame, encoded with ffmpeg. Landscape, vertical (TikTok/Reels/Shorts), or square, up to 4K and 60fps. Delivers H.264 by default, or broadcast-grade H.265, ProRes 422 HQ / 4444, and DNxHR via `--format`. Narrated voiceover in sync.
3. Six verification gates inspect the result before you ever see it: real container, both streams, audible audio, no black segments, no freezes, no dead endings. A failing video is never handed over. Your AI gets the gate report and fixes it, the same loop you already use for code.
4. `envie_translate` reads the finished video back in full. It walks every frame and the whole audio track and turns the file into things an AI can actually judge: per-frame motion, integrated loudness and true peak, the timestamp of every audio hit, and how far each hit sits from the moment its on-screen content lands. It returns a spectrogram, a motion-vs-sound timeline, and a whole-film contact sheet, plus a self-contained HTML report. It does not pretend to hear or to watch: it translates every fact of both into a number or an image, and leaves taste to you.

## Requirements

- Node 24
- Google Chrome installed (or set `ENVIE_CHROME` to your Chrome binary)
- ffmpeg on PATH
- Local voiceover currently supports Windows (SAPI). Other platforms: bring your own audio.

## Free vs Pro

Free renders are full quality and fully verified, and carry a "Made with Envie" mark. Every machine gets 3 free renders a day.

Watermark-free renders are metered: **$3 AUD per video**, billed to your GOL account wallet at [golproductions.com/envie](https://golproductions.com/envie). Add funds with Stripe in the console ($9 AUD covers three clean videos). Out of funds, you fall back to the free tier: 3 watermarked renders a day.

Set your key once and render clean:

```
claude mcp add envie -e ENVIE_LICENSE_KEY=gol_yourkey -- npx -y @golproductions/envie mcp
```

Keys are validated server-side on every render; billing is never client-side.

## CLI

```
envie render <composition.html> -o out.mp4 [--narration "text"] [--voice NAME] [--fps N] [--format h264|h265|prores|prores4444|dnxhr]
envie verify <video.mp4>
envie translate <video.mp4> [-o dir]
envie guide
envie mcp
envie install
```

## License

Proprietary. Free to install and use; the source may not be modified, redistributed, or used to build competing services. See [terms](https://golproductions.com/terms.html).

---

Envie is built on Check. [Deterministic gates for AI.](https://golproductions.com)
