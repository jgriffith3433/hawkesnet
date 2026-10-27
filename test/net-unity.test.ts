// The Unity package's WebGL bridge (sdk/unity/com.hawkes.net/Runtime/Plugins/WebGL/HawkesNet.jslib) run as Unity
// would run it, with Emscripten's helpers stubbed (UTF8ToString, SendMessage, _malloc), against the real SDK and the
// Hawkes Net service (in this process): join, the ready event with the peers, a peer arriving, messages both ways as
// JSON, poses read once a frame, leaving. The C# side (HawkesNet.cs) parses exactly these events.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const { startTestHub } = await import('./helper.ts');
const hub = await startTestHub();
const endpoint = hub.endpoint;
test.after(async () => { for (const h of Object.keys((globalThis as any).__hawkesNet?.rooms ?? {})) lib.HawkesNet_Leave(Number(h)); await hub.stop(); });

// Emscripten as Unity's WebGL build gives a jslib: strings are pointers into the heap; here a pointer is an index.
const heap: (string | null)[] = [null];
const ptr = (s: string) => (heap.push(s), heap.length - 1);
const got: any[] = [];
const lib: Record<string, Function> = {};
const env = {
  mergeInto: (_l: unknown, fns: Record<string, Function>) => Object.assign(lib, fns),
  LibraryManager: { library: {} },
  UTF8ToString: (p: number) => heap[p] ?? '',
  SendMessage: (to: string, method: string, json: string) => { assert.equal(to, 'HawkesNet'); assert.ok(method === 'OnNet' || method === 'OnNetCount'); got.push({ ...JSON.parse(json), _m: method }); },
  lengthBytesUTF8: (s: string) => Buffer.byteLength(s),
  _malloc: () => heap.push(null) - 1,
  stringToUTF8: (s: string, p: number) => { heap[p] = s; },
  // Unity's main loop as Emscripten keeps it (RunInBackground runs one iteration at a time).
  Browser: { mainLoop: { iterations: 0, func() { this.iterations++; }, runIter(f: () => void) { f.call(this); } } },
};
const src = fs.readFileSync(new URL('../sdk/unity/com.hawkes.net/Runtime/Plugins/WebGL/HawkesNet.jslib', import.meta.url), 'utf8');
new Function(...Object.keys(env), src)(...Object.values(env));
(globalThis as any).window = globalThis;

const wait = async (pred: () => any, ms = 5000, what = 'condition') => {
  const until = Date.now() + ms;
  for (;;) { const v = pred(); if (v) return v; if (Date.now() > until) throw new Error(`timed out waiting for ${what}`); await new Promise((r) => setTimeout(r, 20)); }
};
const sdkUrl = new URL('../sdk/js/hawkes-net.mjs', import.meta.url).href;
const opts = (name: string) => JSON.stringify({ project: 'netdemo', endpoint, name, transport: 'relay', sdkUrl, leaveOnHide: false, log: false, ticketUrl: '', role: 'player' });

test('a Unity game joins through the bridge: ready, peers, messages as JSON both ways, poses once a frame, leave', async () => {
  lib.HawkesNet_Join(1, ptr('unity1'), ptr(opts('Ada')), ptr('HawkesNet'));
  const ready1 = await wait(() => got.find((e) => e.h === 1 && e.e === 'ready'), 5000, 'room 1 ready');
  assert.equal(ready1.transport, 'relay');
  assert.ok(ready1.peer, 'its own peer id');
  assert.deepEqual(JSON.parse(ready1.data), [], 'nobody else yet');

  lib.HawkesNet_Join(2, ptr('unity1'), ptr(opts('Bo')), ptr('HawkesNet'));
  const ready2 = await wait(() => got.find((e) => e.h === 2 && e.e === 'ready'), 5000, 'room 2 ready');
  assert.deepEqual(JSON.parse(ready2.data).map((p: any) => p.name), ['Ada'], 'the peers already there');
  const joined = await wait(() => got.find((e) => e.h === 1 && e.e === 'join'), 5000, 'Ada hears Bo');
  assert.equal(joined.name, 'Bo');
  assert.equal(joined.peer, ready2.peer);
  assert.ok(joined.ord > ready1.ord, 'the join order rides with a peer (the oldest is the host)');

  assert.equal(lib.HawkesNet_Send(1, ptr('chat'), ptr('{"text":"hello"}'), 1, ptr('')), 1);
  const msg = await wait(() => got.find((e) => e.h === 2 && e.e === 'msg' && e.kind === 'chat'), 5000, 'Bo gets the chat');
  assert.deepEqual(JSON.parse(msg.data), { text: 'hello' });
  assert.equal(msg.peer, ready1.peer);
  assert.equal(lib.HawkesNet_Send(9, ptr('chat'), ptr(''), 1, ptr('')), 0, 'no such room');

  // Text: the game's own string arrives as it was sent (not as JSON).
  assert.equal(lib.HawkesNet_SendText(1, ptr('say'), ptr('plain "words", not JSON'), 1, ptr('')), 1);
  const said = await wait(() => got.find((e) => e.h === 2 && e.e === 'msg' && e.kind === 'say'), 5000, 'Bo gets the text');
  assert.equal(said.text, true);
  assert.equal(said.data, 'plain "words", not JSON');

  // Poses: yaw in radians on the wire (HawkesNet.cs takes degrees), extra values with them, the sender's time.
  lib.HawkesNet_Pose(1, 1.5, 2, -3.25, 1.25, ptr('{"f":"balloon","c":"car-1","s":1.5}'));
  const read = () => { const p = lib.HawkesNet_Poses(2); return p ? JSON.parse(heap[p] as string).items : null; };
  const first = await wait(read, 5000, 'a pose for Bo');
  assert.equal(first.length, 1);
  assert.equal(first[0].id, ready1.peer);
  assert.deepEqual([first[0].x, first[0].y, first[0].z, first[0].r], [1.5, 2, -3.25, 1.25]);
  assert.deepEqual(JSON.parse(first[0].e), { f: 'balloon', c: 'car-1', s: 1.5 });
  assert.ok(first[0].at > 0, 'when, on the room clock');
  assert.equal(lib.HawkesNet_Poses(2), null, 'nothing new since the last read');
  // A key left out is gone for the others too (the SDK merges poses; the bridge sends it as null once).
  lib.HawkesNet_Pose(1, 2, 2, -3.25, 1.25, ptr('{"f":"balloon","s":1.5}'));
  const second = await wait(read, 5000, 'the next pose');
  assert.deepEqual(JSON.parse(second[0].e), { f: 'balloon', s: 1.5 });
  lib.HawkesNet_Pose(1, 2.5, 2, -3.25, 1.25, ptr(''));
  const third = await wait(read, 5000, 'a pose with no extras');
  assert.equal(third[0].e, '');
  assert.ok(lib.HawkesNet_Now(1) > 0);

  // The public counts (a project with its own sites): players per room.
  lib.HawkesNet_Count(77, ptr(endpoint), ptr('netdemo'), ptr('unity1,nobody-here'), ptr('HawkesNet'));
  const counted = await wait(() => got.find((e) => e._m === 'OnNetCount' && e.id === 77 && (e.rooms?.unity1 === 2 || !e.ok)), 5000, 'the counts');
  assert.equal(counted.ok, true, counted.error);
  assert.deepEqual(counted.rooms, { unity1: 2, 'nobody-here': 0 });
  lib.HawkesNet_Count(78, ptr(endpoint), ptr('hawkesgenwebsite'), ptr('x'), ptr('HawkesNet'));
  const refused = await wait(() => got.find((e) => e._m === 'OnNetCount' && e.id === 78), 5000, 'a refused count');
  assert.equal(refused.ok, false, 'a project without its own sites has no public counts');

  lib.HawkesNet_Leave(1);
  const left = await wait(() => got.find((e) => e.h === 2 && e.e === 'leave'), 5000, 'Bo hears Ada leave');
  assert.equal(left.peer, ready1.peer);
  lib.HawkesNet_Leave(2);
});

test("away through the bridge: a peer's page in the background, the host handed over, and the game's own SetAway", async () => {
  lib.HawkesNet_Join(4, ptr('unity-away'), ptr(opts('Host')), ptr('HawkesNet'));
  const r4 = await wait(() => got.find((e) => e.h === 4 && e.e === 'ready'), 5000, 'room 4 ready');
  lib.HawkesNet_Join(5, ptr('unity-away'), ptr(opts('Other')), ptr('HawkesNet'));
  const r5 = await wait(() => got.find((e) => e.h === 5 && e.e === 'ready'), 5000, 'room 5 ready');
  assert.equal(r5.host, r4.peer, 'the first in hosts');
  lib.HawkesNet_SetAway(4, 1);
  const away = await wait(() => got.find((e) => e.h === 5 && e.e === 'away'), 5000, 'Other hears Host is away');
  assert.deepEqual([away.peer, away.away], [r4.peer, true]);
  const host = await wait(() => got.find((e) => e.h === 5 && e.e === 'host' && e.peer === r5.peer), 5000, 'the room handed to Other');
  assert.equal(host.reason, 'host away');
  assert.ok(got.find((e) => e.h === 4 && e.e === 'selfaway' && e.away === true), 'the game hears its own page is away');
  lib.HawkesNet_Join(6, ptr('unity-away'), ptr(opts('Late')), ptr('HawkesNet'));
  const r6 = await wait(() => got.find((e) => e.h === 6 && e.e === 'ready'), 5000, 'room 6 ready');
  assert.equal(JSON.parse(r6.data).find((p: any) => p.peer === r4.peer)?.away, true, 'a joiner knows who is away');
  lib.HawkesNet_Leave(4); lib.HawkesNet_Leave(5); lib.HawkesNet_Leave(6);
});

test("RunInBackground: Unity's main loop runs from Hawkes Net's background clock until it is turned off", async () => {
  const loop = (env.Browser.mainLoop as any);
  assert.equal(lib.HawkesNet_RunInBackground(1, ptr(sdkUrl)), 1, "Unity's main loop found");
  await wait(() => loop.iterations > 10, 3000, 'iterations');
  assert.equal(lib.HawkesNet_RunInBackground(0, ptr(sdkUrl)), 1);
  const n = loop.iterations;
  await new Promise((r) => setTimeout(r, 150));
  assert.ok(loop.iterations - n <= 1, 'stopped');
});

test('a refused join reaches the game as an error event, never a throw', async () => {
  lib.HawkesNet_Join(3, ptr('bad room!'), ptr(opts('Cy')), ptr('HawkesNet'));
  const err = await wait(() => got.find((e) => e.h === 3 && e.e === 'error'), 5000, 'the error');
  assert.ok(err.data, 'with a reason');
});
