// /demo's API reference scenario (public/api-playtest.mjs): lists, search filter, error-code hop.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { startTestHub } from './helper.ts';

const m = await import('../public/api-playtest.mjs');
const hub = await startTestHub();
after(async () => { await hub.stop(); });

function fakePage(overrides: Record<string, unknown> = {}) {
  let query = '';
  const all = 40;
  const shownFor = (q: string) => {
    if (!q.trim()) return all;
    if (q.toLowerCase().includes('join')) return 6;
    return 2;
  };
  return {
    width: 1100,
    scrollWidth: 1100,
    hasSearch: true,
    shown: all,
    counts: { exports: 45, methods: 88, options: 35, events: 17, missingExample: 0, ...(overrides.counts as object || {}) },
    typeSearch: async (q: string) => {
      query = q;
      return { shown: shownFor(q), fetchCount: 0 };
    },
    openErrorCode: async () => ({ href: '/docs/errors#room_invalid', landedOk: true, status: 200 }),
    dispose: () => {},
    ...overrides,
    get shownNow() { return shownFor(query); },
  };
}

test('apiChecks: a healthy API page passes every criterion', async () => {
  const lines: Record<string, { ok: boolean; why: string }> = {};
  const metrics: Record<string, number> = {};
  const events: string[] = [];
  const check = async (name: string, fn: () => Promise<string | void>) => {
    try { lines[name] = { ok: true, why: String(await fn() ?? '') }; } catch (e) { lines[name] = { ok: false, why: String((e as Error).message) }; }
  };
  const page = fakePage();
  await m.apiChecks({
    check,
    metric: (k: string, v: number) => { metrics[k] = v; },
    event: (t: string) => { events.push(t); },
    readApi: async () => page,
  });
  for (const [name, l] of Object.entries(lines)) assert.ok(l.ok, `${name}: ${l.why}`);
  assert.equal(metrics.apiExports, 45);
  assert.equal(metrics.apiMethods, 88);
  assert.equal(metrics.apiEvents, 17);
  assert.equal(metrics.apiSearchFetches, 0);
  assert.ok(metrics.apiSearchAfter < metrics.apiSearchBefore);
  assert.equal(metrics.apiErrorHop, 1);
  assert.ok(events.includes('api-listed'));
  assert.ok(events.includes('api-search'));
  assert.ok(events.includes('api-error-link'));
});

test('apiChecks: missing examples, a search that fetches, or a bad error hop each fail their check', async () => {
  const run = async (page: ReturnType<typeof fakePage>) => {
    const lines: Record<string, { ok: boolean; why: string }> = {};
    const check = async (name: string, fn: () => Promise<string | void>) => {
      try { lines[name] = { ok: true, why: String(await fn() ?? '') }; } catch (e) { lines[name] = { ok: false, why: String((e as Error).message) }; }
    };
    await m.apiChecks({ check, metric: () => {}, readApi: async () => page });
    return lines;
  };
  const missing = await run(fakePage({ counts: { exports: 45, methods: 88, options: 35, events: 17, missingExample: 3 } }));
  assert.equal(missing['API reference lists every export, method and event with an example'].ok, false);

  const fetches = await run(fakePage({
    typeSearch: async () => ({ shown: 6, fetchCount: 2 }),
  }));
  assert.match(fetches['Typing in the search box narrows the list instantly (no server call)'].why, /2 fetch/);

  const badHop = await run(fakePage({
    openErrorCode: async () => ({ href: '/docs/errors#room_invalid', landedOk: false, status: 404 }),
  }));
  assert.match(badHop['Error codes in the reference open their entry on the error codes page'].why, /did not show/);
});

test('addApiScenario: the contract lists api, runs it, reports metrics; other scenarios go to the original', async () => {
  const calls: string[] = [];
  const api: any = {
    scenarios: () => [{ id: 'smoke' }],
    start: async (id: string) => { calls.push(id); },
    state: () => ({ ready: true, status: 'idle' }),
    report: () => null,
    stop: () => {},
  };
  (globalThis as any).location = { origin: 'https://net.example', host: 'net.example' };
  m.addApiScenario(api, {
    origin: 'https://net.example',
    where: 'net.example',
    readApi: async () => fakePage(),
  });
  assert.deepEqual(api.scenarios().map((s: any) => s.id), ['smoke', 'api']);
  await api.start('smoke');
  assert.deepEqual(calls, ['smoke']);
  await api.start('api');
  assert.deepEqual(calls, ['smoke'], 'api did not go to the original');
  const st = api.state();
  assert.equal(st.status, 'won');
  const rep = api.report();
  assert.equal(rep.scenario, 'api');
  assert.equal(rep.outcome, 'won');
  assert.equal(rep.problems.length, 0);
  assert.ok(rep.metrics.apiExports >= 1);
  delete (globalThis as any).location;
});

test('the demo wires the api scenario; the shared bot file is untouched; the hub serves the module', async () => {
  const html = fs.readFileSync(new URL('../public/demo.html', import.meta.url), 'utf8');
  assert.match(html, /addApiScenario\(playtest\)/);
  assert.match(html, /import\('\/api-playtest\.mjs'\)/);
  assert.doesNotMatch(fs.readFileSync(new URL('../public/demo-playtest.mjs', import.meta.url), 'utf8'), /api-playtest|addApiScenario|apiChecks/);
  const src = fs.readFileSync(new URL('../public/api-playtest.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /setInterval/);
  const r = await fetch(`${hub.url}/api-playtest.mjs`);
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type') ?? '', /javascript/);
  assert.match(await r.text(), /addApiScenario/);
});
