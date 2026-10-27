// What the Hawkes Net service keeps for itself: its settings (the environment), its data folder and database (the room
// directory, the signing keys), the error type its routes answer with, and the shape of a checked API key. Nothing here
// comes from Hawkes Gen: the service runs on its own box and asks Gen only to check keys and to take usage.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/** A setting from the environment (empty counts as unset). */
export const env = (name: string): string | undefined => process.env[name] || undefined;

/** Where the directory and the signing keys live (NET_DATA_DIR; the box: /srv/hawkes/net-data). */
export const DATA_DIR = path.resolve(env('NET_DATA_DIR') ?? path.join(os.homedir(), 'net-data'));
fs.mkdirSync(DATA_DIR, { recursive: true });

export const db = new DatabaseSync(path.join(DATA_DIR, 'net.db'));
db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA synchronous = NORMAL;');

/** Pages on localhost may use the public ticket door (NET_TRUST_LOCALHOST=1: a developer's machine, never the box:
 *  anything outside a browser can say it is localhost). */
export const trustLocalhost = () => env('NET_TRUST_LOCALHOST') === '1';

/** A refusal with an HTTP status (400 unless said). */
export class NetError extends Error {
  status: number;
  constructor(message: string, o: { status?: number } = {}) {
    super(message);
    this.status = o.status ?? 400;
  }
}

/** A Gen API key as Gen describes it (GET /v1/net/whoami): projects are names, '*' or a prefix pattern like 'usr_*'. */
export type Client = { id: string; name: string; role: 'owner' | 'admin' | 'user'; projects: string[] };
const matches = (p: string, project: string) => p === '*' || p === project || (p.endsWith('*') && project.startsWith(p.slice(0, -1)));
export const canProject = (c: Client, project: string) => c.projects.some((p) => matches(p, project));
