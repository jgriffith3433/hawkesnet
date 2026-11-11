// The docs playtest: every JavaScript snippet of the quickstart runs as written, headless, against a Hawkes Net service,
// and each prints what its step says "You should see". Then every link on the quickstart and the API reference is
// followed (same site: one fetch, must answer 200; other hosts: must be on the Hawkes list, https). Fails naming the
// snippet or the link. Phone size and the screenshots are the demo's `site` scenario (public/site-playtest.mjs).
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
import { checkLinks, classifyLink, extractLinks } from '../public/landing-playtest.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const PROJECT_HOSTS = ['hawkesgen.ai', 'hawkesgames.com'];            // and their subdomains
export const GITHUB_PREFIX = '/jgriffith3433/hawkesnet';                    // hawkesnet-js, -babylon, -unity
const unescapeHtml = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
const stripTags = (s) => s.replace(/<[^>]+>/g, '');
const codeOf = (pre) => unescapeHtml(stripTags(pre.replace(/^<pre[^>]*>\s*<code>/, '').replace(/<\/code>\s*<\/pre>$/, ''))).replace(/\n$/, '');

/**
 * The JavaScript tab's steps: [{ id, title, pres: [{ id, code, expect }] }] in page order. A <pre> inside `.expect` is expected
 * output; the other <pre>s are code. Reads the panel with id panel-js, each <li class="step">.
 */
export function readSteps(html, panel = 'js') {
  const p = html.match(new RegExp(`<section[^>]*id="panel-${panel}"[\\s\\S]*?</section>`));
  if (!p) throw new Error(`the quickstart has no ${panel} panel`);
  const steps = [];
  for (const m of p[0].matchAll(/<li class="step" id="([^"]+)">\s*<h2>([\s\S]*?)<\/h2>([\s\S]*?)<\/li>/g)) {
    const body = m[3];
    const at = body.indexOf('<div class="expect">');
    const pres = [];
    for (const pm of body.matchAll(/<pre\b([^>]*)>[\s\S]*?<\/pre>/g)) {
      pres.push({ id: /id="([^"]+)"/.exec(pm[1])?.[1] ?? '', code: codeOf(pm[0]), expect: at >= 0 && pm.index > at });
    }
    steps.push({ id: m[1], title: stripTags(m[2]).trim(), pres });
  }
  return steps;
}

/** The runs of the JS tab: each { name, step, script, expected: [lines] }, plus the two-player run of the last step. */
export function planRuns(steps) {
  const by = Object.fromEntries(steps.map((s) => [s.id, s]));
  const need = (id) => { if (!by[id]) throw new Error(`the quickstart's JavaScript tab has no step "${id}"`); return by[id]; };
  const connect = need('js-connect'), room = need('js-room'), second = need('js-second');
  const code = (s, why) => { const x = s.pres.find((q) => !q.expect && /\bimport\b/.test(q.code)); if (!x) throw new Error(`step "${s.title}" (${s.id}) has no ${why} snippet`); return x.code; };
  const outs = (s) => s.pres.filter((q) => q.expect).map((q) => q);
  const first = (s) => { const o = outs(s)[0]; if (!o) throw new Error(`step "${s.title}" (${s.id}) shows no output to expect`); return o.code.split('\n').filter(Boolean); };
  const ada = second.pres.find((q) => q.id === 'expect-node-ada'), bob = second.pres.find((q) => q.id === 'expect-node-bob');
  if (!ada || !bob) throw new Error(`step "${second.title}" (${second.id}) does not show Ada's and Bob's output`);
  return {
    connect: { name: `${connect.id} "${connect.title}"`, script: code(connect, 'runnable'), expected: first(connect) },
    room: { name: `${room.id} "${room.title}"`, script: code(room, 'runnable'), expected: first(room) },
    second: { name: `${second.id} "${second.title}"`, adaExpected: ada.code.split('\n').filter(Boolean), bobExpected: bob.code.split('\n').filter(Boolean) },
  };
}

/** Does `got` (stdout lines) equal `want`, in any order? Returns '' when it does, else what differs. */
export function diffLines(want, got) {
  const miss = [...want], extra = [];
  for (const l of got) { const i = miss.indexOf(l); if (i >= 0) miss.splice(i, 1); else extra.push(l); }
  return [miss.length ? `missing: ${miss.map((l) => `"${l}"`).join(', ')}` : '', extra.length ? `unexpected: ${extra.map((l) => `"${l}"`).join(', ')}` : ''].filter(Boolean).join('; ');
}

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

/** An outside link must go to a Hawkes host (or the hawkesnet repositories on GitHub), over https. Returns '' or why not. */
export function judgeOutside(href, pageUrl, origin) {
  const c = classifyLink(href, pageUrl, origin);
  if (c.kind !== 'outside') return '';
  if (!c.secure) return 'plain http';
  if (PROJECT_HOSTS.some((h) => c.host === h || c.host.endsWith(`.${h}`))) return '';
  if (c.host === 'github.com' && new URL(c.url).pathname.startsWith(GITHUB_PREFIX)) return '';
  return `off the Hawkes Net site (${c.host})`;
}

/** Every link of one page: same-site ones must answer 200, outside ones must be on the Hawkes list. Returns [{ href, why }] of the broken. */
export async function judgeLinks(html, { pageUrl, origin, fetchFn }) {
  const out = await checkLinks(html, { pageUrl, origin, fetchFn });
  const broken = out.failed.map((r) => ({ href: r.href, why: r.why }));
  for (const r of out.results) { const w = r.kind === 'outside' ? judgeOutside(r.href, pageUrl, origin) : ''; if (w) broken.push({ href: r.href, why: w }); }
  // 200 exactly: a redirect that checkLinks followed is fine only when the final answer is ok, which it already requires.
  return { broken, total: out.counts.total };
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
