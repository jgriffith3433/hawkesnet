// /demo's site checks (public/site-playtest.mjs): the status and version, every link on /home, the docs and the quickstart,
// the shared header and a Copy button on every code block. Run here with a fake fetch and a fake page reader; the browser
// parts (the frame) are what Studio's playtest of /demo shows. Wiring: demo.html adds the scenario and ends smoke with the checks.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const m = await import('../public/site-playtest.mjs');
const { startTestHub } = await import('./helper.ts');
const hub = await startTestHub();
after(async () => { await hub.stop(); });

const ORIGIN = 'https://net.example';
const GOOD_PHONE = { width: 390, scrollWidth: 390, menuShown: true, navHiddenBefore: true, navShownAfter: true, expandedAfter: true, minFont: 13, wideBlocks: 0 };
const GOOD_HEADER = ['Home', 'Docs', 'Quickstart', 'Demo'].map((text, i) => ({ text, path: ['/', '/docs/api', '/quickstart', '/demo'][i] }));

test('judgeStatus: ok or degraded with a version', () => {
  assert.deepEqual(m.judgeStatus({ health: 'ok', version: '1.4.0' }).parts, [1, 4, 0]);
  assert.equal(m.judgeStatus({ health: 'degraded', version: '1.4' }).health, 'degraded');
  assert.equal(m.judgeStatus({ up: true, version: '2.0.1' }).health, 'ok');
  assert.throws(() => m.judgeStatus({ health: 'down', version: '1.4.0' }), /wanted ok or degraded/);
  assert.throws(() => m.judgeStatus({ health: 'ok', version: '' }), /not a version/);
});

test('judgeHeader and judgeCopy say what is missing', () => {
  assert.match(m.judgeHeader(GOOD_HEADER), /Home \/, Docs \/docs\/api, Quickstart \/quickstart, Demo \/demo/);
  assert.equal(m.judgeHeader([{ text: 'Home', path: '/home' }, ...GOOD_HEADER.slice(1)]).startsWith('Home /home'), true);
  assert.throws(() => m.judgeHeader([]), /no shared header/);
  assert.throws(() => m.judgeHeader(GOOD_HEADER.slice(0, 3)), /no "Demo" link/);
  assert.throws(() => m.judgeHeader(GOOD_HEADER.map((l) => (l.text === 'Docs' ? { ...l, path: '/nope' } : l))), /Docs goes to \/nope/);
  assert.match(m.judgeCopy([{ copy: 1 }, { copy: 1 }]), /2 code blocks/);
  assert.throws(() => m.judgeCopy([]), /no code block/);
  assert.throws(() => m.judgeCopy([{ copy: 1 }, { copy: 0 }]), /1 of 2 code blocks without/);
});

/** Runs siteChecks with a fake service; returns the checks (name -> { ok, why }), the metrics and the fetched addresses. */
async function runChecks(opts: { status?: unknown; pages?: Record<string, string>; read?: (p: string) => Promise<unknown>; phoneRead?: (p: string) => Promise<unknown> } = {}) {
  const fetched: string[] = [];
  const pages: Record<string, string> = opts.pages ?? {
    '/home': '<a href="/docs/api">d</a><a href="/quickstart">q</a><a href="https://github.com/x">g</a>',
    '/docs/api': '<a href="/home">h</a><a href="#a">a</a><h2 id="a">a</h2>',
    '/quickstart': '<a href="/demo">d</a><a href="/dashboard#key">k</a><a href="mailto:support@hawkesgen.ai">m</a>',
  };
  const fetchFn = async (url: string) => {
    fetched.push(url);
    const p = url.slice(ORIGIN.length);
    if (p === '/v1/net/status') return { ok: true, status: 200, json: async () => opts.status ?? { health: 'ok', version: '1.4.0' }, body: { cancel: async () => {} } };
    const html = pages[p];
    return { ok: html !== undefined || ['/demo', '/dashboard'].includes(p), status: html !== undefined || ['/demo', '/dashboard'].includes(p) ? 200 : 404, text: async () => html ?? '', body: { cancel: async () => {} } };
  };
  const lines: Record<string, { ok: boolean; why: string }> = {};
  const metrics: Record<string, number> = {};
  const check = async (name: string, fn: () => Promise<string | void>) => {
    try { lines[name] = { ok: true, why: String(await fn() ?? '') }; } catch (e) { lines[name] = { ok: false, why: String((e as Error).message) }; }
  };
  const read = opts.read ?? (async () => ({ header: GOOD_HEADER, blocks: [{ copy: 1 }] }));
  await m.siteChecks({ check, metric: (k: string, v: number) => { metrics[k] = v; }, origin: ORIGIN, fetchFn, read: read as never, phoneRead: (opts.phoneRead ?? (async () => GOOD_PHONE)) as never });
  return { lines, metrics, fetched };
}

test('siteChecks: a healthy site passes every check and reports status, version and links in metrics', async () => {
  const { lines, metrics, fetched } = await runChecks();
  assert.equal(Object.keys(lines).length, 1 + 3 * 3 + 4, 'status, links, header and copy for each of home, docs and quickstart, and four phone-size checks');
  for (const [name, l] of Object.entries(lines)) assert.ok(l.ok, `${name}: ${l.why}`);
  assert.match(lines['Status and version: the service is ok or degraded and has a version'].why, /status ok, version 1\.4\.0/);
  assert.deepEqual([metrics.status, metrics.versionMajor, metrics.versionMinor, metrics.versionPatch], [1, 1, 4, 0]);
  assert.equal(metrics.homeLinks, 3); assert.equal(metrics.docsLinks, 2); assert.equal(metrics.quickstartLinks, 3);
  assert.equal(metrics.quickstartLinksBroken, 0);
  assert.equal(metrics.docsCodeBlocks, 1); assert.equal(metrics.quickstartHeader, 1);
  assert.equal(fetched.filter((u) => u.endsWith('/v1/net/status')).length, 1, 'the status is read once');
  assert.ok(!fetched.some((u) => u.includes('github.com')), 'outside links are not opened');
  for (const u of new Set(fetched)) assert.equal(fetched.filter((x) => x === u).length <= 3, true);
});

test('siteChecks: a broken link, a missing header, a block without Copy and a down service each fail their own check', async () => {
  const bad = await runChecks({
    status: { health: 'down', version: '1.4.0' },
    pages: { '/home': '<a href="/gone">x</a>', '/docs/api': '<a href="/home">h</a>', '/quickstart': '<a href="/home">h</a>' },
    read: async (p) => (p === '/docs/api' ? { header: [], blocks: [{ copy: 1 }] } : p === '/quickstart' ? { header: GOOD_HEADER, blocks: [{ copy: 0 }] } : { header: GOOD_HEADER, blocks: [{ copy: 1 }] }),
  });
  const failed = Object.entries(bad.lines).filter(([, l]) => !l.ok).map(([n]) => n);
  assert.deepEqual(failed, ['Status and version: the service is ok or degraded and has a version', 'Home (/home): every link works', 'Docs (/docs/api): the shared header has Home, Docs, Quickstart and Demo', 'Quickstart (/quickstart): every code block has a Copy button']);
  assert.match(bad.lines['Home (/home): every link works'].why, /\/gone/);
  assert.equal(bad.metrics.homeLinksBroken, 1);
});

test('siteChecks: a page that will not open fails its header and Copy checks with the reason', async () => {
  const r = await runChecks({ read: async () => { throw new Error('/home did not load in 20 s'); } });
  assert.match(r.lines['Home (/home): the shared header has Home, Docs, Quickstart and Demo'].why, /did not load/);
  assert.equal(r.lines['Home (/home): every link works'].ok, true);
});

test('addSiteScenario: the contract lists site, runs it, reports metrics; other scenarios go to the original', async () => {
  const calls: string[] = [];
  const api: any = { scenarios: () => [{ id: 'smoke' }], start: async (id: string) => { calls.push(id); }, state: () => ({ ready: true, status: 'idle' }), report: () => null, stop: () => {} };
  const fetchFn = async (url: string) => {
    const p = url.slice(ORIGIN.length);
    if (p === '/v1/net/status') return { ok: true, status: 200, json: async () => ({ health: 'degraded', version: '1.5.2' }), body: null };
    return { ok: true, status: 200, text: async () => '<a href="/demo">d</a>', body: null };
  };
  (globalThis as any).location = { origin: ORIGIN, host: 'net.example' };
  m.addSiteScenario(api, { origin: ORIGIN, fetchFn, read: async () => ({ header: GOOD_HEADER, blocks: [{ copy: 1 }] }), phoneRead: async () => GOOD_PHONE, where: 'net.example' });
  assert.deepEqual(api.scenarios().map((s: any) => s.id), ['smoke', 'site']);
  await api.start('smoke');
  assert.deepEqual(calls, ['smoke']);
  await api.start('site');
  assert.deepEqual(calls, ['smoke'], 'site did not go to the original');
  const st = api.state();
  assert.equal(st.status, 'won');
  assert.match(st.note, /status degraded, version 1\.5\.2/);
  const rep = api.report();
  assert.equal(rep.scenario, 'site'); assert.equal(rep.outcome, 'won'); assert.equal(rep.problems.length, 0);
  assert.equal(rep.metrics.status, 0.5); assert.equal(rep.metrics.checksFailed, undefined);
  assert.ok(rep.log.some((l: string) => l.startsWith('PASS Quickstart')));
  delete (globalThis as any).location;
});

test('the demo page wires the site scenario and ends smoke with the checks; the shared bot file is untouched; the hub serves the module', async () => {
  const html = fs.readFileSync(new URL('../public/demo.html', import.meta.url), 'utf8');
  assert.match(html, /addSiteScenario\(playtest\)/);
  assert.match(html, /await siteChecks\(/);
  assert.ok(html.indexOf('await peerChecks(c)') < html.indexOf('await siteChecks('), 'the site checks come after the peer checks, at the end of smoke');
  assert.doesNotMatch(fs.readFileSync(new URL('../public/demo-playtest.mjs', import.meta.url), 'utf8'), /site-playtest|siteChecks/);
  const src = fs.readFileSync(new URL('../public/site-playtest.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /setInterval/);
  const r = await fetch(`${hub.url}/site-playtest.mjs`);
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type') ?? '', /javascript/);
});

test('judgePhone: passes a folded, readable page and names what is wrong otherwise', async () => {
  const m = await import('../public/site-playtest.mjs');
  assert.match(m.judgePhone(GOOD_PHONE), /no sideways scroll/);
  assert.throws(() => m.judgePhone({ ...GOOD_PHONE, scrollWidth: 520 }), /scrolls sideways/);
  assert.throws(() => m.judgePhone({ ...GOOD_PHONE, menuShown: false }), /no Menu/);
  assert.throws(() => m.judgePhone({ ...GOOD_PHONE, navHiddenBefore: false }), /not folded/);
  assert.throws(() => m.judgePhone({ ...GOOD_PHONE, navShownAfter: false }), /did not open/);
  assert.throws(() => m.judgePhone({ ...GOOD_PHONE, minFont: 10 }), /too small|as small as 10/);
  assert.throws(() => m.judgePhone({ ...GOOD_PHONE, wideBlocks: 2 }), /scroll inside/);
});

test('addInputEvents: the page reports a tap or drag, and the run\'s report carries it in order with the bot\'s events', async () => {
  let started = 0;
  const api: any = { start: async () => { started++; }, report: () => ({ scenario: 'smoke', seconds: 2, events: [{ t: 0, type: 'start' }, { t: 3, type: 'finish', detail: 'won' }], problems: [] }) };
  const note = m.addInputEvents(api);
  note('drag', 'from the run that began before start was wrapped');
  await api.start('smoke');
  assert.equal(started, 1);
  note('drag', 'touch: 4 moves, from 288,180 to 480,330');
  note('tap', 'mouse: 0 moves, from 336,420 to 336,420');
  const types = api.report().events.map((e: any) => e.type);
  assert.deepEqual(types.filter((t: string) => t === 'drag' || t === 'tap'), ['drag', 'tap'], 'a new start clears what came before it');
  assert.equal(types[0], 'start');
  assert.match(api.report().events.find((e: any) => e.type === 'drag').detail, /touch: 4 moves/);
});

test('addInputEvents: a run the address started before it was called keeps its clock', () => {
  const api: any = { start: async () => {}, report: () => ({ scenario: 'smoke', seconds: 5, events: [{ t: 0, type: 'start' }], problems: [] }) };
  const note = m.addInputEvents(api);
  note('drag', 'touch: 3 moves, from 1,1 to 2,2');
  const e = api.report().events.find((x: any) => x.type === 'drag');
  assert.ok(e.t >= 5 && e.t < 6, `t is ${e.t}`);
});

test('the demo: the page logs each tap, drag and stick drag; smoke drives the stick on phone and absolute drag on desktop', () => {
  const html = fs.readFileSync(new URL('../public/demo.html', import.meta.url), 'utf8');
  assert.match(html, /inputNote\?\.\(kind,/);
  assert.match(html, /stick-drag|'stick'/);
  assert.match(html, /addEventListener\('pointerup', endGesture\)/);
  assert.match(html, /inputNote = addInputEvents\(playtest\)/);
  assert.ok(html.indexOf('await dragChecks(c)') < html.indexOf('await peerChecks(c)'), 'the drag checks run in smoke before the peer checks');
  assert.match(html, /stickDrag/);
  assert.match(html, /Dragging the floating stick moves this player/);
  assert.match(html, /Dragging on the arena moves this player/);
});
