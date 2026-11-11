// The docs playtest: every JavaScript snippet of the quickstart runs as written, headless, against a Hawkes Net service,
// and each prints what its step says "You should see". Then every link on the quickstart and the API reference is
// followed (same site: one fetch, must answer 200; other hosts: must be on the Hawkes list, https). Fails naming the
// snippet or the link. Phone size and the screenshots are the demo's `site` scenario (public/site-playtest.mjs), which
// also runs a live Ada/Bob join of the same steps so Studio's footage shows them.
//
//   node tools/docs-playtest.mjs --url https://hawkesnet.hawkesgen.ai --key $HAWKESGEN_KEY    (beta's free test project)
//   node tools/docs-playtest.mjs --url http://127.0.0.1:8796                                  (a dev service trusts localhost)
//   --page <file>   read the quickstart from a file instead of <url>/quickstart
//
// No dependencies; the snippets import '@hawkesgen/net', which is made here as a folder that points at sdk/js.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  PROJECT_HOSTS, GITHUB_PREFIX, readSteps, planRuns, diffLines, judgeOutside, judgeLinks,
} from '../public/docs-snippets.mjs';

export { PROJECT_HOSTS, GITHUB_PREFIX, readSteps, planRuns, diffLines, judgeOutside, judgeLinks };

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** A folder to run snippets in: node_modules/@hawkesgen/net is a copy of sdk/js, and preload.mjs points the SDK at `url`. */
export function makeSandbox(url) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hn-docs-'));
  const pkg = path.join(dir, 'node_modules', '@hawkesgen', 'net');
  fs.mkdirSync(pkg, { recursive: true });
  for (const f of ['hawkes-net.mjs', 'hawkes-net-core.mjs', 'hawkes-net.d.ts', 'package.json']) fs.copyFileSync(path.join(ROOT, 'sdk', 'js', f), path.join(pkg, f));
  fs.writeFileSync(path.join(dir, 'package.json'), '{"type":"module"}');
  fs.writeFileSync(path.join(dir, 'preload.mjs'), `globalThis.HAWKES_NET_ENDPOINT = ${JSON.stringify(url)};\n`);
  return dir;
}

/** Starts `node first-room.mjs <name>`; resolves { lines(), stderr(), done, stop() }. */
function start(dir, file, name, env) {
  const child = spawn(process.execPath, ['--import', './preload.mjs', file, name], { cwd: dir, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '', err = '', code = null;
  child.stdout.on('data', (d) => { out += d; }); child.stderr.on('data', (d) => { err += d; });
  const done = new Promise((r) => child.on('close', (c) => { code = c; r(c); }));
  return { lines: () => out.split('\n').filter(Boolean), stderr: () => err.trim(), code: () => code, done, stop: () => { if (code === null) child.kill(); return done; } };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms) { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (fn()) return true; await sleep(100); } return fn(); }
const why = (p) => (p.stderr() ? ` (stderr: ${p.stderr().split('\n').slice(0, 3).join(' | ').slice(0, 300)})` : '');

/**
 * Runs the plan against `url`. `report(name, ok, detail)` gets one line per snippet; returns true when all passed.
 * A snippet that waits 30 s is stopped as soon as its output has arrived and a short quiet time has shown nothing else.
 */
export async function runSnippets(plan, { url, key, report, timeout = 25000, quiet = 1500 }) {
  const dir = makeSandbox(url);
  const env = { HAWKESGEN_KEY: key ?? '' };
  if (!key) delete env.HAWKESGEN_KEY;
  let okAll = true;
  const judge = (name, ok, detail) => { okAll &&= ok; report(name, ok, detail); };
  try {
    // Step 3: runs to the end by itself.
    fs.writeFileSync(path.join(dir, 'connect.mjs'), plan.connect.script);
    {
      const p = start(dir, 'connect.mjs', 'Ada', env);
      const ended = await Promise.race([p.done.then(() => true), sleep(timeout).then(() => false)]);
      if (!ended) { await p.stop(); judge(plan.connect.name, false, `did not finish in ${timeout / 1000} s${why(p)}`); }
      else { const d = diffLines(plan.connect.expected, p.lines()); judge(plan.connect.name, !d && p.code() === 0, d || (p.code() ? `exit ${p.code()}${why(p)}` : `printed ${p.lines().join(' / ')}`)); }
    }
    // Steps 4 and 5: Ada waits, Bob joins; both stay until their output has come.
    fs.writeFileSync(path.join(dir, 'first-room.mjs'), plan.room.script);
    const ada = start(dir, 'first-room.mjs', 'Ada', env);
    const first = await until(() => ada.lines().length >= plan.room.expected.length || ada.code() !== null, timeout);
    await sleep(quiet);
    { const d = diffLines(plan.room.expected, ada.lines()); judge(plan.room.name, first && !d, first ? d || `printed ${ada.lines().join(' / ')}` : `no output in ${timeout / 1000} s${why(ada)}`); }
    const bob = start(dir, 'first-room.mjs', 'Bob', env);
    const s = plan.second;
    const gotAll = await until(() => ada.lines().length >= s.adaExpected.length && bob.lines().length >= s.bobExpected.length, timeout);
    await sleep(quiet);
    const dA = diffLines(s.adaExpected, ada.lines()), dB = diffLines(s.bobExpected, bob.lines());
    const bad = [dA && `Ada's terminal ${dA}`, dB && `Bob's terminal ${dB}`].filter(Boolean).join('; ');
    judge(s.name, gotAll && !bad, bad || (gotAll ? 'both terminals print what the step says' : `not complete in ${timeout / 1000} s${why(ada)}${why(bob)}`));
    await Promise.all([ada.stop(), bob.stop()]);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  return okAll;
}

export async function main(argv = process.argv.slice(2)) {
  const arg = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d; };
  const url = String(arg('url', process.env.NET_URL ?? 'http://127.0.0.1:8796')).replace(/\/+$/, '');
  const key = arg('key', process.env.HAWKESGEN_KEY);
  const lines = []; let failed = 0;
  const report = (name, ok, detail = '') => { if (!ok) failed++; lines.push(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` - ${detail}` : ''}`); console.log(lines.at(-1)); };
  const get = async (p) => { const r = await fetch(url + p); if (!r.ok) throw new Error(`${p} answered ${r.status}`); return r.text(); };
  const file = arg('page');
  let html;
  try { html = file ? fs.readFileSync(file, 'utf8') : await get('/quickstart'); } catch (e) { report('quickstart: read the page', false, e.message); process.exitCode = 1; return 1; }
  try { await runSnippets(planRuns(readSteps(html)), { url, key, report: (n, ok, d) => report(`snippet ${n}`, ok, d) }); }
  catch (e) { report('snippets: read the quickstart', false, e.message); }
  for (const p of ['/quickstart', '/docs/api']) {
    try {
      const page = p === '/quickstart' && file ? html : await get(p);
      const { broken, total } = await judgeLinks(page, { pageUrl: url + p, origin: url, fetchFn: (u, i) => fetch(u, i) });
      if (broken.length) for (const b of broken) report(`link ${b.href} on ${p}`, false, b.why);
      else report(`links of ${p}`, true, `${total} links, none broken`);
    } catch (e) { report(`links of ${p}`, false, e.message); }
  }
  process.exitCode = failed ? 1 : 0;
  console.log(failed ? `${failed} FAILED` : 'docs playtest passed');
  return failed;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
