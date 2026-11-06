// The /demo page draws everyone through layout() (public/demo.html): dots stay inside the arena and never touch, names stay inside.
// The function is cut out of the page and run here with made-up players, so the corner case that failed on beta
// ('still overlapping: Guest 308/Playtest bot 3px', pairwise push-apart undone by the clamp) can't come back unseen.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const page = fs.readFileSync(new URL('../public/demo.html', import.meta.url), 'utf8');
const body = page.slice(page.indexOf('const PAD = 4'), page.indexOf('let last = performance.now()'));
const W = 960, H = 600;

type Spot = [number, number];
function draw(me: Spot, others: Spot[]) {
  const tracks = new Map<string, { sample: () => number[] }>(), peers = new Map<string, { name: string; color: string }>();
  others.forEach((o, i) => { tracks.set(`p${i}`, { sample: () => [o[0], 0, o[1]] }); peers.set(`p${i}`, { name: i ? `Bot ${i}` : 'Playtest bot', color: '#888' }); });
  const g = { measureText: (t: string) => ({ width: t.length * 7 }) };
  const make = new Function('W', 'H', 'g', 'pos', 'tracks', 'net', `${body}; return layout;`);
  return make(W, H, g, { x: me[0], y: me[1] }, tracks, { id: 'me', name: 'Guest 308', peers })() as any[];
}

function problems(items: any[]) {
  const bad: string[] = [];
  for (const it of items) {
    if (it.x - it.r < 0 || it.y - it.r < 0 || it.x + it.r > W || it.y + it.r > H) bad.push(`dot ${it.text} clipped`);
    const l = it.label;
    if (!l || l.x - l.w / 2 < 0 || l.top < 0 || l.x + l.w / 2 > W || l.top + l.h > H) bad.push(`name ${it.text} clipped`);
  }
  for (let i = 0; i < items.length; i++) for (let j = i + 1; j < items.length; j++) {
    const d = Math.hypot(items[i].x - items[j].x, items[i].y - items[j].y);
    if (d < items[i].r + items[j].r) bad.push(`${items[i].text}/${items[j].text} overlap ${Math.round(d)}px`);
  }
  return bad;
}

test('players stacked in a corner, outside the arena or on one spot are drawn apart and inside', () => {
  const cases: [string, Spot, Spot[]][] = [
    ['corner and outside', [15, 15], [[-80, -80], [2000, 2000]]],
    ['all on the top-left corner', [15, 15], [[15, 15], [15, 15]]],
    ['bottom-right corner', [945, 585], [[945, 585], [945, 585]]],
    ['all in the middle', [480, 300], Array.from({ length: 5 }, () => [480, 300] as Spot)],
    ['a crowd in a corner', [15, 15], Array.from({ length: 30 }, () => [0, 0] as Spot)],
  ];
  for (const [name, me, others] of cases) assert.deepEqual(problems(draw(me, others)), [], name);
});

test('this player stays where it is; the others move away', () => {
  const items = draw([15, 15], [[15, 15]]);
  const me = items.find((i) => i.me);
  assert.deepEqual([me.x, me.y], [15, 15]);
});

test('walking along the edge into a parked corner, every frame keeps dots apart and names inside', () => {
  const parked: Spot[] = [[0, 0], [-80, -80], [15, 15]];
  for (let x = 480; x >= 15; x -= 5) assert.deepEqual(problems(draw([x, 15], parked)), [], `me at ${x},15`);
  for (let y = 15; y <= 585; y += 5) assert.deepEqual(problems(draw([15, y], parked)), [], `me at 15,${y}`);
});
