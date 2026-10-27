# @hawkesgen/net

Multiplayer for web games on [Hawkes Net](https://net.hawkesgen.com): rooms on our relay (or peer to peer where your
project allows it), messages that arrive once and in order, avatars, synced state, express frames for what can't wait
(a fighting game's inputs), a shared clock, and games that keep going when a player's tab is in the background.

```bash
npm install @hawkesgen/net
```

```js
import { join } from '@hawkesgen/net';

const net = await join('lobby-1', { project: 'my-game', name: 'Ada' }); // your project from net.hawkesgen.com
net.on('chat', (text, from) => console.log(from.name, text));
net.send('chat', 'hi');
net.pose([x, y, z], yaw);                                                // your avatar
net.onPose((id, state) => moveAvatar(id, state.p, state.y));
```

- **Projects and tickets:** make an account and a project at [net.hawkesgen.com](https://net.hawkesgen.com). A page on one
  of your project's sites joins with no key; servers, bots and tests use your API key.
- **The standard layer:** `lobby({ project, liveHosts })` keeps a shared room per area, with live and test rooms, shards
  when one is full, and rejoining by itself.
- **In the background:** `background(fn)` keeps your game's step running while the page has no animation frames, and the
  room marks a hidden player `away` (`peer:away`); an away host hands the room to a present player.
- **Types:** `hawkes-net.d.ts` ships with the package.
- **No dependencies.** It also loads straight from `https://net.hawkesgen.com/sdk/hawkes-net@1.mjs`.

Docs: [net.hawkesgen.com](https://net.hawkesgen.com) > Docs. License: MIT.
