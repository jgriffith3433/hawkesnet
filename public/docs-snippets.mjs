// Shared pieces of the docs playtest: read the quickstart's JS steps, plan the runs, diff printed lines, and judge
// outside links. Used by tools/docs-playtest.mjs (Node: snippets as written) and by /demo's site scenario (live Ada/Bob
// join so Studio's footage shows each criterion). No Node imports: safe in the page.
import { checkLinks, classifyLink } from './landing-playtest.mjs';

export const PROJECT_HOSTS = ['hawkesgen.ai', 'hawkesgames.com'];
export const GITHUB_PREFIX = '/jgriffith3433/hawkesnet';

const unescapeHtml = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
const stripTags = (s) => s.replace(/<[^>]+>/g, '');
const codeOf = (pre) => unescapeHtml(stripTags(pre.replace(/^<pre[^>]*>\s*<code>/, '').replace(/<\/code>\s*<\/pre>$/, ''))).replace(/\n$/, '');

/**
 * The JavaScript tab's steps: [{ id, title, pres: [{ id, code, expect }] }] in page order. A <pre> inside `.expect` is expected
 * output; the other <pre>s are code. Reads the panel with id panel-js, each <li class="step">.
 */
export function readSteps(html, panel = 'js') {
  const p = html.match(new RegExp(`<section[^>]*id="panel-${panel}"[\\s\\S]*?</section>`));
  if (!p) throw new Error(`the quickstart has no ${panel} panel`);
  const steps = [];
  for (const m of p[0].matchAll(/<li class="step" id="([^"]+)">\s*<h2>([\s\S]*?)<\/h2>([\s\S]*?)<\/li>/g)) {
    const body = m[3];
    const at = body.indexOf('<div class="expect">');
    const pres = [];
    for (const pm of body.matchAll(/<pre\b([^>]*)>[\s\S]*?<\/pre>/g)) {
      pres.push({ id: /id="([^"]+)"/.exec(pm[1])?.[1] ?? '', code: codeOf(pm[0]), expect: at >= 0 && pm.index > at });
    }
    steps.push({ id: m[1], title: stripTags(m[2]).trim(), pres });
  }
  return steps;
}

/** The runs of the JS tab: connect, room, and the two-player second step (Ada + Bob expected lines). */
export function planRuns(steps) {
  const by = Object.fromEntries(steps.map((s) => [s.id, s]));
  const need = (id) => { if (!by[id]) throw new Error(`the quickstart's JavaScript tab has no step "${id}"`); return by[id]; };
  const connect = need('js-connect'), room = need('js-room'), second = need('js-second');
  const code = (s, why) => { const x = s.pres.find((q) => !q.expect && /\bimport\b/.test(q.code)); if (!x) throw new Error(`step "${s.title}" (${s.id}) has no ${why} snippet`); return x.code; };
  const outs = (s) => s.pres.filter((q) => q.expect).map((q) => q);
  const first = (s) => { const o = outs(s)[0]; if (!o) throw new Error(`step "${s.title}" (${s.id}) shows no output to expect`); return o.code.split('\n').filter(Boolean); };
  const ada = second.pres.find((q) => q.id === 'expect-node-ada'), bob = second.pres.find((q) => q.id === 'expect-node-bob');
  if (!ada || !bob) throw new Error(`step "${second.title}" (${second.id}) does not show Ada's and Bob's output`);
  return {
    connect: { name: `${connect.id} "${connect.title}"`, script: code(connect, 'runnable'), expected: first(connect) },
    room: { name: `${room.id} "${room.title}"`, script: code(room, 'runnable'), expected: first(room) },
    second: { name: `${second.id} "${second.title}"`, adaExpected: ada.code.split('\n').filter(Boolean), bobExpected: bob.code.split('\n').filter(Boolean) },
  };
}

/** Does `got` (stdout lines) equal `want`, in any order? Returns '' when it does, else what differs. */
export function diffLines(want, got) {
  const miss = [...want], extra = [];
  for (const l of got) { const i = miss.indexOf(l); if (i >= 0) miss.splice(i, 1); else extra.push(l); }
  return [miss.length ? `missing: ${miss.map((l) => `"${l}"`).join(', ')}` : '', extra.length ? `unexpected: ${extra.map((l) => `"${l}"`).join(', ')}` : ''].filter(Boolean).join('; ');
}

/** Rewrite the quickstart's expected lines for a live room name (docs say "first-room"). */
export function expectForRoom(lines, room) {
  return lines.map((l) => l.replace(/"first-room"/g, JSON.stringify(room)));
}

/** An outside link must go to a Hawkes host (or the hawkesnet repositories on GitHub), over https. Returns '' or why not. */
export function judgeOutside(href, pageUrl, origin) {
  const c = classifyLink(href, pageUrl, origin);
  if (c.kind !== 'outside') return '';
  if (!c.secure) return 'plain http';
  if (PROJECT_HOSTS.some((h) => c.host === h || c.host.endsWith(`.${h}`))) return '';
  if (c.host === 'github.com' && new URL(c.url).pathname.startsWith(GITHUB_PREFIX)) return '';
  return `off the Hawkes Net site (${c.host})`;
}

/** Every link of one page: same-site ones must answer 200, outside ones must be on the Hawkes list. Returns [{ href, why }] of the broken. */
export async function judgeLinks(html, { pageUrl, origin, fetchFn }) {
  const out = await checkLinks(html, { pageUrl, origin, fetchFn });
  const broken = out.failed.map((r) => ({ href: r.href, why: r.why }));
  for (const r of out.results) { const w = r.kind === 'outside' ? judgeOutside(r.href, pageUrl, origin) : ''; if (w) broken.push({ href: r.href, why: w }); }
  return { broken, total: out.counts.total };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms) { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (fn()) return true; await sleep(80); } return fn(); }

/**
 * Live Ada/Bob join that mirrors the quickstart's JS snippets (same greet / chat lines), for /demo's site scenario.
 * `joinFn(room, name)` returns a Room (project/endpoint chosen by the page). Room name is unique; expected lines are
 * rewritten from the docs' "first-room". `report(name, ok, detail)` and optional `on(type, detail)` get each step.
 */
export async function runLiveDocsSnippets(plan, { joinFn, room, report, on = () => {}, timeout = 20000, quiet = 400 }) {
  let okAll = true;
  // `report` (the caller's) gets each verdict; `on` gets what a person would watch: the snippet starting, every line a terminal prints
  // (`snippet-out`), the lines the step says to expect (`snippet-expect`) and then the verdict (`snippet` / `snippet-fail`, from report's caller).
  const judge = (name, ok, detail) => { okAll &&= ok; report(name, ok, detail); };
  const run = (name, what) => on('snippet-run', `${name}: ${what}`);
  const expecting = (who, want) => on('snippet-expect', `${who} should see: ${want.join(' / ')}`);
  const open = async (name) => {
    const me = await joinFn(room, name);
    const lines = [];
    const log = (l) => { lines.push(l); on('snippet-out', `${name}> ${l}`); };
    log(`${name} is in ${JSON.stringify(room)} on the ${me.transport}`);
    const greet = (peer) => { log(`${name} sees ${peer.name} arrive`); me.send('chat', `hello ${peer.name}`); };
    for (const peer of me.peers.values()) if (peer.id !== me.id) greet(peer);
    me.when('peer:join', greet);
    me.on('chat', (text, from) => log(`${name} heard ${from.name}: ${text}`));
    return { me, lines: () => lines.slice(), stop: async () => { try { await me.leave(); } catch { /* gone */ } } };
  };
  let ada = null, bob = null;
  try {
    // js-connect: join, print the one line, leave.
    {
      const want = expectForRoom(plan.connect.expected, room);
      run(plan.connect.name, 'running as Ada: join, print one line, leave');
      const p = await open('Ada');
      expecting('Ada', want);
      await sleep(quiet);
      const d = diffLines(want, p.lines());
      judge(plan.connect.name, !d, d || `printed ${p.lines().join(' / ')}`);
      await p.stop();
    }
    // js-room then js-second: Ada waits, Bob joins; both print the docs' lines.
    run(plan.room.name, 'running as Ada: join a room and listen');
    ada = await open('Ada');
    {
      const want = expectForRoom(plan.room.expected, room);
      expecting('Ada', want);
      const first = await until(() => ada.lines().length >= want.length, timeout);
      await sleep(quiet);
      const d = diffLines(want, ada.lines());
      judge(plan.room.name, first && !d, first ? (d || `printed ${ada.lines().join(' / ')}`) : `no output in ${timeout / 1000} s`);
    }
    run(plan.second.name, 'Bob starts the same script in a second terminal');
    const wantA = expectForRoom(plan.second.adaExpected, room);
    const wantB = expectForRoom(plan.second.bobExpected, room);
    expecting('Ada', wantA); expecting('Bob', wantB);
    bob = await open('Bob');
    const gotAll = await until(() => ada.lines().length >= wantA.length && bob.lines().length >= wantB.length, timeout);
    await sleep(quiet);
    const dA = diffLines(wantA, ada.lines()), dB = diffLines(wantB, bob.lines());
    const bad = [dA && `Ada's terminal ${dA}`, dB && `Bob's terminal ${dB}`].filter(Boolean).join('; ');
    judge(plan.second.name, gotAll && !bad, bad || (gotAll ? 'both terminals print what the step says' : `not complete in ${timeout / 1000} s`));
  } finally {
    await Promise.all([ada?.stop(), bob?.stop()].filter(Boolean));
  }
  return okAll;
}
