// Hawkes Net tickets (docs/net.md "Tickets"): Gen signs, relay nodes check. A ticket is
//   hn1.<base64url JSON TicketPayload>.<base64url Ed25519 signature of "hn1.<payload>">
// Nodes hold only public keys, so a node can't make tickets, and checking one is a few hundred microseconds with no call
// to Gen. This file has no Gen state in it (no database, no settings): a standalone node imports it as it is.
import crypto from 'node:crypto';

export const TICKET_PREFIX = 'hn1';
/** A publish token (Gen -> a node: a server's world edit or event for one room) is the same format with this prefix. */
export const PUBLISH_PREFIX = 'hp1';

export type KeyPair = { kid: string; privateKey: crypto.KeyObject; publicKey: crypto.KeyObject };
export type PublicKeys = Map<string, crypto.KeyObject>; // kid -> public key

export function newKeyPair(kid = `k${crypto.randomBytes(4).toString('hex')}`): KeyPair {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  return { kid, privateKey, publicKey };
}
export const exportPublic = (k: crypto.KeyObject) => k.export({ type: 'spki', format: 'der' }).toString('base64url');
export const importPublic = (b64: string) => crypto.createPublicKey({ key: Buffer.from(b64, 'base64url'), format: 'der', type: 'spki' });
export const exportPrivate = (k: crypto.KeyObject) => k.export({ type: 'pkcs8', format: 'der' }).toString('base64url');
export const importPrivate = (b64: string) => crypto.createPrivateKey({ key: Buffer.from(b64, 'base64url'), format: 'der', type: 'pkcs8' });

/** Signs a payload (it must carry `kid`). */
export function signToken(prefix: string, payload: Record<string, unknown>, privateKey: crypto.KeyObject): string {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.sign(null, Buffer.from(`${prefix}.${body}`), privateKey).toString('base64url');
  return `${prefix}.${body}.${sig}`;
}

/** The payload without checking it: a node's primary reads the room to route the socket; the worker checks it. */
export function peekToken<T = any>(token: string): T | null {
  const parts = String(token ?? '').split('.');
  if (parts.length !== 3) return null;
  try { return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as T; } catch { return null; }
}

export type Checked<T> = { ok: true; payload: T } | { ok: false; why: 'malformed' | 'unknown key' | 'bad signature' | 'expired' | 'wrong prefix' };

/** Checks a token's prefix, key, signature and expiry (`exp`, seconds; `skew` seconds of clock difference allowed). */
export function verifyToken<T extends { kid: string; exp: number }>(prefix: string, token: string, keys: PublicKeys, nowSec = Date.now() / 1000, skew = 30): Checked<T> {
  const parts = String(token ?? '').split('.');
  if (parts.length !== 3) return { ok: false, why: 'malformed' };
  if (parts[0] !== prefix) return { ok: false, why: 'wrong prefix' };
  let payload: T;
  try { payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')); } catch { return { ok: false, why: 'malformed' }; }
  if (!payload || typeof payload !== 'object' || typeof payload.kid !== 'string') return { ok: false, why: 'malformed' };
  const key = keys.get(payload.kid);
  if (!key) return { ok: false, why: 'unknown key' };
  let good = false;
  try { good = crypto.verify(null, Buffer.from(`${parts[0]}.${parts[1]}`), key, Buffer.from(parts[2], 'base64url')); } catch { good = false; }
  if (!good) return { ok: false, why: 'bad signature' };
  if (!(Number(payload.exp) + skew >= nowSec)) return { ok: false, why: 'expired' };
  return { ok: true, payload };
}

/** Recently used ticket ids (a ticket works once per node), forgetting after their expiry. */
export class SeenIds {
  private map = new Map<string, number>();
  private cap: number;
  constructor(cap = 200_000) { this.cap = cap; }
  /** True the first time an id is seen (and remembers it until `untilSec`). */
  first(id: string, untilSec: number): boolean {
    const now = Date.now() / 1000;
    // Ids go in about the order they expire (every ticket lives 90 s), so the expired ones are at the front.
    if (this.map.size >= this.cap) for (const [k, t] of this.map) { if (t >= now) break; this.map.delete(k); }
    const t = this.map.get(id);
    if (t !== undefined && t >= now) return false;
    this.map.set(id, untilSec + 60);
    return true;
  }
}

/** A resume token: the node's own HMAC over (project, room, peer, expiry). Lets a connection come back within its
 *  grace with its place in the room. Made and checked by the same node (its secret never leaves it). */
export function resumeToken(secret: Buffer, o: { prj: string; room: string; peer: string; exp: number; epoch: number; inst?: number }) {
  const body = Buffer.from(JSON.stringify(o)).toString('base64url');
  const mac = crypto.createHmac('sha256', secret).update(body).digest().subarray(0, 18).toString('base64url');
  return `hr1.${body}.${mac}`;
}
export function checkResume(secret: Buffer, token: string): { prj: string; room: string; peer: string; exp: number; epoch: number; inst?: number } | null {
  const parts = String(token ?? '').split('.');
  if (parts.length !== 3 || parts[0] !== 'hr1') return null;
  const want = crypto.createHmac('sha256', secret).update(parts[1]).digest().subarray(0, 18);
  const got = Buffer.from(parts[2], 'base64url');
  if (got.length !== want.length || !crypto.timingSafeEqual(got, want)) return null;
  try {
    const v = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    return v.exp >= Date.now() / 1000 ? v : null;
  } catch { return null; }
}
export const peekResume = (token: string) => { const p = String(token ?? '').split('.'); if (p.length !== 3 || p[0] !== 'hr1') return null; try { return JSON.parse(Buffer.from(p[1], 'base64url').toString('utf8')); } catch { return null; } };
