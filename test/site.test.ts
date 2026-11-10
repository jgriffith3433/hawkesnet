// The shared look and header (public/site.css, public/site.js): every page links them, the palette is AA, the shared
// script is served and has no timers, and no page repeats requests on a clock. The browser side (header, Copy clicks,
// measured contrast) is the landing page's `site` playtest scenario.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const { parseColor, contrastRatio, over } = await import('../public/landing-playtest.mjs');
const { startTestHub } = await import('./helper.ts');
const hub = await startTestHub();
after(async () => { await hub.stop(); });

const read = (f: string) => fs.readFileSync(new URL(`../public/${f}`, import.meta.url), 'utf8');
const css = read('site.css');
const vars = Object.fromEntries([...css.matchAll(/--([a-z-]+):\s*(#[0-9a-f]{6})/gi)].map((m) => [m[1], parseColor(`rgb(${[1, 3, 5].map((i) => parseInt(m[2].slice(i, i + 2), 16)).join(',')})`)]));

test('the palette: every text and button pair is AA (4.5:1)', () => {
  const pairs: [string, string][] = [['ink', 'bg'], ['ink', 'card'], ['muted', 'bg'], ['muted', 'card'], ['accent', 'bg'], ['accent', 'card'], ['on-accent', 'accent'],
    ['ok', 'bg'], ['ok', 'card'], ['warn', 'bg'], ['warn', 'card'], ['bad', 'bg'], ['bad', 'card'], ['code-ink', 'code'], ['ink', 'card']];
  for (const [a, b] of pairs) assert.ok(contrastRatio(vars[a], vars[b]) >= 4.5, `${a} on ${b} is ${contrastRatio(vars[a], vars[b]).toFixed(2)}:1`);
  assert.ok(contrastRatio(parseColor('rgb(238,240,243)'), parseColor('rgb(35,40,50)')) >= 4.5, 'the Copy button label');
  assert.ok(contrastRatio(vars['accent'], vars['code']) >= 4.5);
});

test('contrast helpers: black on white is 21:1, alpha is laid over what is under it, color(srgb) parses', () => {
  assert.equal(Math.round(contrastRatio([0, 0, 0], [255, 255, 255])), 21);
  assert.deepEqual(over([255, 255, 255, 0.5], [0, 0, 0, 1]).map(Math.round), [128, 128, 128, 1]);
  assert.deepEqual(parseColor('color(srgb 1 0 0 / 0.5)'), [255, 0, 0, 0.5]);
  assert.deepEqual(parseColor('rgba(1, 2, 3, 0)'), [1, 2, 3, 0]);
});

test('every page links the shared stylesheet and script, and none has a timer that repeats', async () => {
  for (const p of ['/', '/home', '/docs/api', '/docs/errors', '/quickstart', '/demo', '/dashboard']) {
    const html = await (await fetch(hub.endpoint + p)).text();
    assert.match(html, /<link rel="stylesheet" href="\/site\.css">/, `${p} links site.css`);
    assert.match(html, /<script src="\/site\.js" defer><\/script>/, `${p} loads site.js`);
    // API reference examples may mention setInterval; ban it only outside <pre> (no page clocks).
    const withoutPres = html.replace(/<pre\b[^>]*>[\s\S]*?<\/pre>/gi, '');
    assert.ok(!/setInterval/.test(withoutPres), `${p} has no setInterval outside code examples`);
    assert.ok(!/prefers-color-scheme|data-theme="light"/.test(html), `${p} has one theme`);
  }
  const home = await (await fetch(hub.endpoint + '/home')).text();
  assert.equal(home, await (await fetch(hub.endpoint + '/')).text(), '/home is the landing page');
});

test('/site.css and /site.js are served, and the script makes no request and has no timer', async () => {
  const c = await fetch(`${hub.endpoint}/site.css`), j = await fetch(`${hub.endpoint}/site.js`);
  assert.equal(c.status, 200); assert.match(c.headers.get('content-type') ?? '', /text\/css/);
  assert.equal(j.status, 200); assert.match(j.headers.get('content-type') ?? '', /javascript/);
  const js = await j.text();
  assert.ok(!/setInterval|setTimeout|fetch\(|XMLHttpRequest|WebSocket/.test(js), 'no timers, no requests');
  for (const label of ['Home', 'Docs', 'Quickstart', 'Demo']) assert.match(js, new RegExp(`'${label}'`));
  assert.match(js, /querySelectorAll\?\.\('pre'\)/);
});

test('phone size: the header folds into a Menu button, wide things scroll inside themselves, the demo takes pointer input', async () => {
  const js = read('site.js'), demo = read('demo.html');
  assert.match(css, /@media \(max-width: 640px\)[\s\S]*\.site-header nav \{ display: none/);
  assert.match(js, /class="menu"[^]*aria-expanded/);
  assert.match(demo, /addEventListener\('pointerdown'/);
  assert.match(demo, /addEventListener\('pointermove'/);
  assert.match(demo, /touch-action: none/);
  assert.match(demo, /viewport-fit=cover/);
  assert.match(demo, /STICK_R|floating stick|hawkesNetPhone/);
  assert.match(demo, /panel-toggle/);
  // A grid track must be able to shrink below its content (a code line is wider than 390 px): minmax(0, 1fr), never a bare 1fr.
  for (const page of ['landing.html', 'quickstart.html']) assert.doesNotMatch(read(page), /grid-template-columns: 1fr[;} ]/, page);
  assert.match(css, /\.codeblock, \.card pre[^{]*\{ min-width: 0; max-width: 100%/);
  assert.match(await (await fetch(hub.endpoint + '/docs/errors')).text(), /table\{display:block;overflow-x:auto\}/);
});
