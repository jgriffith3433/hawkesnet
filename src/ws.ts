// A WebSocket server (RFC 6455) with no dependencies, for Hawkes Net's relay nodes: text and binary frames,
// fragmented messages, ping/pong, close, a size limit, a subprotocol, slow-client detection, and one heartbeat sweep for
// every socket of the process (not a timer each: a node holds thousands). Adapted from hawkesgen.com's src/ws.ts.
//
// The handshake takes plain headers rather than an IncomingMessage, so a relay node's primary process can read the
// upgrade request and hand the raw socket to the worker that owns the room (child_process sendHandle).
import crypto from 'node:crypto';
import type { Duplex } from 'node:stream';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

export type WsMessage = string | Uint8Array;
export type Socket = {
  send(data: WsMessage): void;
  close(code?: number, reason?: string): void;
  readonly open: boolean;
  onMessage: (data: WsMessage) => void;
  onClose: (code: number, reason: string) => void;
  /** Bytes queued and not yet written: a slow client is dropped before it grows without end. */
  readonly buffered: number;
  readonly protocol: string | null;
  /** When anything (a frame, a pong) last arrived. */
  readonly seen: number;
};

export type Headers = Record<string, string | string[] | undefined>;

const sockets = new Set<{ s: Socket; idle: number; raw: Duplex; ping: () => void }>();
let sweep: ReturnType<typeof setInterval> | null = null;
function startSweep() {
  if (sweep) return;
  // Every 10 s: ping every socket (proxies close quiet ones; browsers answer pings even in hidden tabs) and drop the ones
  // that said nothing at all for their idle time (a laptop asleep, a network gone: no close ever comes).
  sweep = setInterval(() => {
    const now = Date.now();
    for (const e of sockets) {
      if (!e.s.open) { sockets.delete(e); continue; }
      if (e.idle && now - e.s.seen > e.idle) { e.s.close(1001, 'gone quiet'); e.raw.destroy(); sockets.delete(e); continue; }
      e.ping();
    }
    if (!sockets.size && sweep) { clearInterval(sweep); sweep = null; }
  }, 10_000);
  sweep.unref?.();
}
export const socketCount = () => sockets.size;

/**
 * Answers an upgrade and returns the socket, or null (after a 400) when it isn't a WebSocket handshake. `head` is what
 * the HTTP parser read past the request (the first frames, rarely). `protocols`: subprotocols we speak, in our order of
 * preference; the client's list picks.
 */
export function accept(headers: Headers, raw: Duplex, head: Uint8Array | null, o: { maxMessage?: number; idleMs?: number; protocols?: string[]; maxBuffered?: number } = {}): Socket | null {
  const h = (k: string) => { const v = headers[k]; return Array.isArray(v) ? v[0] : v; };
  const key = h('sec-websocket-key');
  if (String(h('upgrade') ?? '').toLowerCase() !== 'websocket' || typeof key !== 'string' || !key) {
    try { raw.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n'); } catch {}
    return null;
  }
  const offered = String(h('sec-websocket-protocol') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  const protocol = (o.protocols ?? []).find((p) => offered.includes(p)) ?? null;
  const acceptKey = crypto.createHash('sha1').update(key + GUID).digest('base64');
  raw.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${acceptKey}\r\n${protocol ? `Sec-WebSocket-Protocol: ${protocol}\r\n` : ''}\r\n`);
  (raw as any).setNoDelay?.(true);
  const max = o.maxMessage ?? 256 * 1024;
  const maxBuffered = o.maxBuffered ?? 4 * 1024 * 1024;
  let buf: Buffer = Buffer.alloc(0);
  let parts: Buffer[] = [];
  let partsBytes = 0;
  let partsOp = 0;
  let open = true;
  let seen = Date.now();
  const write = (op: number, payload: Buffer) => { try { raw.write(frame(op, payload)); } catch {} };
  const s: Socket = {
    onMessage: () => {},
    onClose: () => {},
    get open() { return open; },
    get buffered() { return (raw as any).writableLength ?? 0; },
    get protocol() { return protocol; },
    get seen() { return seen; },
    send(data: WsMessage) {
      if (!open) return;
      if (s.buffered > maxBuffered) { s.close(1013, 'too slow'); return; }
      if (typeof data === 'string') write(0x1, Buffer.from(data, 'utf8'));
      else {
        // The header and the payload in one corked write: no copy to glue them together.
        const payload = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
        try { raw.cork(); raw.write(header(0x2, payload.length)); raw.write(payload); raw.uncork(); } catch {}
      }
    },
    close(code = 1000, reason = '') {
      if (!open) return;
      const r = Buffer.from(reason.slice(0, 100), 'utf8');
      const b = Buffer.alloc(2 + r.length);
      b.writeUInt16BE(code, 0);
      r.copy(b, 2);
      write(0x8, b);
      finish(code, reason);
      setTimeout(() => raw.destroy(), 500).unref?.();
    },
  };
  const finish = (code = 1006, reason = '') => {
    if (!open) return;
    open = false;
    try { s.onClose(code, reason); } catch {}
  };
  const onData = (chunk: Buffer) => {
    seen = Date.now();
    buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
    for (;;) {
      if (!open || buf.length < 2) return;
      const fin = (buf[0] & 0x80) !== 0;
      const op = buf[0] & 0x0f;
      const masked = (buf[1] & 0x80) !== 0;
      let len = buf[1] & 0x7f;
      let at = 2;
      if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); at = 4; }
      else if (len === 127) { if (buf.length < 10) return; const big = buf.readBigUInt64BE(2); if (big > BigInt(max)) return s.close(1009, 'too big'); len = Number(big); at = 10; }
      if (len > max) return s.close(1009, 'too big');
      if (!masked) return s.close(1002, 'clients mask');
      if (op >= 0x8 && (len > 125 || !fin)) return s.close(1002, 'bad control frame'); // RFC 6455 5.5
      if (buf.length < at + 4 + len) return;
      const mask = buf.subarray(at, at + 4);
      const data = Buffer.from(buf.subarray(at + 4, at + 4 + len));
      for (let i = 0; i < data.length; i++) data[i] ^= mask[i & 3];
      buf = buf.subarray(at + 4 + len);
      if (op === 0x8) { // close: answer it, then we're done
        const code = data.length >= 2 ? data.readUInt16BE(0) : 1005;
        write(0x8, data.length >= 2 ? data.subarray(0, 2) : Buffer.alloc(0));
        finish(code, data.length > 2 ? data.subarray(2).toString('utf8') : '');
        setTimeout(() => raw.destroy(), 500).unref?.();
        return;
      }
      if (op === 0x9) { if (s.buffered > maxBuffered) return s.close(1013, 'too slow'); write(0xa, data); continue; }
      if (op === 0xa) continue;
      if (op === 0x1 || op === 0x2 || op === 0x0) {
        if (op !== 0x0) { partsOp = op; parts = []; partsBytes = 0; }
        else if (!partsOp) return s.close(1002, 'bad continuation');
        parts.push(data);
        partsBytes += data.length;
        if (partsBytes > max) return s.close(1009, 'too big');
        if (fin) {
          const whole = parts.length === 1 ? parts[0] : Buffer.concat(parts);
          const kind = partsOp;
          parts = []; partsBytes = 0; partsOp = 0;
          try { s.onMessage(kind === 0x1 ? whole.toString('utf8') : new Uint8Array(whole.buffer, whole.byteOffset, whole.byteLength)); } catch (e) { console.warn(`[net] message handler: ${(e as Error).message}`); }
        }
        continue;
      }
      return s.close(1002, 'bad frame');
    }
  };
  raw.on('data', onData);
  raw.on('close', () => finish());
  raw.on('end', () => finish());
  raw.on('error', () => finish());
  sockets.add({ s, idle: o.idleMs ?? 0, raw, ping: () => write(0x9, Buffer.alloc(0)) });
  startSweep();
  if (head && head.length) onData(Buffer.from(head));
  return s;
}

function header(op: number, len: number) {
  const head = len < 126 ? Buffer.allocUnsafe(2) : len < 65536 ? Buffer.allocUnsafe(4) : Buffer.allocUnsafe(10);
  head[0] = 0x80 | op;
  if (len < 126) head[1] = len;
  else if (len < 65536) { head[1] = 126; head.writeUInt16BE(len, 2); }
  else { head[1] = 127; head.writeBigUInt64BE(BigInt(len), 2); }
  return head;
}
function frame(op: number, payload: Buffer) { return Buffer.concat([header(op, payload.length), payload]); }

/** Refuses an upgrade with an HTTP status before any WebSocket exists. */
export function refuse(raw: Duplex, status: number, why: string) {
  const text = { 400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden', 404: 'Not Found', 409: 'Conflict', 429: 'Too Many Requests', 503: 'Service Unavailable' }[status] ?? 'Error';
  try { raw.end(`HTTP/1.1 ${status} ${text}\r\nContent-Type: text/plain\r\nConnection: close\r\nContent-Length: ${Buffer.byteLength(why)}\r\n\r\n${why}`); } catch {}
}
