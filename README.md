# Envie

**AI video, verified.** Describe a video to your AI and get a real file back. Envie gives Claude Code and any MCP client a deterministic render engine: headless Chrome filmed frame by frame, six verification gates, and a full read-back layer. Free. No watermark. No account.

```
npx @golproductions/envie setup
```

That's it. It registers the MCP server with Claude Code automatically. Then ask your AI: *make me a 15-second vertical launch video for my app*

<details>
<summary>Manual install</summary>

Claude Code:
```
claude mcp add envie -- npx -y @golproductions/envie mcp
```

Any MCP client:
```json
{ "mcpServers": { "envie": { "command": "npx", "args": ["-y", "@golproductions/envie", "mcp"] } } }
```
</details>

---

## What happens

1. **Write.** Your AI reads `envie_guide` and writes a composition: one self-contained HTML file with CSS animations, WebGL, Canvas, GIFs -- whatever it needs.
2. **Render.** `envie_render` films it deterministically. Headless Chrome, every frame seeked with a virtualized clock. Same composition, same video, every time.
3. **Verify.** Six gates inspect the result: container, both streams, audible audio, no black segments, no freezes, no dead ending. A failing video is never delivered -- your AI gets the report and fixes it.
4. **See.** `envie_see` returns frames at chosen timestamps so your AI can judge layout and pacing, not just whether the file exists.
5. **Translate.** `envie_translate` reads the file back as data: per-frame motion, every cut and fade, still holds, LUFS, true peak, and how each audio hit sits against the nearest picture event.

## Requirements

- **Node 24** -- or later
- **Google Chrome** -- or set `ENVIE_CHROME` to your binary
- **ffmpeg + ffprobe** -- on PATH
- **Audio** -- a video with no audio fails G2 and G3
  - `--narration "text"` -- local TTS voiceover, Windows only (SAPI)
  - `--audio file.wav` -- lays over any wav/mp3/m4a, all platforms

Runs entirely on your machine. It never contacts GOL servers.

## Formats

| Flag | Container | Codec |
|------|-----------|-------|
| `--format h264` | .mp4 | libx264 (default) |
| `--format h265` | .mp4 | libx265 10-bit |
| `--format prores` | .mov | ProRes 422 HQ 10-bit |
| `--format prores4444` | .mov | ProRes 4444 10-bit |
| `--format dnxhr` | .mov | DNxHR HQ |

## CLI

```
npx @golproductions/envie setup                          # register MCP server in one step
envie render <composition.html> -o out.mp4  [--narration "text" | --audio file]
                                            [--fps N] [--format h264|h265|prores|prores4444|dnxhr]
envie see    <composition.html|video.mp4>   [--at 1000,4000] [-o dir]
envie verify <video.mp4>
envie translate <video.mp4>                 [-o dir]
envie guide
envie mcp
```

## Intent assertions

Compositions can declare what they intend to achieve. Envie checks them post-render and fails `verified` if they are missed.

```html
<body data-duration-ms="12000"
      data-expect-sync-ms="120"
      data-expect-no-holds-longer-than="3">
```

## Your work is yours

GOL claims no ownership over your compositions or the videos you render. Envie runs on your machine, and nothing you make with it reaches us.

## License

Free and open source. See [LICENSE](./LICENSE). The names "Envie" and "GOL Productions" are trademarks of GOL Productions. Forks must use a different name.

## GOL Productions

Envie is part of the [GOL Productions](https://golproductions.com) toolchain. See also [Check](https://golproductions.com/check), the anti-hallucination layer for Claude Code, and [Exnos](https://golproductions.com/exnos), live browser verification.

[Product page](https://golproductions.com/envie) · [GOL Productions](https://golproductions.com) · [GitHub](https://github.com/golproductions/envie)
