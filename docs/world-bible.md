# Hawkes Net demo: world bible

## Areas

**The Arena** — a dark 960×600 play field on `/demo`. Mood: clean multiplayer lab, one shared room, no menus between players. Looks like a marked court (border, centre line, centre circle, corner arcs) under a soft cyan floor wash; dust motes drift on their own; five orbs glow as beacons. Sounds are short WebAudio pickups and a round-end fanfare (no looping music yet). Size is one screen. Players enter by joining a `?room=` (invite link) and leave with Leave; bots can fill the court.

## Landmarks

**The five lit orbs** — the only glowing landmarks; they respawn wherever the host places them after each collect, so the court always has five beacons to steer by.

**The round clock** — fixed at the top centre of the arena; counts the host’s play window down from sixty seconds (or a shorter `?round=` hook). In the last ten seconds it pulses so every screen feels the same pressure.

## Who lives here

**Guests** — named dots (Guest NNN or a chosen `?name=`). They move with arrows, drag or tap; touching an orb scores. Routines are player-driven: chase orbs, watch the clock, read the scoreboard when a round ends.

**The room host** — one peer owns shared state (orbs, scores, round phase and deadlines). When the host leaves, another peer becomes host and continues the same round from that document; scores and the clock do not reset.

## What happens

Interactions: move, collect orbs (+1 burst/sound), mute, invite, add bots, move the room to the relay, leave.

Events on their own: drifting motes; orb idle pulse; round timer; at 0 a short confetti burst and fanfare, the winner’s dot grows a gold ring, their name large, and a sorted scoreboard for about three seconds; then scores clear and a new round starts with five fresh orbs.

Ambient: court lines, cyan floor wash, motes, orb glow and the clock; collect chirps and round fanfare when unmuted.

## Story beats

1. **Join the court** — the arena says Joining until the room is up; peers pop in with a ring (gameplay + FX, not a text beat).
2. **Chase the orbs** — score by touch; every collect is a burst, +1 pop and pickup sound on every screen.
3. **Beat the clock** — the host’s sixty-second round ends; confetti and fanfare hit, the winner’s dot rings gold while their name and the board show, then the next round starts by itself.
4. **Host hands off** — if the host drops mid-round, the clock and scores keep going for everyone still in the room.

## Docs as play (developers)

The quickstart’s JavaScript steps are executable canon: Ada then Bob join one room and print the lines under each “You should see”. The docs playtest (`tools/docs-playtest.mjs`) runs those snippets as written; `/demo`’s `site` scenario replays the same lines live so a playtest can see them.
