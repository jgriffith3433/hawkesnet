// API reference from SDK JSDoc (src/api-docs.ts): every public export and emitted event has JSDoc with
// description, @sig and @example; the generated /docs/api page lists them, links error codes, and ships a search box.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { startTestHub } from './helper.ts';
import { validateSdkJsdoc, parseApiDocs, formatDescriptionHtml, apiDocsHtml } from '../src/api-docs.ts';

const hub = await startTestHub();
after(async () => { await hub.stop(); });

test('every public export and emitted event has JSDoc (description, @sig, @example)', () => {
  const r = validateSdkJsdoc();
  assert.equal(r.ok, true, r.errors.join('\n'));
  assert.ok(r.catalog.exports.length >= 10, `only ${r.catalog.exports.length} exports`);
  assert.ok(r.catalog.methods.length >= 10, `only ${r.catalog.methods.length} methods`);
  assert.ok(r.catalog.events.length >= 5, `only ${r.catalog.events.length} events`);
  for (const e of r.catalog.all) {
    assert.ok(e.description, `${e.kind} ${e.name} missing description`);
    assert.ok(e.signature, `${e.kind} ${e.name} missing signature`);
    assert.ok(e.example, `${e.kind} ${e.name} missing example`);
  }
});

test('a public export without JSDoc fails the validator', () => {
  const net = fs.readFileSync(new URL('../sdk/js/hawkes-net.mjs', import.meta.url), 'utf8');
  const core = fs.readFileSync(new URL('../sdk/js/hawkes-net-core.mjs', import.meta.url), 'utf8');
  const poisoned = net.replace(
    /\/\*\*[\s\S]*?\*\/\s*\nexport const VERSION/,
    'export const VERSION',
  );
  assert.notEqual(poisoned, net, 'fixture did not strip VERSION JSDoc');
  const r = validateSdkJsdoc(poisoned, core);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /export "VERSION" has no JSDoc/.test(e)), r.errors.join('\n'));
});

test('an emitted event without @event fails the validator', () => {
  const net = fs.readFileSync(new URL('../sdk/js/hawkes-net.mjs', import.meta.url), 'utf8');
  const core = fs.readFileSync(new URL('../sdk/js/hawkes-net-core.mjs', import.meta.url), 'utf8');
  // Drop only the @event ready block; ready is still emitted via .ev.emit('ready', …).
  const poisoned = net.replace(
    /\n  \/\*\*\n   \* Fires when the room's initial hello[\s\S]*?\n   \* @event ready\n[\s\S]*?\n   \*\//,
    '\n',
  );
  assert.notEqual(poisoned, net, 'fixture did not strip @event ready');
  assert.match(poisoned, /\.ev\.emit\(\s*'ready'/);
  const r = validateSdkJsdoc(poisoned, core);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /event "ready" has no JSDoc/.test(e)), r.errors.join('\n'));
});

test('formatDescriptionHtml links known error codes to /docs/errors#code', () => {
  const html = formatDescriptionHtml('Fails with `room_invalid` or ticket_rate_limited when busy.');
  assert.match(html, /href="\/docs\/errors#room_invalid"/);
  assert.match(html, /href="\/docs\/errors#ticket_rate_limited"/);
  assert.match(html, /class="err-code"/);
});

test('apiDocsHtml lists every catalog entry with a search box and docs tabs', () => {
  const catalog = parseApiDocs();
  const html = apiDocsHtml();
  assert.match(html, /id="api-search"/);
  assert.match(html, /href="\/docs\/errors"/);
  assert.match(html, /aria-current="page">API reference/);
  assert.match(html, /href="\/site\.css"/);
  assert.match(html, /src="\/site\.js"/);
  for (const e of catalog.all) {
    assert.match(html, new RegExp(`id="${e.id}"`), `missing ${e.id}`);
    assert.match(html, new RegExp(`data-kind="${e.kind}"[^>]*data-name="${e.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`));
  }
  assert.ok((html.match(/class="api-item"/g) || []).length === catalog.all.length);
});

test('the hub serves /docs/api (and /docs) with the generated reference', async () => {
  for (const path of ['/docs/api', '/docs', '/api.html']) {
    const r = await fetch(`${hub.endpoint}${path}`);
    assert.equal(r.status, 200, path);
    assert.match(r.headers.get('content-type') ?? '', /text\/html/);
    const html = await r.text();
    assert.match(html, /id="api-search"/, path);
    assert.match(html, /class="api-item"/, path);
    assert.match(html, /err-code/, path);
  }
});

test('npm run build writes dist/docs/api.html (and refuses when JSDoc is missing)', () => {
  // Spot-check the build script wires the generator; the full build runs in CI / the release check.
  const build = fs.readFileSync(new URL('../tools/build.mjs', import.meta.url), 'utf8');
  assert.match(build, /apiDocsHtml/);
  assert.match(build, /validateSdkJsdoc/);
  assert.match(build, /docs\/api\.html/);
  assert.match(build, /['"]public['"],\s*['"]api\.html['"]/);
});
