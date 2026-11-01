// Hawkes Net's build (npm run build): what a version of Hawkes Net ships, in dist/. Hawkes Studio runs it as the
// project's "release" build (tool npm, after npm ci, the typecheck and the tests) on each push to beta, and publishes
// dist/ on the project's beta site, so every beta commit has its SDK files and packages at one address.
// The service itself is not built: each box runs src/ with Node 24 and deploys its own branch (deploy/pull.mjs).
//
//   dist/index.html                   what this build is: the versions, the commit, the files
//   dist/release.json                 { service, sdk, protocol, unity, commit, builtAt }
//   dist/sdk/hawkes-net.mjs, hawkes-net-core.mjs, hawkes-net.d.ts (and the @1 names): as the service serves them at /sdk/
//   dist/sdk/hawkesgen-net-<v>.tgz    @hawkesgen/net packed (what tools/release-js.mjs publishes to hawkesnet-js)
//   dist/sdk/com.hawkes.net-<v>.tgz   the Unity package copy (sdk/unity), as /sdk/com.hawkes.net.tgz serves it
//
// It fails when the versions disagree: the core's VERSION, sdk/js/package.json and package.json move together.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { packageTarball } from '../src/tarball.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'dist');
const SDK = path.join(ROOT, 'sdk', 'js');
const UNITY = path.join(ROOT, 'sdk', 'unity', 'com.hawkes.net');
const read = (f) => fs.readFileSync(f, 'utf8');
const json = (f) => JSON.parse(read(f));

const service = json(path.join(ROOT, 'package.json')).version;
const sdkPkg = json(path.join(SDK, 'package.json'));
const core = read(path.join(SDK, 'hawkes-net-core.mjs'));
const coreVersion = core.match(/export const VERSION = '([^']+)'/)?.[1];
const protocol = Number(core.match(/export const PROTOCOL = (\d+)/)?.[1]);
const unity = json(path.join(UNITY, 'package.json')).version;
const problems = [];
if (coreVersion !== sdkPkg.version) problems.push(`sdk/js/hawkes-net-core.mjs VERSION is ${coreVersion}, sdk/js/package.json says ${sdkPkg.version}: bump both together`);
if (service !== sdkPkg.version) problems.push(`package.json is ${service}, the SDK is ${sdkPkg.version}: keep them the same`);
if (problems.length) { for (const p of problems) console.error(`build: ${p}`); process.exit(1); }

let commit = process.env.HAWKES_COMMIT || process.env.GITHUB_SHA || '';
if (!commit) try { commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim(); } catch { commit = 'unknown'; }

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(path.join(OUT, 'sdk'), { recursive: true });
const files = [];
const put = (name, body) => { fs.writeFileSync(path.join(OUT, name), body); files.push({ name, bytes: Buffer.byteLength(body) }); };

// The SDK as the service serves it (src/api.ts: /sdk/hawkes-net.mjs, /sdk/hawkes-net@1.mjs, the core, the types).
const major = sdkPkg.version.split('.')[0];
for (const [from, names] of [
  ['hawkes-net.mjs', ['hawkes-net.mjs', `hawkes-net@${major}.mjs`]],
  ['hawkes-net-core.mjs', ['hawkes-net-core.mjs', `hawkes-net-core@${major}.mjs`]],
  ['hawkes-net.d.ts', ['hawkes-net.d.ts']],
]) { const body = fs.readFileSync(path.join(SDK, from)); for (const n of names) put(`sdk/${n}`, body); }

// @hawkesgen/net packed, exactly the files its package.json lists.
const packed = execFileSync('npm', ['pack', '--json', '--pack-destination', path.join(OUT, 'sdk')], { cwd: SDK, encoding: 'utf8' });
const tgz = JSON.parse(packed)[0].filename.replace(/^@/, '').replace('/', '-');
files.push({ name: `sdk/${tgz}`, bytes: fs.statSync(path.join(OUT, 'sdk', tgz)).size });

// The Unity package copy, as the /sdk/com.hawkes.net.tgz download makes it.
put(`sdk/com.hawkes.net-${unity}.tgz`, packageTarball(UNITY).body);

const release = { service, sdk: sdkPkg.version, protocol, unity, commit, builtAt: new Date().toISOString() };
put('release.json', JSON.stringify(release, null, 2) + '\n');

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const rows = files.map((f) => `<tr><td><a href="${esc(f.name)}">${esc(f.name)}</a></td><td>${(f.bytes / 1024).toFixed(1)} KB</td></tr>`).join('\n');
put('index.html', `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Hawkes Net ${esc(service)} build</title>
<style>body{font:15px/1.5 system-ui,sans-serif;max-width:46rem;margin:2rem auto;padding:0 1rem;color:#1d1d1f}
td{padding:.2rem 1rem .2rem 0}code{background:#f2f2f2;padding:0 .3rem;border-radius:3px}</style></head>
<body><h1>Hawkes Net ${esc(service)}</h1>
<p>Service ${esc(service)}, SDK <code>@hawkesgen/net</code> ${esc(sdkPkg.version)} (protocol ${esc(protocol)}),
Unity package copy <code>com.hawkes.net</code> ${esc(unity)}. Commit <code>${esc(commit.slice(0, 12))}</code>.</p>
<p>The service runs on its own boxes: beta at <a href="https://hawkesnet.hawkesgen.ai">hawkesnet.hawkesgen.ai</a>,
live at <a href="https://net.hawkesgen.ai">net.hawkesgen.ai</a>. These are the files this commit ships.</p>
<table>${rows}</table>
</body></html>
`);

console.log(`build: Hawkes Net ${service} (sdk ${sdkPkg.version}, protocol ${protocol}, unity copy ${unity}) at ${commit.slice(0, 12)} -> dist/ (${files.length} files)`);
