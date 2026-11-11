// public/docs-snippets.mjs: shared parse/judge and the live Ada/Bob join used by /demo's site scenario.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { startTestHub } from './helper.ts';

const m = await import('../public/docs-snippets.mjs');
const hub = await startTestHub();
after(async () => { await hub.stop(); });
const html = fs.readFileSync(new URL('../public/quickstart.html', import.meta.url), 'utf8');

test('expectForRoom rewrites the docs room name', () => {
  assert.deepEqual(m.expectForRoom(['Ada is in "first-room" on the relay'], 'docs-pt-1'), ['Ada is in "docs-pt-1" on the relay']);
});

test('runLiveDocsSnippets: Ada and Bob print what the quickstart steps say', async () => {
  const plan = m.planRuns(m.readSteps(html));
  const room = `docs-live-${Date.now().toString(36)}`;
  const { join } = await import('../sdk/js/hawkes-net.mjs');
  const got: [string, boolean, string][] = [];
  const ok = await m.runLiveDocsSnippets(plan, {
    room,
    joinFn: (r: string, name: string) => join(r, { project: 'netdemo', endpoint: hub.url, transport: 'relay', name, log: false }),
    report: (n: string, o: boolean, d: string) => got.push([n, o, d]),
    timeout: 15000,
    quiet: 300,
  });
  assert.equal(got.length, 3);
  for (const [n, o, d] of got) assert.ok(o, `${n}: ${d}`);
  assert.ok(ok);
});

test('judgeLinks names a 404 and an off-site host', async () => {
  const page = '<a href="/gone">g</a><a href="https://evil.example/x">e</a>';
  const fetchFn = async (u: string) => ({ ok: !u.endsWith('/gone'), status: u.endsWith('/gone') ? 404 : 200, body: null });
  const { broken } = await m.judgeLinks(page, { pageUrl: 'https://net.example/quickstart', origin: 'https://net.example', fetchFn });
  assert.ok(broken.some((b: { href: string; why: string }) => b.href === '/gone' && /404/.test(b.why)));
  assert.ok(broken.some((b: { href: string }) => b.href === 'https://evil.example/x'));
});
