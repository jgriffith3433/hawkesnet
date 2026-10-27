// Records (docs/net.md "Records"): a small public store a game keeps next to its rooms, for what outlives a match: a
// leaderboard's signed results, a ghost of a best run. A record is an event the game signs itself (Nostr's shape:
// id, pubkey, created_at, kind, tags, content, sig), so anyone can check who wrote it; the service only keeps it, by
// project, tag (["t", ...]) and key (["d", ...]) per author (pubkey): a newer one replaces an older one with the same
// three, like Nostr's replaceable app data. Pages on the project's sites write without a key (localhost only test
// records, kept apart); anyone reads (records are public). The checks a game relies on (signatures, rules) are its own.
import { db, NetError } from './store.ts';
import { netProject, originAllowed } from './registry.ts';

db.exec(`
CREATE TABLE IF NOT EXISTS net_records (
  project TEXT NOT NULL, test INTEGER NOT NULL, tag TEXT NOT NULL, d TEXT NOT NULL, pubkey TEXT NOT NULL,
  created_at INTEGER NOT NULL, at INTEGER NOT NULL, event TEXT NOT NULL,
  PRIMARY KEY (project, test, tag, d, pubkey)
);
CREATE INDEX IF NOT EXISTS net_records_read ON net_records (project, test, tag, created_at);
`);

export const RECORD_BYTES = 8192;
export const RECORDS_PER_DAY = 20_000;
export const READ_MAX = 3000;
const HEX = (n: number) => new RegExp(`^[0-9a-f]{${n}}$`);
const TAG_RE = /^[A-Za-z0-9/_.:-]{1,80}$/;

/** What makes a record (the event) well formed; returns its tag and key. */
function checkEvent(e: any) {
  if (!e || typeof e !== 'object' || Array.isArray(e)) throw new NetError('event: a signed event object');
  if (!HEX(64).test(e.id) || !HEX(64).test(e.pubkey) || !HEX(128).test(e.sig)) throw new NetError('event: id, pubkey (64 hex) and sig (128 hex)');
  if (!Number.isInteger(e.created_at) || !Number.isInteger(e.kind) || typeof e.content !== 'string') throw new NetError('event: created_at, kind and content');
  const now = Math.floor(Date.now() / 1000);
  if (e.created_at > now + 3600 || e.created_at < now - 400 * 86400) throw new NetError('event: created_at is not around now');
  if (!Array.isArray(e.tags) || e.tags.length > 20 || !e.tags.every((t: any) => Array.isArray(t) && t.length <= 4 && t.every((x: any) => typeof x === 'string' && x.length <= 200))) throw new NetError('event: tags are up to 20 lists of strings');
  const tag = e.tags.find((t: string[]) => t[0] === 't')?.[1];
  const d = e.tags.find((t: string[]) => t[0] === 'd')?.[1] ?? '';
  if (!tag || !TAG_RE.test(tag)) throw new NetError('event: a ["t", tag] tag (letters, digits and / _ . : -, up to 80)');
  if (d.length > 120) throw new NetError('event: the ["d", key] is up to 120 characters');
  return { tag, d };
}

/** Keeps a record. `door`: a page's origin (no key); else a key that may act for the project already checked it. */
export function putRecord(body: any, door: { origin: string } | null) {
  const project = String(body?.project ?? '');
  const p = netProject(project);
  if (!p.listed) throw new NetError(`No Hawkes Net project "${project}"`, { status: 404 });
  const test = body?.test === true;
  // A page on the project's sites; localhost (anyone can say it is) only test records, kept apart from the live ones.
  if (door && !originAllowed(p, door.origin, test ? p.testPrefix : '')) throw new NetError('Records without a key only from the project\'s own sites', { status: 403 });
  const e = body?.event;
  const raw = JSON.stringify(e ?? null);
  if (raw.length > RECORD_BYTES) throw new NetError(`A record is at most ${RECORD_BYTES} bytes`, { status: 413 });
  const { tag, d } = checkEvent(e);
  const now = Date.now();
  const today = (db.prepare('SELECT COUNT(*) AS n FROM net_records WHERE project = ? AND at > ?').get(project, now - 86_400_000) as { n: number }).n;
  if (today >= RECORDS_PER_DAY) throw new NetError(`${project} has written ${today} records today, its limit`, { status: 429 });
  const had = db.prepare('SELECT created_at FROM net_records WHERE project = ? AND test = ? AND tag = ? AND d = ? AND pubkey = ?').get(project, test ? 1 : 0, tag, d, e.pubkey) as { created_at: number } | undefined;
  if (had && had.created_at > e.created_at) return { ok: true, kept: false, why: 'a newer one is kept' };
  db.prepare(`INSERT INTO net_records (project, test, tag, d, pubkey, created_at, at, event) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
              ON CONFLICT(project, test, tag, d, pubkey) DO UPDATE SET created_at = excluded.created_at, at = excluded.at, event = excluded.event`)
    .run(project, test ? 1 : 0, tag, d, e.pubkey, e.created_at, now, raw);
  return { ok: true, kept: true };
}

/** A tag's records since a time (created_at, seconds), oldest first, up to `limit` (3000): the newest ones when cut. */
export function getRecords(project: string, tag: string, o: { since?: number; limit?: number; test?: boolean } = {}) {
  const p = netProject(project);
  if (!p.listed) throw new NetError(`No Hawkes Net project "${project}"`, { status: 404 });
  if (!TAG_RE.test(tag)) throw new NetError('tag: letters, digits and / _ . : -, up to 80');
  const limit = Math.max(1, Math.min(READ_MAX, Math.floor(o.limit ?? READ_MAX)));
  const since = Math.max(0, Math.floor(o.since ?? 0));
  const rows = db.prepare('SELECT event FROM net_records WHERE project = ? AND test = ? AND tag = ? AND created_at >= ? ORDER BY created_at DESC LIMIT ?')
    .all(project, o.test ? 1 : 0, tag, since, limit) as { event: string }[];
  return { project, tag, events: rows.reverse().map((r) => JSON.parse(r.event)) };
}
