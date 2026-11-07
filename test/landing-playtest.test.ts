// The landing page's playtest (public/landing-playtest.mjs): the link checker that reads the docs page and the quickstart,
// and the page's own wiring. Same-site links are fetched once each, outside links are judged by their href and never fetched.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const { extractLinks, classifyLink, checkLinks } = await import('../public/landing-playtest.mjs');
const { startTestHub } = await import('./helper.ts');
const hub = await startTestHub();
after(async () => { await hub.stop(); });

const ORIGIN = 'https://net.example';
const PAGE = `${ORIGIN}/quickstart`;

function fakeFetch(answers: Record<string, number | Error>) {
  const calls: string[] = [];
  const fn = async (url: string) => {
    calls.push(url);
    const a = answers[url] ?? 404;
    if (a instanceof Error) throw a;
    return { ok: a >= 200 && a < 300, status: a, body: { cancel: async () => {} } };
  };
  return { fn, calls };
}

test('extractLinks reads every href and id, and undoes &amp;', () => {
  const { hrefs, ids } = extractLinks(`<a href="/a?x=1&amp;y=2">A</a> <A class=x HREF='/b'>B</A> <a name="no">n</a><h2 id="top">T</h2>`);
  assert.deepEqual(hrefs, ['/a?x=1&y=2', '/b']);
  assert.ok(ids.has('top'));
});

test('classifyLink: same site, anchors, outside, mail, junk', () => {
  assert.equal(classifyLink('/demo', PAGE, ORIGIN).kind, 'same');
  assert.equal(classifyLink('/dashboard#docs', PAGE, ORIGIN).url, `${ORIGIN}/dashboard`, 'the fragment is dropped for the fetch');
  assert.equal(classifyLink('#key', PAGE, ORIGIN).kind, 'anchor');
  assert.equal(classifyLink('/quickstart#key', PAGE, ORIGIN).kind, 'anchor', "a link to its own page's id is an anchor");
  assert.equal(classifyLink('https://github.com/x/y', PAGE, ORIGIN).kind, 'outside');
  assert.equal(classifyLink('https://net.example/x', PAGE, ORIGIN).kind, 'same');
  assert.equal(classifyLink('mailto:a@b.co?subject=hi', PAGE, ORIGIN).address, 'a@b.co');
  assert.equal(classifyLink('javascript:void(0)', PAGE, ORIGIN).kind, 'skip');
  assert.equal(classifyLink('ftp://x.y/z', PAGE, ORIGIN).kind, 'bad');
});

test('checkLinks: one fetch per same-site address, none for outside links, failures named', async () => {
  const html = `<h2 id="key">k</h2>
    <a href="/demo">d</a><a href="/demo">again</a><a href="/dashboard#docs">x</a><a href="/dashboard#unity">y</a>
    <a href="/gone">gone</a><a href="/boom">boom</a>
    <a href="#key">ok anchor</a><a href="#nope">bad anchor</a>
    <a href="https://github.com/a/b">gh</a><a href="http://plain.example/">plain</a>
    <a href="mailto:support@hawkesgen.ai">m</a><a href="mailto:nobody">m2</a>`;
  const f = fakeFetch({ [`${ORIGIN}/demo`]: 200, [`${ORIGIN}/dashboard`]: 200, [`${ORIGIN}/gone`]: 404, [`${ORIGIN}/boom`]: new Error('network down') });
  const out = await checkLinks(html, { pageUrl: PAGE, origin: ORIGIN, fetchFn: f.fn });
  assert.deepEqual([...f.calls].sort(), [`${ORIGIN}/boom`, `${ORIGIN}/dashboard`, `${ORIGIN}/demo`, `${ORIGIN}/gone`], 'each address once, nothing outside');
  assert.deepEqual(out.failed.map((r) => r.href).sort(), ['#nope', '/boom', '/gone', 'http://plain.example/', 'mailto:nobody']);
  assert.equal(out.results.find((r) => r.href === '/gone')?.status, 404);
  assert.match(out.results.find((r) => r.href === '/boom')!.why, /network down/);
  assert.equal(out.counts.outside, 2);
  assert.equal(out.results.filter((r) => r.href === '/demo').length, 1, 'a link used twice is one check');
});

test('the real docs page and quickstart: every link answers on a running service', async () => {
  for (const p of ['/docs/errors', '/quickstart']) {
    const html = await (await fetch(hub.endpoint + p)).text();
    const out = await checkLinks(html, { pageUrl: hub.endpoint + p, origin: hub.endpoint, fetchFn: fetch });
    assert.ok(out.counts.total > 5, `${p} has links`);
    assert.deepEqual(out.failed, [], `${p}: ${JSON.stringify(out.failed)}`);
  }
});

test('the landing page: the status record, the playtest bot served, and no polling', async () => {
  const page = fs.readFileSync(new URL('../public/landing.html', import.meta.url), 'utf8');
  assert.match(page, /window\.hawkesNetLanding/);
  assert.match(page, /import\('\/landing-playtest\.mjs'\)/);
  assert.ok(!/setInterval|setTimeout/.test(page), 'the landing page has no timers');
  const r = await fetch(`${hub.endpoint}/landing-playtest.mjs`);
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type') ?? '', /javascript/);
  assert.match(await r.text(), /export function installLandingPlaytest/);
  const bot = fs.readFileSync(new URL('../public/landing-playtest.mjs', import.meta.url), 'utf8');
  assert.ok(!/window\.location\s*=|location\.href\s*=|location\.assign|location\.replace/.test(bot), 'the bot never navigates the page away');
});
