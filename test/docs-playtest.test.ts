// The docs playtest (tools/docs-playtest.mjs): the quickstart's JavaScript snippets run for real against the test service
// and print what each step says; a broken snippet or link fails naming itself.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { startTestHub } from './helper.ts';

const m = await import('../tools/docs-playtest.mjs');
const hub = await startTestHub();
after(async () => { await hub.stop(); });
const html = fs.readFileSync(new URL('../public/quickstart.html', import.meta.url), 'utf8');

test('the quickstart snippets run as written and print what each step says', async () => {
  const plan = m.planRuns(m.readSteps(html));
  const got: [string, boolean, string][] = [];
  const ok = await m.runSnippets(plan, { url: hub.url, report: (n: string, o: boolean, d: string) => got.push([n, o, d]), timeout: 15000, quiet: 800 });
  assert.equal(got.length, 3);
  for (const [n, o, d] of got) assert.ok(o, `${n}: ${d}`);
  assert.ok(ok);
});

test('a snippet that prints something else fails and names the step', async () => {
  const bad = html.replace('on the ${me.transport}`);\nawait me.leave();', 'on the ${me.transport} yo`);\nawait me.leave();');
  assert.notEqual(bad, html);
  const got: [string, boolean, string][] = [];
  const ok = await m.runSnippets(m.planRuns(m.readSteps(bad)), { url: hub.url, report: (n: string, o: boolean, d: string) => got.push([n, o, d]), timeout: 15000, quiet: 500 });
  assert.equal(ok, false);
  const f = got.find(([, o]) => !o)!;
  assert.match(f[0], /js-connect/);
  assert.match(f[2], /missing/);
});

test('a missing snippet or step is named', () => {
  assert.throws(() => m.planRuns(m.readSteps(html.replace('id="js-second"', 'id="x"'))), /no step "js-second"/);
});

test('links: a 404 is named, an off-site host fails, Hawkes hosts pass', async () => {
  const page = '<a href="/gone">g</a><a href="/demo">d</a><a href="https://evil.example/x">e</a><a href="https://net.hawkesgames.com/">h</a><a href="https://github.com/jgriffith3433/hawkesnet-js">j</a><a href="https://github.com/other/repo">o</a>';
  const fetchFn = async (u: string) => ({ ok: !u.endsWith('/gone'), status: u.endsWith('/gone') ? 404 : 200, body: null });
  const { broken } = await m.judgeLinks(page, { pageUrl: 'https://net.example/quickstart', origin: 'https://net.example', fetchFn });
  assert.deepEqual(broken.map((b: { href: string }) => b.href).sort(), ['/gone', 'https://evil.example/x', 'https://github.com/other/repo']);
  assert.match(broken.find((b: { href: string }) => b.href === '/gone').why, /404/);
});

test('the real quickstart and API reference have no broken or off-site links', async () => {
  for (const p of ['/quickstart', '/docs/api']) {
    const page = await (await fetch(hub.url + p)).text();
    const { broken, total } = await m.judgeLinks(page, { pageUrl: hub.url + p, origin: hub.url, fetchFn: (u: string) => fetch(u) });
    assert.ok(total > 0);
    assert.deepEqual(broken, [], p);
  }
});
