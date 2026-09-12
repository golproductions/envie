#!/usr/bin/env node
// Envie production build: source -> shipped artifact. Four stages:
//   1. esbuild   : bundle src/cli.cjs into one file, minified
//   2. obfuscate : control-flow flattening + string encoding
//   3. compile   : bytenode -> V8 bytecode (.jsc). No JS text ships at all.
//                  Bytecode is bound to the exact V8 line (see engines pin).
//   4. wrap      : thin loader (the ONLY readable file) with sha256 integrity
//                  lock on the bytecode core; a patched core refuses to load.
// Output: dist/envie.min.cjs (wrapper, bin entry) + dist/envie-core.jsc (opaque).
// Run: node build.cjs

const { execSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const DIST = path.join(ROOT, 'dist');
const TMP = path.join(DIST, '__bundle.tmp.cjs');
const OBF = path.join(DIST, '__obf.tmp.cjs');
const CORE = path.join(DIST, 'envie-core.jsc');
const WRAPPER = path.join(DIST, 'envie.min.cjs');

fs.mkdirSync(DIST, { recursive: true });

// 1. bundle (version baked in from package.json: serverInfo can never drift again)
const PKG = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const VERSION = PKG.version;
// The bytecode core (step 3) is ABI-locked to the V8 of the Node that compiles
// it. Bake THAT major into the wrapper so a wrong-Node user gets one sentence,
// not a bytenode stack trace. Fail the build if the building Node disagrees with
// the engines pin, so we can never ship a guard that demands the wrong version.
const REQ_NODE = process.versions.node.split('.')[0];
const ENGINE_MAJOR = ((PKG.engines && PKG.engines.node || '').match(/>=\s*(\d+)/) || [])[1];
if (ENGINE_MAJOR && ENGINE_MAJOR !== REQ_NODE) {
  throw new Error(`build Node is v${process.versions.node} but package.json engines pins >=${ENGINE_MAJOR}. Build on Node ${ENGINE_MAJOR} so the bytecode and the guard agree.`);
}
console.log(`[build] 1/5 bundling v${VERSION} (Node ${REQ_NODE} target)…`);
execSync(`npx esbuild "${path.join(ROOT, 'src/cli.cjs')}" --bundle --platform=node --minify --define:__ENVIE_VERSION__='"${VERSION}"' --outfile="${TMP}"`, { stdio: 'inherit', cwd: ROOT, windowsHide: true });

// esbuild keeps the source shebang at line 1; strip it, the wrapper owns the shebang
let bundle = fs.readFileSync(TMP, 'utf8').replace(/^#![^\n]*\n/, '');
fs.writeFileSync(TMP, bundle);

// 2. obfuscate
// (self-defending is OFF: it asserts on its own Function.toString(), which
//  bytenode replaces with dummy source. Bytecode is the stronger lock anyway.)
console.log('[build] 2/5 obfuscating…');
execSync(`npx javascript-obfuscator "${TMP}" --output "${OBF}" ` +
  '--compact true --self-defending false --control-flow-flattening true --control-flow-flattening-threshold 0.75 ' +
  '--dead-code-injection true --dead-code-injection-threshold 0.2 ' +
  '--string-array true --string-array-encoding base64 --string-array-threshold 1 ' +
  '--string-array-rotate true --string-array-shuffle true ' +
  '--identifier-names-generator hexadecimal --rename-globals false ' +
  '--disable-console-output false --debug-protection false --target node',
  { stdio: 'inherit', cwd: ROOT, windowsHide: true });
fs.unlinkSync(TMP);

// 3. compile to V8 bytecode: no JS text in the shipped core
console.log('[build] 3/5 compiling to bytecode…');
const bytenode = require('bytenode');
bytenode.compileFile({ filename: OBF, output: CORE, compileAsModule: true });
fs.unlinkSync(OBF);
// stale text core from the pre-bytecode pipeline must not ship alongside
const oldCore = path.join(DIST, 'envie-core.cjs');
if (fs.existsSync(oldCore)) fs.unlinkSync(oldCore);

// 4. wrap: thin loader with integrity lock on the bytecode
console.log('[build] 4/5 wrapping…');
const hash = crypto.createHash('sha256').update(fs.readFileSync(CORE)).digest('hex');
fs.writeFileSync(WRAPPER, `#!/usr/bin/env node
// Envie. Type into your AI. Get a verified video. golproductions.com/envie
var _n=process.versions.node,_m=+_n.split('.')[0];
if(_m!==${REQ_NODE}){console.error('[envie] Envie needs Node ${REQ_NODE}. You are on Node '+_n+'. Install Node ${REQ_NODE} from https://nodejs.org, then run this again.');process.exit(1);}
const c=require('path').join(__dirname,'envie-core.jsc');
const b=require('fs').readFileSync(c);
if(require('crypto').createHash('sha256').update(b).digest('hex')!=='${hash}'){console.error('[envie] integrity check failed: core has been modified. Reinstall: npx @golproductions/envie');process.exit(1);}
require('bytenode');
require(c);
`);

// 5. smoke test the shipped artifact
console.log('[build] 5/5 smoke test…');
const out = execSync(`node "${WRAPPER}" guide`, { encoding: 'utf8', cwd: ROOT, windowsHide: true });
if (!out.includes('ENVIE AUTHORING CONTRACT')) throw new Error('smoke test FAILED: guide did not answer');

const kb = n => (fs.statSync(n).size / 1024).toFixed(1) + 'kb';
console.log(`[build] OK  wrapper ${kb(WRAPPER)} | core ${kb(CORE)} | sha256 ${hash.slice(0, 16)}…`);
