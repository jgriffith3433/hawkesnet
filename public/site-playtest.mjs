// The site checks of Hawkes Studio's playtest at /demo: the status and version, and the pages a visitor reads (the landing
// page /home, the docs /docs/errors and the quickstart): every link on them, the shared header and a Copy button on every
// code block. /demo's `site` scenario runs them, and the end of /demo's `smoke` does too, so a plain smoke run covers them.
// (Wired in public/demo.html; public/demo-playtest.mjs is shared with hawkesnet-js and hawkesnet-babylon and stays as it is.)
//
// One fetch per check, no polling: /v1/net/status once, each page once (its links by one fetch each through landing-playtest's
// checkLinks: this site by fetch, other sites by href only), each page once in a frame for the header and the Copy buttons
// (site.js draws both in the browser, so the page's text alone doesn't have them). The bot never navigates away from /demo.
import { checkLinks } from './landing-playtest.mjs';

export const SITE_CHECK_PAGES = [['Home', '/home'], ['Docs', '/docs/errors'], ['Quickstart', '/quickstart']];
export const PHONE_PAGES = [['Home', '/home'], ['Docs', '/docs/errors'], ['Quickstart', '/quickstart'], ['Demo', '/demo']];
export const PHONE_W = 390;
export const HEADER_LINKS = ['Home', 'Docs', 'Quickstart', 'Demo'];

/** The status read: health must be ok or degraded and the version a version. Returns { health, version } or throws. */
export function judgeStatus(s) {
  const health = s?.health || (s?.up ? 'ok' : 'down');
  if (health !== 'ok' && health !== 'degraded') throw new Error(`status is "${health}", wanted ok or degraded`);
  const version = String(s?.version ?? '');
  const m = version.match(/^(\d+)\.(\d+)(?:\.(\d+))?/);
  if (!m) throw new Error(`version "${version}" is not a version`);
  return { health, version, parts: [Number(m[1]), Number(m[2]), Number(m[3] ?? 0)] };
}

/** `links` is [{ text, href }] from the page's header nav: Home, Docs, Quickstart and Demo must all be there, pointing at their pages. */
export function judgeHeader(links) {
  if (!links?.length) throw new Error('no shared header on the page');
  const want = { Home: ['/', '/home'], Docs: ['/docs/errors'], Quickstart: ['/quickstart'], Demo: ['/demo'] };
  const got = [];
  for (const name of HEADER_LINKS) {
    const l = links.find((x) => x.text === name);
    if (!l) throw new Error(`the header has no "${name}" link (has: ${links.map((x) => x.text).join(', ')})`);
    if (!want[name].includes(l.path)) throw new Error(`the header's ${name} goes to ${l.path}, wanted ${want[name].join(' or ')}`);
    got.push(`${name} ${l.path}`);
  }
  return got.join(', ');
}

/** `blocks` is [{ copy: number }]: how many Copy buttons each code block (<pre>) has. */
export function judgeCopy(blocks) {
  if (!blocks.length) throw new Error('found no code block on the page');
  const bad = blocks.map((b, i) => [i + 1, b.copy]).filter(([, n]) => n !== 1);
  if (bad.length) throw new Error(`${bad.length} of ${blocks.length} code blocks without exactly one Copy button (block ${bad.slice(0, 5).map(([i, n]) => `${i}: ${n}`).join(', ')})`);
  return `${blocks.length} code blocks, each with a Copy button`;
}

/**
 * `p` is what phoneReader measured at 390 px: { width, scrollWidth, menuShown, navHiddenBefore, navShownAfter, expandedAfter, minFont, wideBlocks }.
 * No sideways scroll, a Menu button that opens the nav on tap, text of 12 px or more, and no code block or table wider than the page that doesn't scroll itself.
 */
export function judgePhone(p) {
  if (!p) throw new Error('no phone measure for the page');
  if (p.scrollWidth > p.width) throw new Error(`the page scrolls sideways at ${p.width} px: it is ${p.scrollWidth} px wide`);
  if (!p.menuShown) throw new Error('no Menu button at phone size');
  if (!p.navHiddenBefore) throw new Error('the nav is not folded before the Menu is tapped');
  if (!p.navShownAfter || !p.expandedAfter) throw new Error('tapping Menu did not open the nav');
  if (p.minFont < 12) throw new Error(`text as small as ${p.minFont} px (wanted 12 or more)`);
  if (p.wideBlocks) throw new Error(`${p.wideBlocks} code block(s) or table(s) don't scroll inside themselves`);
  return `no sideways scroll at ${p.width} px, Menu opens the nav, smallest text ${p.minFont} px`;
}

/** Opens `path` in a phone-wide frame, taps Menu, and measures the page. */
export async function phoneReader(path) {
  const frame = document.createElement('iframe');
  frame.title = `Hawkes Net ${path}, at phone size`;
  frame.style.cssText = `position:fixed;left:-9999px;top:0;width:${PHONE_W}px;height:844px;border:0`;
  frame.src = path;
  const loaded = new Promise((res) => frame.addEventListener('load', res, { once: true }));
  document.body.appendChild(frame);
  try {
    await Promise.race([loaded, new Promise((_, rej) => setTimeout(() => rej(new Error(`${path} did not load in 20 s`)), 20000))]);
    const d = frame.contentDocument, w = frame.contentWindow;
    const menu = d.querySelector('header.site-header .menu'), nav = d.querySelector('header.site-header nav');
    const shown = (el) => !!el && w.getComputedStyle(el).display !== 'none';
    const out = { width: w.innerWidth, menuShown: shown(menu), navHiddenBefore: !shown(nav) };
    menu?.click();
    out.navShownAfter = shown(nav); out.expandedAfter = menu?.getAttribute('aria-expanded') === 'true';
    menu?.click();
    out.scrollWidth = d.documentElement.scrollWidth;
    let min = 99;
    const walker = d.createTreeWalker(d.body, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const el = n.parentElement;
      if (!n.textContent.trim() || !el || ['SCRIPT', 'STYLE', 'CANVAS'].includes(el.tagName) || !el.getClientRects().length) continue;
      const cs = w.getComputedStyle(el);
      if (cs.visibility === 'hidden') continue;
      min = Math.min(min, parseFloat(cs.fontSize));
    }
    out.minFont = min === 99 ? 0 : Math.round(min * 10) / 10;
    out.wideBlocks = [...d.querySelectorAll('pre, table')].filter((e) => e.getBoundingClientRect().right > out.width + 1 && !['auto', 'scroll'].includes(w.getComputedStyle(e).overflowX)).length;
    return out;
  } finally { frame.remove(); }
}

/** Opens `path` in a frame under the playtest's page, reads the header and the code blocks once the page loaded, and removes the frame. */
export async function frameReader(path, { origin = location.origin } = {}) {
  const frame = document.createElement('iframe');
  frame.title = `Hawkes Net ${path}, under playtest`;
  frame.style.cssText = 'position:fixed;left:-9999px;top:0;width:1100px;height:700px;border:0';
  frame.src = path;
  const loaded = new Promise((res) => frame.addEventListener('load', res, { once: true }));
  document.body.appendChild(frame);
  try {
    await Promise.race([loaded, new Promise((_, rej) => setTimeout(() => rej(new Error(`${path} did not load in 20 s`)), 20000))]);
    const d = frame.contentDocument;
    return {
      header: [...d.querySelectorAll('header.site-header nav a')].map((a) => ({ text: a.textContent.trim(), path: new URL(a.getAttribute('href'), origin).pathname })),
      blocks: [...d.querySelectorAll('pre')].map((pre) => ({ copy: pre.parentElement?.classList.contains('codeblock') ? pre.parentElement.querySelectorAll(':scope > button.copy').length : 0 })),
    };
  } finally { frame.remove(); }
}

/**
 * The checks, as named checks of the playtest that runs them: `check(name, fn)` and `metric(key, value)` are the playtest's.
 * `fetchFn` is fetch, `read(path)` is frameReader (both replaced in tests), `log` and `progress` are optional.
 */
export async function siteChecks({ check, metric, log = () => {}, progress = () => {}, note = () => {}, origin = location.origin,
  fetchFn = (u, init) => fetch(u, { ...init, cache: 'no-store' }), read = frameReader, phoneRead = phoneReader }) {
  await check('Status and version: the service is ok or degraded and has a version', async () => {
    const res = await fetchFn(`${origin}/v1/net/status`);
    if (!res.ok) throw new Error(`/v1/net/status answered ${res.status}`);
    const s = judgeStatus(await res.json());
    metric('status', s.health === 'ok' ? 1 : 0.5);
    metric('versionMajor', s.parts[0]); metric('versionMinor', s.parts[1]); metric('versionPatch', s.parts[2]);
    note(`status ${s.health}, version ${s.version}`);
    return `status ${s.health}, version ${s.version}`;
  });
  progress(0.2);
  let i = 0;
  for (const [name, path] of SITE_CHECK_PAGES) {
    const key = name.toLowerCase();
    await check(`${name} (${path}): every link works`, async () => {
      const url = origin + path;
      const res = await fetchFn(url);
      if (!res.ok) throw new Error(`${path} answered ${res.status}`);
      const out = await checkLinks(await res.text(), { pageUrl: url, origin, fetchFn });
      const c = out.counts;
      metric(`${key}Links`, c.total); metric(`${key}LinksBroken`, out.failed.length);
      for (const r of out.results) log(`${name} link ${r.ok ? 'ok' : 'BROKEN'} ${r.kind} ${r.href} (${r.why})`);
      if (!c.total) throw new Error(`no links found on ${path}`);
      if (out.failed.length) throw new Error(`${out.failed.length} of ${c.total} broken: ${out.failed.slice(0, 4).map((r) => `${r.href} (${r.why})`).join('; ')}`);
      return `${c.total} links working (${c.same} here, ${c.outside} elsewhere by href, ${c.anchor} on the page${c.mail ? `, ${c.mail} mail` : ''})`;
    });
    let page = null, pageError = null;
    try { page = await read(path); } catch (e) { pageError = e; }
    await check(`${name} (${path}): the shared header has Home, Docs, Quickstart and Demo`, async () => {
      if (pageError) throw pageError;
      const why = judgeHeader(page.header);
      metric(`${key}Header`, 1);
      return why;
    });
    await check(`${name} (${path}): every code block has a Copy button`, async () => {
      if (pageError) throw pageError;
      const why = judgeCopy(page.blocks);
      metric(`${key}CodeBlocks`, page.blocks.length);
      return why;
    });
    progress(0.2 + 0.5 * (++i / SITE_CHECK_PAGES.length));
  }
  // Phone size (390 px wide): each page once in a narrow frame.
  let j = 0;
  for (const [name, path] of PHONE_PAGES) {
    await check(`${name} (${path}) at phone size (${PHONE_W} px): no sideways scroll, the nav folds into a Menu that opens on tap, text is readable`, async () => {
      const p = await phoneRead(path);
      const why = judgePhone(p);
      metric(`${name.toLowerCase()}PhoneOverflow`, Math.max(0, p.scrollWidth - p.width)); metric(`${name.toLowerCase()}MinFont`, p.minFont);
      return why;
    });
    progress(0.7 + 0.3 * (++j / PHONE_PAGES.length));
  }
}

/**
 * Adds the `site` scenario to a page's hawkesPlaytest `api` (the one installNetPlaytest returned) without changing the
 * others: scenarios() lists it, start('site') runs the checks above on their own, and state(), report() and stop() answer
 * for it while it is the current run. Every other id goes to the original start.
 */
export function addSiteScenario(api, { origin = location.origin, fetchFn, read, phoneRead, where = location.host } = {}) {
  const scenario = { id: 'site', title: 'The status and version, and the docs, quickstart and home pages: every link, the shared header, a Copy button on each code block', seconds: 40, tags: ['smoke', 'site'],
    description: 'Reads /v1/net/status once (ok or degraded, and the version), fetches /home, /docs/errors and the quickstart and checks every link on them (this site by one fetch each, other sites by their href only, never opened), and checks each page has the shared header (Home, Docs, Quickstart, Demo) and a Copy button on every code block, then opens each page (and /demo) 390 px wide: no sideways scroll, the nav folds into a Menu that opens on tap, text readable. Also runs at the end of the smoke scenario.' };
  const original = { scenarios: api.scenarios, start: api.start, state: api.state, report: api.report, stop: api.stop };
  let run = null;
  const r1 = (n) => Math.round(n * 10) / 10;
  const now = () => (run ? (performance.now() - run.t0) / 1000 : 0);
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  const panel = typeof document === 'undefined' ? null : document.createElement('div');
  if (panel) { panel.id = 'hawkes-net-site-playtest'; panel.style.cssText = 'position:fixed;right:12px;top:12px;z-index:99999;max-width:420px;background:rgba(10,12,16,.86);color:#e8eaed;font:12px/1.5 ui-monospace,Menlo,monospace;padding:8px 12px;border-radius:8px;display:none;pointer-events:none'; }
  const show = () => {
    if (!run || !panel) return;
    if (!panel.isConnected) document.body.appendChild(panel);
    panel.style.display = 'block';
    const head = run.done ? (run.state.status === 'won' ? '<b style="color:#9fe870">PASS</b>' : `<b style="color:#ff7b72">${run.state.status === 'lost' ? 'FAIL' : run.state.status.toUpperCase()}</b>`) : '<b style="color:#ffd84d">running</b>';
    panel.innerHTML = `Playtest site on ${esc(where)} · ${head}<br>` + run.lines.map((l) => `${l.ok === true ? '<span style="color:#9fe870">✓</span>' : l.ok === false ? '<span style="color:#ff7b72">✗</span>' : '…'} ${esc(l.text)}${l.why ? ` <span style="color:#9aa1ad">(${esc(l.why)})</span>` : ''}`).join('<br>');
  };
  const event = (type, detail) => { run.events.push({ t: r1(now()), type, ...(detail === undefined ? {} : { detail: String(detail) }) }); run.moved = performance.now(); };
  const problem = (message) => { if (!run.problems.some((p) => p.message === message)) { run.problems.push({ severity: 'bug', message }); event('problem', `bug: ${message}`); } };
  const finish = (outcome) => {
    if (run.done) return;
    run.done = true; run.state.status = outcome; run.seconds = now();
    if (outcome === 'won') run.state.note = run.note || 'all checks passed'; else run.state.note = `${run.lines.filter((l) => l.ok === false).length} check(s) failed`;
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
      problem(`${text}: ${line.why}`); event('fail', text); run.metrics.checksFailed = (run.metrics.checksFailed ?? 0) + 1;
    }
    show();
    return line.ok;
  }
  const mine = () => run && !run.done;

  api.scenarios = () => [...original.scenarios(), { ...scenario }];
  api.start = async (id, options = {}) => {
    if (id !== 'site') { run = null; panel?.remove(); return original.start(id, options); }
    if (!run?.done && original.stop) original.stop();
    run = { t0: performance.now(), moved: performance.now(), done: false, lines: [], log: [], events: [], problems: [], metrics: {}, note: '',
      state: { ready: true, status: 'running', progress: 0, scene: 'Demo' } };
    const me = run;
    event('start', 'site'); event('scene', 'Demo'); show();
    try {
      await siteChecks({ check, metric: (k, v) => { me.metrics[k] = v; }, origin, fetchFn, read, phoneRead, note: (s) => { me.note = s; },
        log: (l) => { me.log.push(`${r1(now())}s ${l}`); if (me.log.length > 300) me.log.shift(); },
        progress: (p) => { me.state.progress = Math.max(0, Math.min(1, p)); me.moved = performance.now(); } });
      if (typeof location !== 'undefined' && location.origin !== origin) problem('the bot left the Hawkes Net site');
      finish(me.lines.every((l) => l.ok) ? 'won' : 'lost');
    } catch (e) {
      if (me === run && !me.done) { problem(`bot error: ${e?.message ?? e}`); finish('error'); }
    }
  };
  api.state = () => {
    if (!run) return original.state();
    const base = original.state();
    if (!run.done && performance.now() - run.moved > 60 * 1000) { problem('no progress for 60 s (softlock?)'); finish('stuck'); }
    return { ...run.state, ready: base.ready, metrics: { ...run.metrics } };
  };
  api.report = () => {
    if (!run) return original.report();
    return { scenario: 'site', outcome: run.done ? run.state.status : 'stuck', seconds: r1(run.seconds ?? now()), metrics: { ...run.metrics },
      events: run.events.slice(), problems: run.problems.slice(), log: [...run.lines.map((l) => `${l.ok ? 'PASS' : l.ok === false ? 'FAIL' : '...'} ${l.text}${l.why ? ` (${l.why})` : ''}`), ...run.log] };
  };
  api.stop = () => { if (mine()) finish('done'); return original.stop(); };
  return api;
}

/**
 * Puts the page's own input into the run's events. The shared bot's events only say which checks ran; a drag or a tap on the
 * arena is seen by the page, so the page reports it (`note(type, detail)`, returned here) and the report of the run that is
 * current carries it in order with the bot's events: { t, type: 'drag', detail: 'touch: 4 moves, from 288,300 to 480,330' }.
 * Works with the original `start` and with a run the address started (?playtest=smoke) before this was called.
 */
export function addInputEvents(api) {
  let t0 = null, list = [];
  const original = { start: api.start, report: api.report };
  const r1 = (n) => Math.round(n * 10) / 10;
  const early = original.report?.(); // a run that began at load (?playtest=...): its clock is seconds old now
  if (early) t0 = performance.now() - early.seconds * 1000;
  api.start = (id, options) => { t0 = performance.now(); list = []; return original.start(id, options); };
  api.report = () => {
    const r = original.report();
    if (!r || !list.length) return r;
    return { ...r, events: [...r.events, ...list].sort((a, b) => a.t - b.t) };
  };
  return (type, detail) => { if (t0 !== null && list.length < 200) list.push({ t: r1((performance.now() - t0) / 1000), type, detail: String(detail) }); };
}
