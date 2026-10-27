// The Unity package as a download (GET /sdk/com.hawkes.net.tgz): an npm-style tarball (every file under "package/"),
// which Unity's Package Manager installs with "Add package from tarball". Made from sdk/unity/com.hawkes.net when it
// is asked for, kept until a file there changes. No dependencies: a ustar writer and node's gzip.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';

function header(name: string, size: number, mtime: number) {
  const h = Buffer.alloc(512);
  // Names past 100 bytes go in the ustar prefix (up to 155 more), split at a slash.
  let prefix = '';
  let base = name;
  if (Buffer.byteLength(name) > 100) {
    const cut = name.lastIndexOf('/', 155);
    if (cut <= 0 || Buffer.byteLength(name.slice(cut + 1)) > 100) throw new Error(`path too long for the tarball: ${name}`);
    prefix = name.slice(0, cut);
    base = name.slice(cut + 1);
  }
  h.write(base, 0, 100, 'utf8');
  h.write('0000644\0', 100);
  h.write('0000000\0', 108);
  h.write('0000000\0', 116);
  h.write(size.toString(8).padStart(11, '0') + '\0', 124);
  h.write(Math.floor(mtime / 1000).toString(8).padStart(11, '0') + '\0', 136);
  h.write('        ', 148);
  h.write('0', 156);
  h.write('ustar\0', 257);
  h.write('00', 263);
  h.write(prefix, 345, 155, 'utf8');
  let sum = 0;
  for (const b of h) sum += b;
  h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148);
  return h;
}

function files(dir: string, rel = ''): string[] {
  return fs.readdirSync(path.join(dir, rel), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).flatMap((e) => {
    const r = rel ? `${rel}/${e.name}` : e.name;
    return e.isDirectory() ? files(dir, r) : [r];
  });
}

let cache: { stamp: string; body: Buffer; etag: string; version: string } | null = null;
/** The package folder as a .tgz, and its version (package.json). */
export function packageTarball(dir: string) {
  const list = files(dir);
  const stamp = list.map((f) => { const s = fs.statSync(path.join(dir, f)); return `${f}:${s.size}:${s.mtimeMs}`; }).join('|');
  if (cache && cache.stamp === stamp) return cache;
  const parts: Buffer[] = [];
  for (const f of list) {
    const data = fs.readFileSync(path.join(dir, f));
    parts.push(header(`package/${f}`, data.length, fs.statSync(path.join(dir, f)).mtimeMs), data, Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  parts.push(Buffer.alloc(1024));
  const body = zlib.gzipSync(Buffer.concat(parts), { level: 9 });
  const version = String(JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).version ?? '0.0.0');
  cache = { stamp, body, etag: `"${crypto.createHash('sha256').update(body).digest('base64url').slice(0, 20)}"`, version };
  return cache;
}
