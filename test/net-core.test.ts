// Hawkes Net's core (sdk/js/hawkes-net-core.mjs): the room rules carried over from the portal's relay (who may say
// where things are, held things, what joiners get, interest, the byte budget), the binary protocol 3 codec, a room
// where protocol 2 and 3 pages play together, and the bytes a player gets in the portal's measured scene.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as core from '../sdk/js/hawkes-net-core.mjs';

type Got = { frames: any[]; codec: any; v: number };

/** A room with n connections; each connection's received messages are decoded into got[i]. */
function setup(n: number, v: 2 | 3 = 2, o: any = {}) {
  const room = core.newRoom({ key: 'p/r', ...o });
  const got: any[][] = [];
  const conns = Array.from({ length: n }, (_, i) => addConn(room, got, i, v, i));
  return { room, conns, got };
}
function addConn(room: any, got: any[][], i: number, v: 2 | 3, now: number, id = `p${i + 1}`) {
  got[i] = [];
  const dec = new core.Codec({ quant: room.quant });
  const c = core.newConn(room, {
    id, ord: i + 1, name: `P${i}`, color: '#fff', user: null, v, now,
    send: (f: any) => {
      if (typeof f === 'string') { const m = JSON.parse(f); got[i].push(...(m.t === 'b' ? m.m : [m])); return; }
      const p = core.peek(f);
      if (p.kind === 'bundle') got[i].push(...dec.read(f, true).msgs);
      else got[i].push(p.value);
    },
  });
  core.join(room, c, now);
  return c;
}
/** A page's messages to the room, in the page's protocol. */
const enc = new Map<any, any>();
function send(room: any, c: any, msgs: any[] | any, now: number) {
  const list = Array.isArray(msgs) ? msgs : [msgs];
  if (c.v === 2) return core.receive(room, c, JSON.stringify(list.length === 1 ? list[0] : { t: 'b', m: list }), now);
  let e = enc.get(c);
  if (!e) { e = new core.Codec({ quant: room.quant }); enc.set(c, e); }
  return core.receive(room, c, e.bundle(list, now, true), now);
}
const entries = (msgs: any[], id: string) => msgs.filter((m) => m.t === 'xf').flatMap((m) => m.x).filter((x: any) => x[0] === id);

for (const v of [2, 3] as const) {
  test(`protocol ${v}: only the one simulating a thing says where it is; held things stay with whoever holds them`, () => {
    const { room, conns: [a, b, c], got } = setup(3, v);
    assert.equal(room.host, 'p1');
    send(room, b, { t: 'xf', at: 10, x: [['crate', 7, 1, 2, 3]] }, 10);
    core.flush(room, 40);
    assert.equal(entries(got[2], 'crate').length, 0);
    send(room, a, { t: 'xf', at: 50, x: [['crate', 7, 1, 2, 3]] }, 50);
    core.flush(room, 80);
    assert.deepEqual(entries(got[2], 'crate')[0], ['crate', 7, 1, 2, 3]);
    send(room, b, { t: 'own', id: 'car', on: true, lock: 1 }, 100);
    send(room, c, { t: 'own', id: 'car', on: true }, 110);
    core.flush(room, 120);
    assert.equal(room.owners.get('car'), 'p2');
    const toC = got[2].filter((m) => m.t === 'own' && m.id === 'car');
    assert.deepEqual(toC.map((m) => m.c), ['p2', 'p2'], "C hears B took it, and that it stays B's");
    core.leave(room, b);
    assert.equal(room.owners.has('car'), false);
  });

  test(`protocol ${v}: a joiner gets the world as it is`, () => {
    const { room, conns: [a], got } = setup(1, v);
    send(room, a, [
      { t: 'xf', at: 5, x: [['ball', 0b111, 4, 5, 6]] },
      { t: 'xf', at: 9, x: [['ball', 0b1, 7]] },
      { t: 'ev', name: '_s', data: { n: 'score', d: { red: 1, blue: 2 }, f: 1, at: 9 } },
      { t: 'ev', name: '_s', data: { n: 'score', d: { blue: 3 }, f: 0, at: 12 } },
    ], 12);
    addConn(room, got, 1, v, 20, 'late');
    core.flush(room, 40);
    assert.equal(got[1][0].t, 'hello');
    assert.deepEqual(entries(got[1], 'ball')[0].slice(2), [7, 5, 6]);
    const score = got[1].find((m) => m.t === 'ev' && m.name === '_s' && m.data.n === 'score');
    assert.deepEqual(score.data.d, { red: 1, blue: 3 });
    assert.equal(score.data.f, 1);
  });
}

test('the host is the lowest join order present, and the next lowest takes over when it leaves', () => {
  const room = core.newRoom({});
  const got: any[][] = [];
  const b = addConn(room, got, 1, 3, 0, 'b'); // ord 2 joins first
  const a = addConn(room, got, 0, 3, 1, 'a'); // ord 1 joins later: it is older in the room's order
  assert.equal(room.host, 'a');
  core.leave(room, a);
  assert.equal(room.host, 'b');
  core.flush(room, 40);
  assert.ok(got[1].some((m) => m.t === 'host' && m.c === 'b'));
});

test('interest: near things at their full rate, far ones a few times a second, important ones more', () => {
  const { room, conns: [host, near, far] } = setup(3, 3);
  const counts = { near: 0, nearFar: 0, far: 0, farFar: 0, farImp: 0 };
  const dn = new core.Codec(), df = new core.Codec();
  near.send = (f: any) => { if (core.peek(f).kind !== 'bundle') return; const m = dn.read(f, true).msgs; counts.near += entries(m, 'nearBall').length; counts.nearFar += entries(m, 'farBall').length; };
  far.send = (f: any) => { if (core.peek(f).kind !== 'bundle') return; const m = df.read(f, true).msgs; counts.far += entries(m, 'nearBall').length; counts.farFar += entries(m, 'farBall').length; counts.farImp += entries(m, 'farCar').length; };
  send(room, near, { t: 'me', s: { p: [0, 0, 0] } }, 1);
  send(room, far, { t: 'me', s: { p: [1000, 0, 0] } }, 1);
  for (let t = 0; t < 3000; t += 33) {
    if (t % 99 === 0) {
      const k = t / 1000;
      send(room, host, { t: 'xf', at: t, x: [['nearBall', 0b111000111, k, 1, 0, 1, 0, 0], ['farBall', 0b111000111, 1000 + k, 1, 0, 1, 0, 0], ['farCar', 0b111000111 | (1 << 12), k, 1, 2, 1, 0, 0]] }, t);
    }
    core.flush(room, t);
  }
  assert.ok(counts.near >= 28, `near player gets the near ball every time (${counts.near})`);
  assert.ok(counts.far <= 2, `far player gets it every few seconds (${counts.far})`);
  assert.ok(counts.nearFar <= 2 && counts.farFar >= 28);
  assert.ok(counts.farImp > counts.far);
});

test('a byte budget per player: the most important goes first and nothing is lost', () => {
  // (The host here uploads far past a real game's rate: this is about the download budget, so its upload is not capped.)
  const { room, conns: [host, watcher] } = setup(2, 3, { limits: { upBytesPerSec: 1e9 } });
  let bytes = 0;
  const last = new Map<string, number>();
  const d = new core.Codec();
  watcher.send = (f: any) => { bytes += f.length; if (core.peek(f).kind !== 'bundle') return; for (const m of d.read(f, true).msgs) if (m.t === 'xf') for (const x of m.x) last.set(x[0], x[2]); };
  send(room, watcher, { t: 'me', s: { p: [0, 0, 0] } }, 1);
  for (let t = 0; t < 3000; t += 33) {
    if (t % 99 === 0) {
      const x: any[] = [['car', 0b111000111 | (1 << 12), t / 100, 0, 0, 1, 0, 0]];
      for (let i = 0; i < 3000; i++) x.push([`b${i}`, 0b111000111, (i % 40) + t / 1000, 0, Math.floor(i / 40), 1, 0, 0]);
      for (let i = 0; i < x.length; i += 500) send(room, host, { t: 'xf', at: t, x: x.slice(i, i + 500) }, t);
    }
    core.flush(room, t);
  }
  const perSecond = bytes / 3;
  assert.ok(perSecond < room.limits.downBytesPerSec * 1.6, `about the budget (${Math.round(perSecond / 1024)} KB/s)`);
  assert.ok(Math.abs((last.get('car') ?? 0) - 29.7) < 0.05, `the car is always current (${last.get('car')})`);
  for (let t = 3000; t < 12000; t += 33) core.flush(room, t);
  const behind = [...Array(3000).keys()].filter((i) => Math.abs((last.get(`b${i}`) ?? -1) - ((i % 40) + 2.97)) > 0.01).length;
  assert.equal(behind, 0, 'every thing caught up to its newest place');
});

test('a protocol 2 page and a protocol 3 page share one room', () => {
  const room = core.newRoom({});
  const got: any[][] = [];
  const old = addConn(room, got, 0, 2, 0);
  const neu = addConn(room, got, 1, 3, 1);
  send(room, old, [{ t: 'xf', at: 3, x: [['ball', 0b111, 1.5, 2.25, -3]] }, { t: 'me', at: 3, s: { p: [1, 2, 3], y: 1.57, f: 1 } }, { t: 'ev', name: 'hi', data: { a: [1, 'x'] } }], 3);
  send(room, neu, [{ t: 'me', at: 4, s: { p: [4, 5, 6], y: -0.5, h: 'car' } }, { t: 'ev', name: 'yo', data: 2.5 }, { t: 'own', id: 'ball', on: true }], 4);
  core.flush(room, 40);
  assert.deepEqual(entries(got[1], 'ball')[0], ['ball', 7, 1.5, 2.25, -3]);
  const me = got[1].find((m) => m.t === 'me');
  assert.deepEqual(me.s.p, [1, 2, 3]); assert.equal(me.s.f, 1); assert.ok(Math.abs(me.s.y - 1.57) < 0.001);
  assert.deepEqual(got[1].find((m) => m.t === 'ev' && m.name === 'hi').data, { a: [1, 'x'] });
  const me2 = got[0].find((m) => m.t === 'me');
  assert.deepEqual(me2.s.p, [4, 5, 6]); assert.equal(me2.s.h, 'car');
  assert.equal(got[0].find((m) => m.t === 'ev' && m.name === 'yo').data, 2.5);
  assert.equal(got[0].find((m) => m.t === 'own').c, 'p2');
});

test('codec: values round-trip, quantization stays within its step, and deltas never drift', () => {
  const a = new core.Codec(), b = new core.Codec();
  const data = { n: null, t: true, f: false, i: -123456789, big: 2 ** 50, d2: 3.14, d3: -0.125, x: Math.PI, s: 'héllo', arr: [1, [2, 'three']], bin: new Uint8Array([1, 2, 3]) };
  const out = b.read(a.bundle([{ t: 'ev', c: 'p1', name: 'x', data }], 1_800_000_000_000), true).msgs[0];
  assert.deepEqual({ ...out.data, bin: [...out.data.bin] }, { ...data, bin: [1, 2, 3] });
  let x = 10, y = 0, z = -5, rx = 3.1, vx = 1;
  for (let k = 0; k < 500; k++) {
    x += 0.0137; z -= 0.3; rx = rx + 0.21 > Math.PI ? rx + 0.21 - 2 * Math.PI : rx + 0.21; vx = Math.sin(k);
    const f = a.bundle([{ t: 'xf', c: 'p1', at: 1000 + k, x: [['t', 0b1001111, x, y, z, rx, vx]] }], 1000 + k);
    const got = b.read(f, true).msgs[0].x[0];
    // Half a step (1/256 m), plus the decoder's rounding to the millimetre.
    assert.ok(Math.abs(got[2] - x) <= 1 / 256 + 0.0005 + 1e-9 && Math.abs(got[4] - z) <= 1 / 256 + 0.0005 + 1e-9, `positions within half a step at ${k}`);
    const dr = Math.abs(((got[5] - rx + 3 * Math.PI) % (2 * Math.PI)) - Math.PI);
    assert.ok(dr < 1e-3, `rotation within a step at ${k} (${got[5]} vs ${rx})`);
    assert.ok(Math.abs(got[6] - vx) <= 0.025 + 1e-9);
  }
  assert.throws(() => b.read(new Uint8Array([0, 1, 2, 99, 1]), true), 'a short frame is refused, not misread');
});

test('the portal\'s measured scene: protocol 3 sends at most a third of protocol 2\'s bytes per player', () => {
  // docs/engine-modules.md: 100 stampeding cows, 3 vehicles, crates and 4 players measured 26-33 KB/s per player in
  // protocol 2. The same traffic through one room with a protocol 2 and a protocol 3 watcher.
  const room = core.newRoom({});
  const got: any[][] = [];
  const host = addConn(room, got, 0, 3, 0);
  const players = [1, 2, 3].map((i) => addConn(room, got, i, 3, i));
  const w2 = addConn(room, got, 4, 2, 4, 'watch2');
  const w3 = addConn(room, got, 5, 3, 5, 'watch3');
  let b2 = 0, b3 = 0;
  w2.send = (f: any) => { b2 += f.length; };
  w3.send = (f: any) => { b3 += f.length; };
  const things = [
    ...Array.from({ length: 100 }, (_, i) => ({ id: `cow${i}`, x: (i % 10) * 3, z: Math.floor(i / 10) * 3, imp: false })),
    ...['jeep', 'boat', 'heli'].map((id, i) => ({ id, x: 10 + i * 5, z: 40, imp: true })),
    ...Array.from({ length: 20 }, (_, i) => ({ id: `crate${i}`, x: 30 + i, z: -10, imp: false })),
  ];
  for (const c of [w2, w3, ...players]) send(room, c, { t: 'me', s: { p: [15, 0, 15], y: 0 } }, 10);
  const T = 10_000;
  for (let t = 0; t < T; t += 33) {
    // The host sends its things 10 a second (important ones 20), the players their avatars 15 a second.
    if (t % 99 === 0 || t % 66 === 0) {
      const fast = t % 66 === 0;
      const x: any[] = [];
      for (const th of things) {
        if (!th.imp && t % 99 !== 0) continue;
        if (th.id.startsWith('crate') && t > 2000) continue; // crates came to rest
        const k = t / 1000;
        const px = th.x + Math.sin(k + th.x) * 6, pz = th.z + Math.cos(k * 0.7 + th.z) * 6;
        const vx = Math.cos(k + th.x) * 6, vz = -Math.sin(k * 0.7 + th.z) * 4.2;
        x.push([th.id, 0b111111111 | (th.imp ? 1 << 12 : 0), Math.round(px * 1000) / 1000, 0.9, Math.round(pz * 1000) / 1000, 0, Math.round(Math.atan2(vx, vz) * 1000) / 1000, 0, Math.round(vx * 100) / 100, 0, Math.round(vz * 100) / 100]);
      }
      if (fast || t % 99 === 0) send(room, host, { t: 'xf', at: t, x }, t);
    }
    if (t % 66 === 0) for (const [i, p] of players.entries()) send(room, p, { t: 'me', at: t, s: { p: [15 + Math.sin(t / 900 + i) * 4, 0, 15 + i], y: Math.round(((t / 700) % 6) * 100) / 100 - 3, pi: 0.1, f: 0, h: null } }, t);
    core.flush(room, t);
  }
  const kb2 = b2 / (T / 1000) / 1024, kb3 = b3 / (T / 1000) / 1024;
  console.log(`  measured scene: protocol 2 ${kb2.toFixed(1)} KB/s, protocol 3 ${kb3.toFixed(1)} KB/s per player (${(kb2 / kb3).toFixed(1)}x smaller)`);
  assert.ok(kb2 > 15, `the scene is as heavy as measured (${kb2.toFixed(1)} KB/s)`);
  assert.ok(kb3 <= kb2 / 3, `protocol 3 at most a third (${kb3.toFixed(1)} vs ${kb2.toFixed(1)} KB/s)`);
});

test('a flush of a 32-player room with the measured scene takes under 2 ms', () => {
  // The median flush of the best of three runs: a test runner sharing the CPU (other test files, CI) only slows some.
  const run = () => {
    const room = core.newRoom({});
    const got: any[][] = [];
    const conns = Array.from({ length: 32 }, (_, i) => addConn(room, got, i, 3, i));
    for (const c of conns) c.send = () => {};
    for (const [i, c] of conns.entries()) send(room, c, { t: 'me', s: { p: [i * 2, 0, 0], y: 0 } }, 1);
    const x = Array.from({ length: 120 }, (_, i) => [`t${i}`, 0b111111111, i, 1, 2, 0, 1, 0, 1, 0, 1]);
    const times: number[] = [];
    for (let t = 100; t < 3100; t += 33) {
      if (t % 99 === 1) send(room, conns[0], { t: 'xf', at: t, x: x.map((e) => [e[0], e[1], (e[2] as number) + t / 1000, ...e.slice(3)]) }, t);
      for (const [i, c] of conns.entries()) if (t % 66 === 34 && i) send(room, c, { t: 'me', at: t, s: { p: [i * 2 + t / 1000, 0, 0], y: 0 } }, t);
      const s = performance.now();
      core.flush(room, t);
      if (t > 600) times.push(performance.now() - s);
    }
    times.sort((p, q) => p - q);
    return { median: times[Math.floor(times.length / 2)], mean: times.reduce((p, q) => p + q, 0) / times.length };
  };
  const best = [run(), run(), run()].sort((p, q) => p.median - q.median)[0];
  console.log(`  32-player flush: median ${best.median.toFixed(3)} ms, mean ${best.mean.toFixed(3)} ms`);
  assert.ok(best.median < 2, `median flush under 2 ms (${best.median.toFixed(3)})`);
});

test('a room moves: a snapshot seeds a new room with owners, things, states and sequence numbers', () => {
  const { room, conns: [a, b] } = setup(2, 3);
  send(room, a, [{ t: 'xf', at: 5, x: [['ball', 0b111, 4, 5, 6]] }, { t: 'ev', name: '_s', data: { n: 'w', d: { rain: true }, f: 1, at: 5 } }], 5);
  send(room, b, [{ t: 'own', id: 'car', on: true, lock: 1 }, { t: 'ev', name: 'x', data: 1, seq: 7 }], 6);
  const snap = core.snapshot(room);
  const next = core.newRoom({ epoch: 2 });
  core.seed(next, JSON.parse(JSON.stringify(snap)));
  assert.equal(next.locks.get('car'), 'p2');
  assert.deepEqual(next.ents.get('ball').v.slice(0, 3), [4, 5, 6]);
  assert.deepEqual(next.states.get('w').copy, { rain: true });
  assert.equal(next.seqs.get('p2'), 7);
  const got: any[][] = [];
  const nb = addConn(next, got, 1, 3, 10, 'p2');
  send(next, nb, { t: 'ev', name: 'x', data: 1, seq: 7 }, 11); // the same message again after the move: dropped
  core.flush(next, 40);
  assert.ok(!got[1].some((m) => m.t === 'ev' && m.name === 'x'));
});

test('message limits: 90 bundles a second, and a bad frame closes the connection', () => {
  const { room, conns: [a, b], got } = setup(2, 3);
  for (let i = 0; i < 200; i++) send(room, a, { t: 'ev', name: 'x', data: i }, 500);
  core.flush(room, 520);
  assert.equal(got[1].filter((m) => m.t === 'ev').length, room.limits.msgsPerSec);
  let closed = '';
  b.close = (_c: number, why: string) => { closed = why; };
  core.receive(room, b, new Uint8Array([0, 5, 2, 9, 1]), 600);
  assert.equal(closed, 'bad frame');
});

test('Track plays snapshots back smoothly behind the clock', () => {
  let now = 0;
  const t = new core.Track({ pos: [0, 1, 2], euler: [3, 4, 5], vel: [6, 7, 8] }, { clock: () => now, wall: () => now });
  for (let k = 0; k <= 10; k++) t.push(k * 100, [k, 0, 0, 0, k * 0.1, 0, 10, 0, 0], 'p1');
  now = 1000;
  const s = t.sample(now)!;
  assert.ok(s[0] > 7 && s[0] < 9.5, `about one interval behind (${s[0]})`);
  assert.ok(Math.abs(s[4] - s[0] * 0.1) < 0.02, 'turns follow');
});

test('a hostile peer: absurd numbers, deep values and floods never hang the room or break other streams', () => {
  const { room, conns: [a, b] } = setup(2, 3);
  const d = new core.Codec();
  const got: any[] = [];
  b.send = (f: any) => { if (core.peek(f).kind === 'bundle') got.push(...d.read(f, true).msgs); };
  // Infinity and 1e308 used to loop forever in the varint writer.
  send(room, a, { t: 'me', at: 1e308, s: { p: [1e308, -1e308, 5], y: 1e308, x: 1e300 } }, 1);
  send(room, a, { t: 'xf', at: -1e308, x: [['crate', 0b111, 1e308, -1e17, 3]] }, 1);
  let deep: any = 1;
  for (let i = 0; i < 100; i++) deep = [deep];
  send(room, a, { t: 'ev', name: 'deep', data: deep }, 1);
  send(room, a, { t: 'ev', name: 'after', data: 'ok' }, 1);
  const t0 = Date.now();
  core.flush(room, 40);
  assert.ok(Date.now() - t0 < 200, 'the flush ends');
  assert.ok(got.find((m) => m.t === 'ev' && m.name === 'after'), 'the stream still reads after a deep value');
  assert.ok(got.find((m) => m.t === 'xf'), 'the thing arrives, clamped');
  // A flood of bytes past the upload budget is dropped, not forwarded.
  const big = 'x'.repeat(30_000);
  for (let i = 0; i < 10; i++) send(room, a, { t: 'ev', name: 'big', data: big }, 50);
  got.length = 0;
  core.flush(room, 80);
  const bigs = got.filter((m) => m.t === 'ev' && m.name === 'big').length;
  assert.ok(bigs >= 1 && bigs <= 4, `the upload budget holds (${bigs} of 10 forwarded)`);
});

test('a stream keeps at most so many baselines and dictionary characters, and both ends still agree', () => {
  const enc = new core.Codec();
  const dec = new core.Codec();
  for (let round = 0; round < 3; round++) {
    for (let j = 0; j < 12; j++) {
      const x: any[] = [];
      for (let i = 0; i < 1000; i++) x.push([`thing-${j}-${i}-${'y'.repeat(40)}`, 0b111, i, round, 0]);
      const f = enc.bundle([{ t: 'xf', c: 'p1', at: 0, x }], 0, false);
      dec.read(f, true);
    }
  }
  assert.ok(dec.base.size <= 8192, `baselines ${dec.base.size}`);
  assert.ok(dec.dict.chars <= 262_144, `dictionary ${dec.dict.chars} characters`);
  assert.equal(dec.dict.list.length, enc.dict.list.length, 'the same dictionary at both ends');
});
