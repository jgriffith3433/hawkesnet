#!/usr/bin/env node
// Moves Hawkes's own games (projects.json) from one portal account to another on a Hawkes Net box: lets each go from the
// old owner (back to the file, nobody's) and takes it into the new one, through the admin routes (DELETE
// /v1/net/projects/<id>, POST /<id>/claim) with a Gen owner key from ~/.hawkes/client.json. Rooms keep running; only the
// owner changes. 2026-10-29: the live games were in the old admin@hawkesgen.com account, which can't sign in any more.
//
//   node tools/move-projects.mjs --lane live|beta --from <usr_...> --to <usr_...> [--ids a,b] [--apply]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const arg = (k) => { const i = process.argv.indexOf(`--${k}`); return i >= 0 ? process.argv[i + 1] : undefined; };
const lane = arg('lane') ?? 'live';
const from = arg('from');
const to = arg('to');
const apply = process.argv.includes('--apply');
if (!from || !to || !['live', 'beta'].includes(lane)) { console.error('usage: node tools/move-projects.mjs --lane live|beta --from <usr_...> --to <usr_...> [--ids a,b] [--apply]'); process.exit(2); }
const c = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.hawkes', 'client.json'), 'utf8'));
const key = lane === 'beta' ? c.genBetaKey : c.genKey;
const base = lane === 'beta' ? 'https://hawkesnet.hawkesgen.ai' : 'https://net.hawkesgen.ai';
const h = { authorization: `Bearer ${key}`, 'content-type': 'application/json' };

const all = await (await fetch(`${base}/v1/net/projects?all=1`, { headers: h })).json();
const wanted = arg('ids')?.split(',');
const theirs = (all.others ?? []).filter((p) => p.owner === from && p.hawkes && (!wanted || wanted.includes(p.id)));
if (!theirs.length) { console.log(`${base}: no Hawkes games owned by ${from}`); process.exit(0); }
for (const p of theirs) {
  if (!apply) { console.log(`${p.id}: ${from} -> ${to} (--apply moves it)`); continue; }
  const d = await fetch(`${base}/v1/net/projects/${p.id}?owner=${from}&admin=1`, { method: 'DELETE', headers: h });
  const t = await fetch(`${base}/v1/net/projects/${p.id}/claim?owner=${to}&admin=1`, { method: 'POST', headers: h, body: '{}' });
  const tj = await t.json().catch(() => ({}));
  console.log(`${p.id}: released ${d.status}, taken ${t.status} ${tj.owner ?? tj.error ?? ''}`);
}
