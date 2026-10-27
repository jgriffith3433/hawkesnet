// The Hawkes Net service for tests, in this process: its own data folder, the relay node in-process (no worker
// processes), localhost a door, and keys checked here instead of by Gen. A request with no key and no Origin from this
// machine acts as the owner (a bot or a test, as on a developer's machine); "k-<name>" keys are the ones a test adds, and
// X-Hawkesgen-Project narrows a key to one project the way Gen does. Usage is kept in `usage`.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { IncomingMessage } from 'node:http';

process.env.NET_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hn-test-'));
process.env.NET_WORKERS ??= '0';
process.env.NET_TRUST_LOCALHOST ??= '1';
const { startHub } = await import('../src/hub.ts');
type Client = import('../src/store.ts').Client;
const { canProject } = await import('../src/store.ts');

export const OWNER: Client = { id: 'c-owner', name: 'owner', role: 'owner', projects: ['*'] };
const keys = new Map<string, Client>();
/** A key tests can use: Authorization: Bearer k-<name>. */
export function addKey(name: string, projects: string[], role: Client['role'] = 'user') {
  keys.set(`k-${name}`, { id: `c-${name}`, name, role, projects });
  return `k-${name}`;
}
function checkKey(req: IncomingMessage): Client | null {
  const header = String(req.headers.authorization ?? '');
  const key = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!key) return req.headers.origin ? null : OWNER;
  const c = keys.get(key);
  if (!c) return null;
  const only = String(req.headers['x-hawkesgen-project'] ?? '').trim();
  if (!only) return c;
  return canProject(c, only) ? { ...c, projects: [only] } : null;
}

export async function startTestHub() {
  const usage: { node: string; rows: any[] }[] = [];
  const hub = await startHub({ port: 0, checkKey, usage: (r) => usage.push(r), log: () => {} });
  const svc = await import('../src/service.ts');
  for (let i = 0; i < 50 && !svc.status().up; i++) await new Promise((r) => setTimeout(r, 50));
  return { ...hub, endpoint: hub.url, usage, svc };
}
