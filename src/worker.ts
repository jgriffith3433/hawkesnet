// One worker process of a relay node (src/node.ts): it holds the rooms whose key hashes to it, and gets their sockets
// from the primary (child_process sendHandle). Everything a room does happens here.
import { Rooms } from './rooms.ts';
import { importPublic } from './tickets.ts';
import { Lag } from './lag.ts';

const secret = Buffer.from(process.env.NET_SECRET ?? '', 'base64');
const rooms = new Rooms({ node: process.env.NET_NODE_ID ?? 'node', secret, onRoom: (e) => process.send?.({ t: 'room', e }), log: (s) => process.send?.({ t: 'log', s }) });
rooms.start();
const lag = new Lag().start();
let cpu = process.cpuUsage(), cpuAt = Date.now();

process.on('message', (m: any, handle: any) => {
  switch (m?.t) {
    case 'up': {
      if (!handle) return;
      const head = m.head ? Buffer.from(m.head, 'base64') : null;
      try { rooms.upgrade(m.headers, new URL(m.url, 'http://node'), handle, head); } catch (e: any) { try { handle.destroy(); } catch {} process.send?.({ t: 'log', s: `upgrade: ${e.message}` }); }
      handle.resume?.();
      return;
    }
    case 'keys': {
      rooms.keys.clear();
      for (const k of m.keys ?? []) { try { rooms.keys.set(k.kid, importPublic(k.pub)); } catch {} }
      return;
    }
    case 'publish': return void process.send?.({ t: 'reply', id: m.id, v: rooms.publish(m.token, m.body) });
    case 'usage': return void process.send?.({ t: 'reply', id: m.id, v: rooms.takeUsage() });
    case 'summary': {
      const now = Date.now();
      const u = process.cpuUsage(cpu);
      const busy = (u.user + u.system) / 1000 / Math.max(1, now - cpuAt);
      cpu = process.cpuUsage(); cpuAt = now;
      const l = lag.read();
      const v = { ...rooms.summary(), lagP99: l.p99, lagMax: l.max, cpu: Math.round(busy * 1000) / 1000 };
      return void process.send?.({ t: 'reply', id: m.id, v });
    }
    case 'drain': return rooms.drain();
  }
});
process.on('uncaughtException', (e) => process.send?.({ t: 'log', s: `uncaught: ${e?.stack ?? e}` }));
process.on('disconnect', () => process.exit(0));
