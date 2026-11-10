// The Hawkes Net service (net.hawkesgen.ai, its own box: J, 2026-10-25). One process serves Hawkes Net's routes
// (tickets, the directory, publish, room info, node heartbeats, keys, status, the SDK files: api.ts) from its own data
// folder (store.ts), and runs a relay node with worker processes (node.ts). More relay boxes join by running node.ts with
// NET_GEN_URL pointed here. Hawkes Gen is asked only to check API keys (GET /v1/net/whoami, kept a minute) and is sent
// usage once a minute (POST /v1/net/usage with this service's own "hawkesnet" key); nothing here imports Gen.
//
//   node src/hub.ts        settings from the environment (the box: /etc/hawkes/net.env, written by deploy/setup.mjs):
//     NET_PORT (8800), NET_HOST (127.0.0.1: Caddy in front), NET_DATA_DIR (the directory and signing keys),
//     NET_GEN_URL (https://hawkesgen.ai), NET_GEN_KEY (a Gen key for the project "hawkesnet"),
//     NET_PUBLIC_URL (wss://net.hawkesgen.ai/v1/net/ws), NET_WORKERS, NET_CAPACITY, NET_NODE_ID, NET_USAGE_MS,
//     NET_TRUST_LOCALHOST=1 (a developer's machine only: pages on localhost may use the public ticket door)
import http from 'node:http';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import type { IncomingMessage } from 'node:http';
import * as svc from './service.ts';
import * as projects from './projects.ts';
import * as api from './api.ts';
import { refuse } from './ws.ts';
import { errorBody, errorsHtml } from './errors.ts';
import type { Client } from './store.ts';

export type HubOptions = {
  port?: number; host?: string;
  /** Gen, for key checks and usage. */
  genUrl?: string; genKey?: string;
  /** Instead of asking Gen (tests). */
  checkKey?: (req: IncomingMessage) => Client | null | Promise<Client | null>;
  /** Instead of sending usage to Gen (tests). */
  usage?: (rep: { node: string; rows: any[] }) => void;
  usageEveryMs?: number;
  log?: (s: string) => void;
};

/** Asks Gen who a key is (GET /v1/net/whoami, the key narrowed like the caller narrowed it), keeping answers a minute. */
export function genKeyCheck(genUrl: string, log: (s: string) => void) {
  const known = new Map<string, { at: number; client: Client | null }>();
  const KEEP_MS = 60_000, KEEP_NO_MS = 10_000;
  return async (req: IncomingMessage): Promise<Client | null> => {
    const header = String(req.headers.authorization ?? '');
    const key = header.startsWith('Bearer ') ? header.slice(7).trim() : String(req.headers['x-hawkesgen-key'] ?? '').trim();
    if (!key) return null;
    const only = String(req.headers['x-hawkesgen-project'] ?? '').trim();
    const id = crypto.createHash('sha256').update(`${key}\n${only}`).digest('base64url');
    const had = known.get(id);
    if (had && Date.now() - had.at < (had.client ? KEEP_MS : KEEP_NO_MS)) return had.client;
    let client: Client | null = null;
    try {
      const r = await fetch(`${genUrl}/v1/net/whoami`, { headers: { Authorization: `Bearer ${key}`, ...(only ? { 'X-Hawkesgen-Project': only } : {}) }, signal: AbortSignal.timeout(5000) });
      if (r.ok) { const c = ((await r.json()) as any)?.client; if (c && typeof c.id === 'string' && Array.isArray(c.projects)) client = { id: c.id, name: String(c.name ?? ''), role: c.role, projects: c.projects.map(String) }; }
      else if (r.status >= 500) { if (had) return had.client; throw new Error(`Gen answered ${r.status}`); }
    } catch (e) {
      // Gen unreachable: a key it vouched for lately still works; a new one waits.
      if (had?.client) return had.client;
      log(`key check: ${(e as Error).message}`);
      return null;
    }
    known.set(id, { at: Date.now(), client });
    if (known.size > 20_000) for (const [k, v] of known) if (Date.now() - v.at > KEEP_MS) known.delete(k);
    return client;
  };
}

export async function startHub(o: HubOptions = {}) {
  const log = o.log ?? ((s: string) => console.log(`[net] ${s}`));
  const genUrl = (o.genUrl ?? 'https://hawkesgen.ai').replace(/\/+$/, '');
  api.useKeyCheck(o.checkKey ?? genKeyCheck(genUrl, log));

  // Usage: to Gen once a minute, kept until it lands (or to the caller's sink).
  const outbox: { node: string; rows: any[] }[] = [];
  const flushUsage = async () => {
    while (outbox.length && o.genKey) {
      try {
        const r = await fetch(`${genUrl}/v1/net/usage`, { method: 'POST', headers: { Authorization: `Bearer ${o.genKey}`, 'Content-Type': 'application/json' }, body: JSON.stringify(outbox[0]), signal: AbortSignal.timeout(10_000) });
        if (!r.ok && r.status < 500) { log(`usage refused by Gen (${r.status}): ${(await r.text()).slice(0, 200)}`); outbox.shift(); continue; }
        if (!r.ok) return;
        outbox.shift();
      } catch { return; }
    }
  };
  // The operator view's numbers: the last minute's usage and totals since this process started.
  const startedAt = Date.now();
  let lastUsage: { at: number; rows: any[] } | null = null;
  const totals = { playerMinutes: 0, gbOut: 0, gbIn: 0 };
  const perProject = new Map<string, { playerMinutes: number; gbOut: number }>();
  const send = o.usage ?? ((rep: { node: string; rows: any[] }) => { outbox.push(rep); if (outbox.length > 1440) outbox.shift(); });
  svc.sendUsageTo((rep) => {
    lastUsage = { at: Date.now(), rows: rep.rows };
    for (const r of rep.rows) {
      const pm = (Number(r.playerSeconds) || 0) / 60, gb = (Number(r.bytesOut) || 0) / 1e9;
      totals.playerMinutes += pm; totals.gbOut += gb; totals.gbIn += (Number(r.bytesIn) || 0) / 1e9;
      const k = `${r.project}|${r.transport}`;
      const t = perProject.get(k) ?? { playerMinutes: 0, gbOut: 0 };
      t.playerMinutes += pm; t.gbOut += gb;
      perProject.set(k, t);
    }
    send(rep);
  });
  api.useOpsExtra(() => ({
    startedAt, uptimeS: Math.round((Date.now() - startedAt) / 1000), usageWaiting: outbox.length,
    lastMinute: lastUsage, sinceStart: { ...totals, perProject: [...perProject].map(([k, v]) => ({ project: k.split('|')[0], transport: k.split('|')[1], ...v })) },
  }));
  const usageTimer = setInterval(() => void flushUsage(), o.usageEveryMs ?? 60_000);
  usageTimer.unref();

  const node = await svc.startNode();
  projects.startSampler(); // players online a minute, per project (the dashboard's line)
  const demo = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public', 'demo.html');
  // Hawkes Studio's playtest bot for the demo (window.hawkesPlaytest: two players meet, move, message, leave).
  const demoPlaytest = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public', 'demo-playtest.mjs');
  const landingPlaytest = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public', 'landing-playtest.mjs');
  const sitePlaytest = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public', 'site-playtest.mjs');
  const orbsPlaytest = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public', 'orbs-playtest.mjs');
  const feedbackPlaytest = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public', 'feedback-playtest.mjs');
  const phonePlaytest = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public', 'phone-playtest.mjs');
  const drainPlaytest = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public', 'drain-playtest.mjs');
  const landing = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public', 'landing.html');
  const quickstart = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public', 'quickstart.html');
  const siteCss = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public', 'site.css');
  const siteJs = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public', 'site.js');
  const dashboard = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public', 'dashboard.html');
  // What this process runs: the repo and its commit (from .git, read once), so a deploy can be seen from outside.
  const build = (() => {
    try {
      const git = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '.git');
      let head = fs.readFileSync(path.join(git, 'HEAD'), 'utf8').trim();
      if (head.startsWith('ref: ')) head = fs.readFileSync(path.join(git, head.slice(5)), 'utf8').trim();
      return { repo: 'hawkesnet', commit: head.slice(0, 7) };
    } catch { return { repo: 'hawkesnet', commit: '' }; }
  })();
  const server = http.createServer((req, res) => {
    const route = new URL(req.url ?? '/', 'http://x').pathname;
    if (route === '/healthz') {
      const st = svc.status();
      res.writeHead(st.up ? 200 : 503, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      return void res.end(JSON.stringify({ ok: st.up, service: 'hawkes-net', version: st.version, ...build, usageWaiting: outbox.length }));
    }
    // The front door: on the relay's own names a public landing page (what Hawkes Net is, its live status, the SDKs); on the
    // dashboard's names (net.hawkesgames.com, net-beta.hawkesgames.com) the developer dashboard, which is also at /dashboard.
    const dashHost = /^net(-beta)?\.hawkesgames\.com$/i.test(String(req.headers.host ?? '').split(':')[0]);
    // /home is the landing page on every name (the header's Home link: on the dashboard's names "/" is the dashboard).
    if (route === '/' || route === '/dashboard' || route === '/home') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' });
      return void res.end(fs.readFileSync(route === '/dashboard' || (route === '/' && dashHost) ? dashboard : landing));
    }
    // The look and the header every page shares (public/site.css, public/site.js).
    if (route === '/site.css' || route === '/site.js') {
      res.writeHead(200, { 'Content-Type': route === '/site.css' ? 'text/css; charset=utf-8' : 'text/javascript; charset=utf-8', 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' });
      return void res.end(fs.readFileSync(route === '/site.css' ? siteCss : siteJs));
    }
    // The demo: dots in a room, peer to peer, then the relay (open it in two tabs).
    // The error codes (src/errors.ts, docs/errors.md): every error's `docs` link points here.
    if (route === '/docs/errors') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'public, max-age=300', 'X-Content-Type-Options': 'nosniff' });
      return void res.end(errorsHtml());
    }
    // The quickstart: ten minutes from a free account to two clients in one room (public/quickstart.html).
    if (route === '/quickstart') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' });
      return void res.end(fs.readFileSync(quickstart));
    }
    if (route === '/demo') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'public, max-age=300', 'X-Content-Type-Options': 'nosniff' });
      return void res.end(fs.readFileSync(demo));
    }
    if (route === '/demo-playtest.mjs') {
      res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'public, max-age=300', 'X-Content-Type-Options': 'nosniff' });
      return void res.end(fs.readFileSync(demoPlaytest));
    }
    if (route === '/landing-playtest.mjs') {
      res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' });
      return void res.end(fs.readFileSync(landingPlaytest));
    }
    if (route === '/site-playtest.mjs') {
      res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' });
      return void res.end(fs.readFileSync(sitePlaytest));
    }
    if (route === '/orbs-playtest.mjs') {
      res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' });
      return void res.end(fs.readFileSync(orbsPlaytest));
    }
    if (route === '/feedback-playtest.mjs') {
      res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' });
      return void res.end(fs.readFileSync(feedbackPlaytest));
    }
    if (route === '/phone-playtest.mjs') {
      res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' });
      return void res.end(fs.readFileSync(phonePlaytest));
    }
    if (route === '/drain-playtest.mjs') {
      res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' });
      return void res.end(fs.readFileSync(drainPlaytest));
    }
    if (route.startsWith('/v1/net/') || route.startsWith('/sdk/')) return void api.handleNet(req, res, route);
    res.writeHead(404, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(errorBody('not_found')));
  });
  server.on('upgrade', (req, socket, head) => {
    const route = new URL(req.url ?? '/', 'http://x').pathname;
    if (route !== '/v1/net/ws' && route !== '/v3') return refuse(socket, 'not_found');
    node.upgrade(req, socket, head);
  });
  server.keepAliveTimeout = 75_000;
  server.headersTimeout = 20_000;
  server.requestTimeout = 30_000;
  await new Promise<void>((r) => server.listen(o.port ?? 8800, o.host ?? '127.0.0.1', () => r()));
  const port = (server.address() as any).port as number;
  log(`Hawkes Net on :${port}: node ${node.o.id}, ${node.workers.length} worker(s), Gen ${genUrl}`);

  let stopping: Promise<void> | null = null;
  const stop = () => (stopping ??= (async () => {
    clearInterval(usageTimer);
    projects.stopSampler();
    // Push the draining notice *before* closing sockets, so clients skip the doomed resume and rejoin at once.
    await svc.stopNode();
    server.close();
    server.closeAllConnections();
    await flushUsage().catch(() => {});
  })());
  return { server, port, url: `http://127.0.0.1:${port}`, node, stop, usageWaiting: () => outbox.length };
}

// ------------------------------------------------------------------ the box
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const env = (k: string) => process.env[k] || undefined;
  const genKey = env('NET_GEN_KEY');
  if (!genKey) { console.error('[net] NET_GEN_KEY is required (a Gen API key for the project "hawkesnet")'); process.exit(1); }
  process.env.NET_WORKERS ??= String(Math.max(1, os.availableParallelism()));
  const hub = await startHub({ port: Number(env('NET_PORT') ?? 8800), host: env('NET_HOST') ?? '127.0.0.1', genUrl: env('NET_GEN_URL'), genKey, usageEveryMs: Number(env('NET_USAGE_MS') ?? 60_000) });
  const leave = async () => { console.log('[net] draining'); await hub.stop(); process.exit(0); };
  process.on('SIGTERM', () => void leave());
  process.on('SIGINT', () => void leave());
  process.on('uncaughtException', (e) => console.error('[net] uncaught:', e));
  process.on('unhandledRejection', (e) => console.error('[net] unhandled:', e));
}
