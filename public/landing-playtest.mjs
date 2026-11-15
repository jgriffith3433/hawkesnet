// Hawkes Studio's playtest bot for the Hawkes Net landing page (/): window.hawkesPlaytest (Studio's docs/playtest.md, contract v1).
// The smoke playtest stays on this page from start to finish (it never navigates away):
//   1. reads the status (ok or degraded) and the version the page showed when it opened (read once, nothing re-fetched)
//   2. fetches the docs page (/docs/api) and the quickstart and checks every link on them: links on this site by one fetch
//      each, links to other sites only by their href (a well formed https address), never opened
//   3. opens /demo in a frame on this page and runs the demo's own smoke playtest there: two players in one room
// No polling: a check is one fetch (or one read of what the page already knows); waits are on events or on the demo's own run.
//
// The link checker (extractLinks, classifyLink, checkLinks) is plain functions so npm test can run them without a browser.

const unescapeHtml = (s) => s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");

/** The href of every <a> in an HTML text, and the ids on the page (for same-page #anchors). */
export function extractLinks(html) {
  const hrefs = [];
  for (const m of String(html).matchAll(/<a\b[^>]*?\bhref\s*=\s*(?:"([^"]*)"|'([^']*)')/gi)) hrefs.push(unescapeHtml((m[1] ?? m[2] ?? '').trim()));
  const ids = new Set([...String(html).matchAll(/\bid\s*=\s*(?:"([^"]*)"|'([^']*)')/gi)].map((m) => m[1] ?? m[2]));
  return { hrefs, ids };
}

/**
 * What kind of link an href is, from the page it is on (`pageUrl`, absolute) and this site (`origin`):
 *  anchor   #id on the same page: the id must be on the page
 *  same     this site: one fetch (the fragment is dropped; a page's own ids are only known for the page itself)
 *  outside  another site's http(s) address: judged by its href alone
 *  mail     mailto: judged by its address alone
 *  skip     javascript:, data: and empty links, which are not addresses
 */
export function classifyLink(href, pageUrl, origin) {
  const h = String(href ?? '').trim();
  if (!h || /^(javascript|data|blob|tel):/i.test(h)) return { kind: 'skip', href: h };
  if (/^mailto:/i.test(h)) return { kind: 'mail', href: h, address: h.slice(7).split('?')[0] };
  if (h.startsWith('#')) return { kind: 'anchor', href: h, id: decodeURIComponent(h.slice(1)) };
  let u;
  try { u = new URL(h, pageUrl); } catch { return { kind: 'bad', href: h, why: 'not an address' }; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return { kind: 'bad', href: h, why: `${u.protocol} is not a web address` };
  if (u.origin === origin) {
    // A link back to the page it is on with a fragment is an anchor too.
    if (u.hash && u.pathname + u.search === new URL(pageUrl).pathname + new URL(pageUrl).search) return { kind: 'anchor', href: h, id: decodeURIComponent(u.hash.slice(1)) };
    return { kind: 'same', href: h, url: u.origin + u.pathname + u.search };
  }
  return { kind: 'outside', href: h, url: u.href, host: u.hostname, secure: u.protocol === 'https:' };
}

/**
 * Checks every link of one page. `fetchFn` is fetch; each distinct same-site address is fetched once (GET, the body is not read),
 * several at a time. Outside links are never fetched. Returns { page, results: [{ href, kind, ok, why, status? }], failed, counts }.
 */
export async function checkLinks(html, { pageUrl, origin, fetchFn, concurrency = 4 }) {
  const { hrefs, ids } = extractLinks(html);
  const seen = new Map(); // href -> result (a link used twice is one check)
  const jobs = [];
  const byUrl = new Map(); // same-site url -> shared promise (one fetch for the address)
  for (const href of hrefs) {
    if (seen.has(href)) continue;
    const c = classifyLink(href, pageUrl, origin);
    const r = { href, kind: c.kind, ok: true, why: '' };
    seen.set(href, r);
    if (c.kind === 'skip') { r.ok = true; r.why = 'not an address'; continue; }
    if (c.kind === 'bad') { r.ok = false; r.why = c.why; continue; }
    if (c.kind === 'mail') { r.ok = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(c.address); r.why = r.ok ? 'address looks right' : `"${c.address}" is not an email address`; continue; }
    if (c.kind === 'anchor') { r.ok = ids.has(c.id); r.why = r.ok ? 'on this page' : `no element with id "${c.id}" on this page`; continue; }
    if (c.kind === 'outside') {
      r.ok = true; r.why = `${c.host}, not opened`;
      if (!c.secure) { r.ok = false; r.why = `${c.host} is plain http`; }
      continue;
    }
    jobs.push(() => {
      if (!byUrl.has(c.url)) byUrl.set(c.url, (async () => {
        try {
          const res = await fetchFn(c.url, { redirect: 'follow' });
          try { await res.body?.cancel?.(); } catch { /* body not needed */ }
          return { ok: res.ok, status: res.status };
        } catch (e) { return { ok: false, status: 0, why: String(e?.message ?? e) }; }
      })());
      return byUrl.get(c.url).then((x) => { r.status = x.status; r.ok = x.ok; r.why = x.ok ? `answered ${x.status}` : x.why || `answered ${x.status}`; });
    });
  }
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, jobs.length) }, async () => { while (next < jobs.length) await jobs[next++](); }));
  const results = [...seen.values()];
  const counts = { total: results.length, same: 0, outside: 0, anchor: 0, mail: 0 };
  for (const r of results) if (r.kind in counts) counts[r.kind]++;
  return { page: pageUrl, results, failed: results.filter((r) => !r.ok), counts };
}

// ---- the site check's pure parts (test/site.test.ts runs them)
/** "rgb(…)", "rgba(…)" or "color(srgb r g b / a)" -> [r, g, b, a] (0-255, a 0-1), or null. */
export function parseColor(c) {
  const m = String(c).match(/^(rgba?|color)\(\s*(?:srgb\s+)?([^)]*)\)$/i);
  if (!m) return null;
  const parts = m[2].split(/[\s,/]+/).filter(Boolean).map(Number);
  if (parts.length < 3 || parts.some((n) => Number.isNaN(n))) return null;
  const k = m[1].toLowerCase() === 'color' ? 255 : 1;
  return [parts[0] * k, parts[1] * k, parts[2] * k, parts.length > 3 ? parts[3] : 1];
}
/** `top` (with its alpha) laid over the opaque `under`. */
export function over(top, under) { const a = top[3]; return [0, 1, 2].map((i) => top[i] * a + under[i] * (1 - a)).concat(1); }
export function luminance(c) { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]); }
/** WCAG contrast ratio of two opaque colors. */
export function contrastRatio(a, b) { const x = luminance(a), y = luminance(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); }
export const SITE_PAGES = [['Home', '/home'], ['Docs', '/docs/api'], ['Quickstart', '/quickstart'], ['Demo', '/demo'], ['Dashboard', '/dashboard']];

/** Installs window.hawkesPlaytest on the landing page. `o.landing` is the page's own status record (see landing.html). */
export function installLandingPlaytest(o = {}) {
  const scenarios = [
    { id: 'smoke', title: 'Landing page: status and version, docs and quickstart links, then two players in the demo', seconds: 70, tags: ['smoke'],
      description: 'Stays on the Hawkes Net site. Reads the status (ok or degraded) and version the page showed on load, opens the docs page and the quickstart and checks every link on them (this site by one fetch each, other sites by their href only), then opens /demo in a frame on this page and runs the demo\'s own two-player check.' },
    { id: 'site', title: 'Every page: the same header, a Copy button on each code block, AA contrast, no timers', seconds: 60, tags: ['full'],
      description: 'Opens the landing page, docs, quickstart, demo and dashboard one after another in a frame. On each it checks the header (Home, Docs, Quickstart, Demo, the same on every page), clicks Copy on every code block, measures the contrast of every visible text against its background (AA, 4.5:1, or 3:1 for large text), and checks the page and the shared script have no timers and that no request is made after load.' },
  ];
  const STALL = 60;
  const origin = location.origin;
  let run = null;

  const panel = document.createElement('div');
  panel.id = 'hawkes-net-playtest';
  panel.style.cssText = 'position:fixed;right:12px;top:12px;z-index:99999;max-width:380px;background:rgba(10,12,16,.86);color:#e8eaed;font:12px/1.5 ui-monospace,Menlo,monospace;padding:8px 12px;border-radius:8px;display:none;pointer-events:none';
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  const show = () => {
    if (!run) return;
    if (!panel.isConnected) document.body.appendChild(panel);
    panel.style.display = 'block';
    const head = run.done ? (run.state.status === 'won' ? '<b style="color:#9fe870">PASS</b>' : `<b style="color:#ff7b72">${run.state.status === 'lost' ? 'FAIL' : run.state.status.toUpperCase()}</b>`) : '<b style="color:#ffd84d">running</b>';
    panel.innerHTML = `Playtest ${esc(run.id)} on ${esc(location.host)} · ${head}<br>` + run.lines.map((l) => `${l.ok === true ? '<span style="color:#9fe870">✓</span>' : l.ok === false ? '<span style="color:#ff7b72">✗</span>' : '…'} ${esc(l.text)}${l.why ? ` <span style="color:#9aa1ad">(${esc(l.why)})</span>` : ''}`).join('<br>');
  };

  const r1 = (n) => Math.round(n * 10) / 10;
  const now = () => (run ? (performance.now() - run.t0) / 1000 : 0);
  const event = (type, detail) => { if (!run) return; run.events.push({ t: r1(now()), type, ...(detail === undefined ? {} : { detail: String(detail) }) }); run.moved = performance.now(); };
  const metric = (k, v) => { if (run) run.metrics[k] = v; };
  const problem = (severity, message) => { if (!run || run.problems.some((p) => p.message === message)) return; run.problems.push({ severity, message }); event('problem', `${severity}: ${message}`); };
  const log = (line) => { if (run) { run.log.push(`${r1(now())}s ${line}`); if (run.log.length > 200) run.log.shift(); } };
  const progress = (p) => { if (run) { run.state.progress = Math.max(0, Math.min(1, p)); run.moved = performance.now(); } };
  const finish = (outcome) => {
    if (!run || run.done) return;
    run.done = true; run.state.status = outcome; run.seconds = now();
    run.state.note = outcome === 'won' ? 'all checks passed' : `${run.lines.filter((l) => l.ok === false).length} check(s) failed`;
    event('finish', outcome); show();
  };
  async function check(text, fn) {
    const line = { text, ok: null, why: '' };
    run.lines.push(line); show(); event('check', text);
    try {
      const why = await fn();
      line.ok = true; line.why = typeof why === 'string' ? why : '';
      event('pass', text); run.metrics.checksPassed = (run.metrics.checksPassed ?? 0) + 1;
    } catch (e) {
      line.ok = false; line.why = String(e?.message ?? e).slice(0, 220);
      problem('bug', `${text}: ${line.why}`); event('fail', text); run.metrics.checksFailed = (run.metrics.checksFailed ?? 0) + 1;
    }
    show();
    return line.ok;
  }

  /** One page's links: fetch the page once, then each same-site link once. */
  async function linksOf(name, path) {
    const url = origin + path;
    const res = await fetch(url, { cache: 'no-store' });
    if (!res.ok) throw new Error(`${path} answered ${res.status}`);
    const out = await checkLinks(await res.text(), { pageUrl: url, origin, fetchFn: (u, init) => fetch(u, { ...init, cache: 'no-store' }) });
    const c = out.counts;
    metric(`${name}Links`, c.total); metric(`${name}LinksBroken`, out.failed.length);
    for (const r of out.results) log(`${name} link ${r.ok ? 'ok' : 'BROKEN'} ${r.kind} ${r.href} (${r.why})`);
    if (!c.total) throw new Error(`no links found on ${path}`);
    if (out.failed.length) throw new Error(`${out.failed.length} of ${c.total} broken: ${out.failed.slice(0, 4).map((r) => `${r.href} (${r.why})`).join('; ')}`);
    return `${c.total} links working (${c.same} here, ${c.outside} elsewhere by href, ${c.anchor} on the page${c.mail ? `, ${c.mail} mail` : ''})`;
  }

  /** The demo, in a frame on this page; its own smoke playtest runs there (two players in one room). */
  async function demo() {
    const frame = document.createElement('iframe');
    frame.title = 'Hawkes Net demo, under playtest';
    frame.style.cssText = 'display:block;width:100%;max-width:980px;height:640px;margin:24px auto;border:1px solid #888;border-radius:10px;background:#fff';
    frame.src = `/demo?room=landing-pt-${Math.random().toString(36).slice(2, 8)}`;
    const loaded = new Promise((res) => frame.addEventListener('load', res, { once: true }));
    (document.querySelector('main') ?? document.body).appendChild(frame);
    frame.scrollIntoView({ block: 'center' });
    try {
      await Promise.race([loaded, new Promise((_, rej) => setTimeout(() => rej(new Error('the demo page did not load in 20 s')), 20000))]);
      const w = frame.contentWindow;
      // The demo installs its bot after its module loads; wait for it on a short local tick (no network).
      const t0 = performance.now();
      while (!w.hawkesPlaytest) { if (performance.now() - t0 > 15000) throw new Error('the demo page has no hawkesPlaytest'); await new Promise((r) => setTimeout(r, 100)); }
      event('demo', 'opened /demo in a frame');
      w.hawkesPlaytest.start('smoke'); // not awaited: the contract follows state()
      let st;
      for (;;) {
        st = w.hawkesPlaytest.state();
        if (st.status !== 'idle' && st.status !== 'running') break;
        if (run.done) throw new Error('playtest stopped');
        if (performance.now() - t0 > 90000) throw new Error('the demo smoke did not finish in 90 s');
        if (st.progress !== undefined) progress(0.6 + 0.4 * st.progress);
        await new Promise((r) => setTimeout(r, 500));
      }
      const rep = w.hawkesPlaytest.report();
      for (const l of rep?.log ?? []) log(`demo ${l}`);
      for (const p of rep?.problems ?? []) problem(p.severity, `demo: ${p.message}`);
      return { st, rep };
    } finally {
      // Leave the frame up for a moment so the footage shows the result, then remove it.
      setTimeout(() => frame.remove(), 3000);
    }
  }

  async function smoke() {
    await check('Read the status and version the page showed on load', async () => {
      const l = o.landing;
      if (!l) throw new Error('the page has no status record');
      const s = await l.ready; // resolves when the page's one read of /v1/net/status is in
      if (s.error) throw new Error(`the status read failed: ${s.error}`);
      if (s.health !== 'ok' && s.health !== 'degraded') throw new Error(`status is "${s.health}", wanted ok or degraded`);
      if (!/^\d+\.\d+/.test(String(s.version))) throw new Error(`version "${s.version}" is not a version`);
      const shown = document.getElementById('stateText')?.textContent?.trim();
      if (shown !== s.health) throw new Error(`the page shows "${shown}" but the service said "${s.health}"`);
      metric('status', s.health === 'ok' ? 1 : 0.5); run.state.note = `status ${s.health}, version ${s.version}`;
      event('status', s.health); event('version', s.version);
      return `status ${s.health}, version ${s.version}`;
    });
    progress(0.15);
    await check('Opened the docs page: every link works', () => linksOf('docs', '/docs/api'));
    progress(0.3);
    await check('Opened the quickstart: every link works', () => linksOf('quickstart', '/quickstart'));
    progress(0.5);
    if (location.origin !== origin) problem('bug', 'the bot left the Hawkes Net site');
    let result = null;
    const opened = await check('Opened the demo', async () => { result = await demo(); return `the demo's own smoke ${result.st.status}`; });
    await check('The demo shows two players in one room', async () => {
      if (!opened || !result) throw new Error('the demo did not open');
      const lines = result.rep?.log ?? [];
      const joined = lines.find((l) => /A second player joined the same room/.test(l));
      if (!joined || !joined.startsWith('PASS')) throw new Error(`no second player in the room: ${joined ?? 'check missing'}`);
      if (result.st.status !== 'won') throw new Error(`the demo's two-player check ${result.st.status}: ${lines.filter((l) => l.startsWith('FAIL')).join('; ') || result.st.note}`);
      for (const [k, v] of Object.entries(result.rep.metrics ?? {})) if (typeof v === 'number') metric(`demo_${k}`, v);
      return `${lines.filter((l) => l.startsWith('PASS')).length} demo checks passed`;
    });
    await check('The bot stayed on the Hawkes Net site', async () => {
      if (location.origin !== origin) throw new Error(`now at ${location.origin}`);
      return location.host;
    });
    progress(1);
    finish(run.lines.every((l) => l.ok) ? 'won' : 'lost');
  }

  /** One page in a frame, checked for the site's four promises. */
  async function sitePage(name, path) {
    const frame = document.createElement('iframe');
    frame.title = `Hawkes Net ${name}, under playtest`;
    frame.style.cssText = 'display:block;width:100%;max-width:1100px;height:620px;margin:16px auto;border:1px solid #888;border-radius:10px;background:#0f1115';
    frame.src = path;
    const loaded = new Promise((res) => frame.addEventListener('load', res, { once: true }));
    document.body.appendChild(frame);
    frame.scrollIntoView({ block: 'center' });
    try {
      await Promise.race([loaded, new Promise((_, rej) => setTimeout(() => rej(new Error(`${path} did not load in 20 s`)), 20000))]);
      const w = frame.contentWindow, d = frame.contentDocument;
      const rec = { name, path };
      // 1. the header
      await check(`${name}: the header has Home, Docs, Quickstart and Demo`, async () => {
        const nav = [...d.querySelectorAll('header.site-header nav a')];
        if (!nav.length) throw new Error('no shared header on the page');
        const got = nav.map((a) => `${a.textContent.trim()} ${new URL(a.getAttribute('href'), origin).pathname}`);
        for (const [label, href] of SITE_PAGES) if (!got.some((g) => g === `${label} ${href}`)) throw new Error(`no ${label} link to ${href} (has: ${got.join(', ')})`);
        rec.header = nav.map((a) => a.getAttribute('href')).join(' ');
        return nav.map((a) => a.textContent.trim()).join(' · ');
      });
      // 2. Copy on every code block (real clicks)
      await check(`${name}: every code block has a Copy button that works`, async () => {
        const pres = [...d.querySelectorAll('pre')];
        metric(`${name}CodeBlocks`, pres.length);
        let n = 0;
        for (const pre of pres) {
          const btn = pre.parentElement?.querySelector(':scope > button.copy');
          if (!btn) throw new Error(`a code block has no Copy button: ${pre.textContent.trim().slice(0, 40)}`);
          if (!btn.textContent.includes('Copy')) throw new Error('the Copy button has no label');
          btn.focus(); btn.click();
          const t0 = performance.now();
          while (!btn.classList.contains('copied') && performance.now() - t0 < 2000) await new Promise((r) => setTimeout(r, 25));
          if (!btn.classList.contains('copied')) throw new Error(`Copy did nothing on: ${pre.textContent.trim().slice(0, 40)}`);
          n++;
        }
        event('copy', `${name}: ${n} of ${pres.length}`);
        return pres.length ? `${n} of ${pres.length} blocks copied` : 'no code blocks on this page';
      });
      // 3. AA contrast of every visible text
      await check(`${name}: text and buttons meet AA contrast`, async () => {
        const bad = [];
        let seen = 0, worst = 21;
        const walker = d.createTreeWalker(d.body, NodeFilter.SHOW_TEXT);
        const done = new Set();
        for (let n = walker.nextNode(); n; n = walker.nextNode()) {
          const el = n.parentElement;
          if (!el || done.has(el) || !n.textContent.trim() || ['SCRIPT', 'STYLE', 'NOSCRIPT'].includes(el.tagName)) continue;
          done.add(el);
          const cs = w.getComputedStyle(el);
          if (cs.visibility === 'hidden' || cs.display === 'none' || (el.getClientRects().length === 0)) continue;
          if (el.closest('[disabled], #hawkes-net-playtest')) continue;
          let fg = parseColor(cs.color), bg = null;
          const layers = [];
          for (let e = el; e; e = e.parentElement) { const c = parseColor(w.getComputedStyle(e).backgroundColor); if (c && c[3] > 0) { layers.push(c); if (c[3] >= 1) break; } }
          bg = layers.reduceRight((under, c) => over(c, under), [15, 17, 21, 1]);
          if (!fg) continue;
          fg = over(fg, bg);
          const px = parseFloat(cs.fontSize), large = px >= 24 || (px >= 18.66 && Number(cs.fontWeight) >= 700);
          const ratio = contrastRatio(fg, bg);
          seen++; worst = Math.min(worst, ratio);
          if (ratio < (large ? 3 : 4.5)) bad.push(`"${n.textContent.trim().slice(0, 24)}" ${ratio.toFixed(2)}:1`);
        }
        metric(`${name}WorstContrast`, Math.round(worst * 100) / 100);
        if (!seen) throw new Error('found no text to measure');
        if (bad.length) throw new Error(`${bad.length} below AA: ${bad.slice(0, 4).join('; ')}`);
        return `${seen} texts, the lowest ${worst.toFixed(1)}:1`;
      });
      // 4. no timers, no requests after load
      await check(`${name}: nothing repeats requests on a timer`, async () => {
        const src = await (await fetch(path, { cache: 'no-store' })).text();
        const shared = await (await fetch('/site.js', { cache: 'no-store' })).text();
        if (/setInterval/.test(src) || /setInterval/.test(shared)) throw new Error('the page or the shared script calls setInterval');
        const before = w.performance.getEntriesByType('resource').length;
        await new Promise((r) => setTimeout(r, 2500)); // the one wait here: a quiet page makes no request in it
        const after = w.performance.getEntriesByType('resource').length;
        if (after !== before) throw new Error(`${after - before} request(s) in 2.5 s with the page idle`);
        return `${before} requests at load, none after`;
      });
      rec.header && (run.state.note = `${name} checked`);
      return rec;
    } finally {
      setTimeout(() => frame.remove(), 1200);
    }
  }

  async function site() {
    const pages = [['Home', '/home'], ['Docs', '/docs/api'], ['Quickstart', '/quickstart'], ['Demo', '/demo?room=site-pt-' + Math.random().toString(36).slice(2, 7)], ['Dashboard', '/dashboard']];
    const headers = [];
    for (let i = 0; i < pages.length; i++) {
      try { const r = await sitePage(pages[i][0], pages[i][1]); headers.push(r.header); } catch (e) { await check(`${pages[i][0]}: opened`, () => { throw e; }); }
      progress((i + 1) / pages.length);
    }
    await check('Every page shows the same header', async () => {
      const set = new Set(headers.filter(Boolean));
      if (headers.filter(Boolean).length !== pages.length) throw new Error('a page did not show the header');
      if (set.size !== 1) throw new Error(`headers differ: ${[...set].join(' | ')}`);
      return [...set][0];
    });
    finish(run.lines.every((l) => l.ok) ? 'won' : 'lost');
  }

  const api = {
    version: 1,
    product: 'hawkes-net',
    scenarios: () => scenarios.map((s) => ({ ...s })),
    async start(id, options = {}) {
      const sc = scenarios.find((s) => s.id === id);
      if (run && !run.done) api.stop();
      run = { id, options: { seed: 1, speed: 1, ...options }, t0: performance.now(), moved: performance.now(), done: false, lines: [],
        state: { ready: true, status: 'running', progress: 0, scene: 'Landing' }, metrics: {}, events: [], problems: [], log: [] };
      const mine = run;
      event('start', id); event('scene', 'Landing'); show();
      try {
        if (!sc) { problem('bug', `no playtest scenario "${id}" (have: ${scenarios.map((s) => s.id).join(', ')})`); return finish('error'); }
        await (id === 'site' ? site() : smoke());
      } catch (e) {
        if (mine === run && !mine.done) { problem('bug', `bot error: ${e?.message ?? e}`); log(String(e?.stack ?? e)); finish('error'); }
      }
    },
    stop() { if (run && !run.done) finish('done'); },
    state() {
      const ready = o.landing ? o.landing.settled() : true;
      if (!run) return { ready, status: 'idle' };
      if (!run.done && performance.now() - run.moved > STALL * 1000) { problem('bug', `no progress for ${STALL} s (softlock?)`); finish('stuck'); }
      return { ...run.state, ready, metrics: { ...run.metrics } };
    },
    report() {
      if (!run) return null;
      return { scenario: run.id, outcome: run.done ? run.state.status : 'stuck', seconds: r1(run.seconds ?? now()), metrics: { ...run.metrics },
        events: run.events.slice(), problems: run.problems.slice(), log: [...run.lines.map((l) => `${l.ok ? 'PASS' : l.ok === false ? 'FAIL' : '...'} ${l.text}${l.why ? ` (${l.why})` : ''}`), ...run.log] };
    },
  };
  window.hawkesPlaytest = api;
  addEventListener('error', (e) => problem('bug', `page error: ${e.message ?? e}`));
  addEventListener('unhandledrejection', (e) => problem('bug', `page error: ${e.reason?.message ?? e.reason ?? e}`));
  const auto = new URLSearchParams(location.search).get('playtest');
  if (auto) (o.landing ? o.landing.ready : Promise.resolve()).then(() => api.start(auto));
  return api;
}
