// Envie. Copyright (c) 2026 GOL Productions (https://golproductions.com). See LICENSE.
// Narration: local TTS to WAV.
// Windows: SAPI via PowerShell (no keys, no network). Other platforms: not yet.

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

function speak(text, outWav, voiceHint) {
  if (process.platform !== 'win32') throw new Error('local TTS currently supports Windows only');
  const clean = String(text).replace(/\s+/g, ' ').trim().slice(0, 4000);
  if (!clean) throw new Error('empty narration');
  const ps = `
Add-Type -AssemblyName System.Speech
$s = New-Object System.Speech.Synthesis.SpeechSynthesizer
${voiceHint ? `try { $s.SelectVoice("${voiceHint.replace(/"/g, '')}") } catch {}` : ''}
$s.Rate = 0
$s.SetOutputToWaveFile("${outWav.replace(/\\/g, '\\\\')}")
$s.Speak([IO.File]::ReadAllText("${'%TXT%'}"))
$s.Dispose()`;
  const txtFile = path.join(os.tmpdir(), 'envie-narration-' + Date.now() + '.txt');
  fs.writeFileSync(txtFile, clean, 'utf8');
  try {
    execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps.replace('%TXT%', txtFile.replace(/\\/g, '\\\\'))], { stdio: 'pipe', timeout: 120000, windowsHide: true });
  } finally {
    try { fs.unlinkSync(txtFile); } catch {}
  }
  if (!fs.existsSync(outWav) || fs.statSync(outWav).size < 1000) throw new Error('TTS produced no audio');
  return outWav;
}

module.exports = { speak };
