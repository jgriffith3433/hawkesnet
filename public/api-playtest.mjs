// API reference checks for /docs/api (generated from the SDK's JSDoc). Wired from demo.html; the shared
// demo-playtest.mjs stays free of hawkesnet-only checks (same pattern as site-playtest.mjs).
//
// Acceptance: every export/method/event lists an example; typing in the search box narrows the list
// client-side (no server calls); error-code links open their entry on /docs/errors.

export const API_PATH = '/docs/api';
export const API_PHONE_W = 390;

/**
 * Reads the live /docs/api page in a frame: counts, search filtering, and one error-code hop.
 * `readApi(path, width?)` opens the page (replaced in tests). Real input only: the search box gets typed
 * characters; an error-code link is clicked.
 */
export async function apiChecks({
  check,
  metric,
  event = () => {},
  progress = () => {},
  wait = (ms) => new Promise((r) => setTimeout(r, ms)),
  origin = typeof location !== 'undefined' ? location.origin : '',
  readApi = defaultReadApi,
}) {
  let page = null;
  await check('API reference lists every export, method and event with an example', async () => {
    page = await readApi(API_PATH, 1100);
    const { exports, methods, events, options, missingExample } = page.counts;
    metric('apiExports', exports);
    metric('apiMethods', methods);
    metric('apiEvents', events);
    metric('apiOptions', options);
    metric('apiMissingExample', missingExample);
    if (exports < 1) throw new Error('no exports listed');
    if (methods < 1) throw new Error('no methods listed');
    if (events < 1) throw new Error('no events listed');
    if (missingExample > 0) throw new Error(`${missingExample} API entr${missingExample === 1 ? 'y has' : 'ies have'} no example`);
    event('api-listed', `${exports} exports, ${methods} methods, ${options} options, ${events} events`);
    return `${exports} exports, ${methods} methods, ${options} options, ${events} events, each with an example`;
  });
  progress(0.35);

  await check('Typing in the search box narrows the list instantly (no server call)', async () => {
    if (!page) throw new Error('API page was not opened');
    const before = page.shown;
    if (before < 2) throw new Error(`only ${before} entries shown before filtering`);
    const filter = await page.typeSearch('join');
    if (filter.fetchCount !== 0) throw new Error(`search triggered ${filter.fetchCount} fetch(es); wanted none`);
    if (!(filter.shown > 0 && filter.shown < before)) {
      throw new Error(`filter "join" left ${filter.shown} of ${before} shown`);
    }
    metric('apiSearchBefore', before);
    metric('apiSearchAfter', filter.shown);
    metric('apiSearchFetches', filter.fetchCount);
    event('api-search', `join → ${filter.shown} of ${before}, ${filter.fetchCount} fetches`);
    await page.typeSearch(''); // clear for the next check
    return `"join" narrowed ${before} → ${filter.shown} with ${filter.fetchCount} server calls`;
  });
  progress(0.7);

  await check('Error codes in the reference open their entry on the error codes page', async () => {
    if (!page) throw new Error('API page was not opened');
    const hop = await page.openErrorCode();
    if (!hop.href) throw new Error('no error-code link on the API reference');
    if (!hop.href.includes('/docs/errors#')) throw new Error(`error link went to ${hop.href}, wanted /docs/errors#…`);
    const code = hop.href.split('#')[1] || '';
    if (!code) throw new Error(`error link ${hop.href} has no fragment`);
    if (!hop.landedOk) throw new Error(`/docs/errors#${code} did not show that row (status ${hop.status})`);
    metric('apiErrorHop', 1);
    event('api-error-link', hop.href);
    return `${hop.href} opens the ${code} row`;
  });
  progress(0.85);
  try { page?.dispose?.(); } catch { /* gone */ }
  page = null;

  // Phone-size pass of the same page (layout only; criteria above already cover content).
  let phone = null;
  await check(`API reference at phone size (${API_PHONE_W} px): search and entries stay usable`, async () => {
    phone = await readApi(API_PATH, API_PHONE_W);
    if (phone.scrollWidth > phone.width + 1) {
      throw new Error(`the page scrolls sideways at ${phone.width} px: it is ${phone.scrollWidth} px wide`);
    }
    if (!phone.hasSearch) throw new Error('no search box at phone size');
    if (phone.counts.exports + phone.counts.methods + phone.counts.events < 3) {
      throw new Error('API entries missing at phone size');
    }
    metric('apiPhoneOverflow', Math.max(0, phone.scrollWidth - phone.width));
    return `no sideways scroll at ${phone.width} px, search present, ${phone.shown} entries`;
  });
  progress(1);
  try { phone?.dispose?.(); } catch { /* gone */ }
}

/** Opens `/docs/api` in a frame, returns helpers that type into the search box and open an error-code link. */
export async function defaultReadApi(path, width = 1100) {
  const frame = document.createElement('iframe');
  frame.title = `Hawkes Net ${path}`;
  frame.style.cssText = `position:fixed;left:-9999px;top:0;width:${width}px;height:844px;border:0`;
  frame.src = path;
  const loaded = new Promise((res) => frame.addEventListener('load', res, { once: true }));
  document.body.appendChild(frame);
  try {
    await Promise.race([loaded, new Promise((_, rej) => setTimeout(() => rej(new Error(`${path} did not load in 20 s`)), 20000))]);
    // site.js is defer: wait a tick so the header and Copy buttons land.
    await new Promise((r) => setTimeout(r, 50));
    const d = frame.contentDocument;
    const w = frame.contentWindow;
    if (!d || !w) throw new Error(`${path} has no document`);

    const countKind = (kind) => d.querySelectorAll(`.api-item[data-kind="${kind}"]`).length;
    const missingExample = [...d.querySelectorAll('.api-item')].filter((el) => !el.querySelector('pre.api-example')).length;
    const items = () => [...d.querySelectorAll('.api-item')];
    const shownCount = () => items().filter((el) => !el.hidden).length;

    // Count fetches the page itself triggers after load (search must add none).
    let fetchCount = 0;
    const origFetch = w.fetch?.bind(w);
    if (origFetch) {
      w.fetch = (...args) => { fetchCount += 1; return origFetch(...args); };
    }

    const input = d.getElementById('api-search');
    const typeSearch = async (q) => {
      if (!input) throw new Error('no #api-search on the page');
      fetchCount = 0;
      input.focus();
      input.value = '';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      for (const ch of String(q)) {
        input.value += ch;
        input.dispatchEvent(new Event('input', { bubbles: true }));
      }
      input.dispatchEvent(new Event('search', { bubbles: true }));
      return { shown: shownCount(), fetchCount };
    };

    const openErrorCode = async () => {
      const a = d.querySelector('a.err-code[href*="/docs/errors#"]');
      if (!a) return { href: '', landedOk: false, status: 0 };
      const href = a.getAttribute('href') || '';
      const code = href.split('#')[1] || '';
      // Real click path: navigate a second frame to the absolute errors URL (bot stays on /demo).
      const abs = new URL(href, w.location.href).href;
      a.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: w }));
      const res = await fetch(abs.split('#')[0], { cache: 'no-store' });
      const html = await res.text();
      const landedOk = res.ok && html.includes(`id="${code}"`);
      return { href, landedOk, status: res.status };
    };

    return {
      width: w.innerWidth,
      scrollWidth: d.documentElement.scrollWidth,
      hasSearch: !!input,
      shown: shownCount(),
      counts: {
        exports: countKind('export'),
        methods: countKind('method'),
        options: countKind('option'),
        events: countKind('event'),
        missingExample,
      },
      typeSearch,
      openErrorCode,
      dispose: () => frame.remove(),
    };
  } catch (e) {
    frame.remove();
    throw e;
  }
}

/**
 * Adds the `api` scenario to a page's hawkesPlaytest `api` without changing the others.
 */
export function addApiScenario(api, { origin = typeof location !== 'undefined' ? location.origin : '', readApi, where = typeof location !== 'undefined' ? location.host : '' } = {}) {
  const scenario = {
    id: 'api',
    title: 'API reference: every export/method/event with an example, search filters the list, error codes open /docs/errors',
    seconds: 30,
    tags: ['docs', 'api'],
    description: 'Opens /docs/api in a frame on /demo, checks every export, method and event has an example, types in the search box to narrow the list with no server calls, and follows an error-code link to its row on /docs/errors.',
  };
  const original = { scenarios: api.scenarios, start: api.start, state: api.state, report: api.report, stop: api.stop };
  let run = null;
  const r1 = (n) => Math.round(n * 10) / 10;
  const now = () => (run ? (performance.now() - run.t0) / 1000 : 0);
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  const panel = typeof document === 'undefined' ? null : document.createElement('div');
  if (panel) {
    panel.id = 'hawkes-net-api-playtest';
    panel.style.cssText = 'position:fixed;right:12px;top:12px;z-index:99999;max-width:420px;background:rgba(10,12,16,.86);color:#e8eaed;font:12px/1.5 ui-monospace,Menlo,monospace;padding:8px 12px;border-radius:8px;display:none;pointer-events:none';
  }
  const show = () => {
    if (!run || !panel) return;
    if (!panel.isConnected) document.body.appendChild(panel);
    panel.style.display = 'block';
    const head = run.done ? (run.state.status === 'won' ? '<b style="color:#9fe870">PASS</b>' : `<b style="color:#ff7b72">${run.state.status === 'lost' ? 'FAIL' : run.state.status.toUpperCase()}</b>`) : '<b style="color:#ffd84d">running</b>';
    panel.innerHTML = `Playtest api on ${esc(where)} · ${head}<br>` + run.lines.map((l) => `${l.ok === true ? '<span style="color:#9fe870">✓</span>' : l.ok === false ? '<span style="color:#ff7b72">✗</span>' : '…'} ${esc(l.text)}${l.why ? ` <span style="color:#9aa1ad">(${esc(l.why)})</span>` : ''}`).join('<br>');
  };
  const event = (type, detail) => { run.events.push({ t: r1(now()), type, ...(detail === undefined ? {} : { detail: String(detail) }) }); run.moved = performance.now(); };
  const problem = (message) => { if (!run.problems.some((p) => p.message === message)) { run.problems.push({ severity: 'bug', message }); event('problem', `bug: ${message}`); } };
  const finish = (outcome) => {
    if (run.done) return;
    run.done = true; run.state.status = outcome; run.seconds = now();
    run.state.note = outcome === 'won' ? (run.note || 'all checks passed') : `${run.lines.filter((l) => l.ok === false).length} check(s) failed`;
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
  const wait = (ms) => new Promise((res, rej) => { const r = run; setTimeout(() => (r === run && !r.done ? res() : rej(new Error('playtest stopped'))), ms); });
  const mine = () => run && !run.done;

  api.scenarios = () => [...original.scenarios(), { ...scenario }];
  api.start = async (id, options = {}) => {
    if (id !== 'api') { run = null; panel?.remove(); return original.start(id, options); }
    if (!run?.done && original.stop) original.stop();
    run = {
      t0: performance.now(), moved: performance.now(), done: false, lines: [], log: [], events: [], problems: [], metrics: {}, note: '',
      state: { ready: true, status: 'running', progress: 0, scene: 'Docs' },
    };
    const me = run;
    event('start', 'api'); event('scene', 'Docs'); show();
    try {
      await apiChecks({
        check,
        metric: (k, v) => { me.metrics[k] = v; },
        event,
        wait,
        origin,
        readApi,
        progress: (p) => { me.state.progress = Math.max(0, Math.min(1, p)); me.moved = performance.now(); },
      });
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
    return {
      scenario: 'api',
      outcome: run.done ? run.state.status : 'stuck',
      seconds: r1(run.seconds ?? now()),
      metrics: { ...run.metrics },
      events: run.events.slice(),
      problems: run.problems.slice(),
      log: [...run.lines.map((l) => `${l.ok ? 'PASS' : l.ok === false ? 'FAIL' : '...'} ${l.text}${l.why ? ` (${l.why})` : ''}`), ...run.log],
    };
  };
  api.stop = () => { if (mine()) finish('done'); return original.stop(); };
  return api;
}
