// A node restart: the room is gone, so a resume try is refused (410 resume_gone, or a 502 while the node comes back). The SDK
// makes one resume try, then asks for a new ticket: at most one refused resume, and the player is back in the room.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';

const { startTestHub } = await import('./helper.ts');
const { join } = await import('../sdk/js/hawkes-net.mjs');
const hub = await startTestHub();
after(async () => { await hub.stop(); });

test('reconnect after a node restart: one failed resume, then a new ticket', async () => {
  const urls: string[] = [];
  let refusedResumes = 0;
  // Resume tries fail the way a restarted node's do (the socket closes before any hello); a ticket goes through.
  class RestartedNodeWS extends WebSocket {
    constructor(url: string, protocols?: string | string[]) {
      const resume = /[?&]r=/.test(url);
      urls.push(url);
      super(resume ? url.replace(/[?&]r=[^&]*/, '&r=not-a-resume-token') : url, protocols);
      if (resume) { refusedResumes++; }
    }
  }
  const net = await join('reconnect-restart', { project: 'netdemo', endpoint: hub.endpoint, transport: 'relay', name: 'Rec', log: false, leaveOnHide: false, WebSocket: RestartedNodeWS });
  const back = new Promise<any>((resolve) => net.when('ready', resolve));
  net.ws.close(); // the socket drops under us
  const t0 = performance.now();
  await back;
  const ms = performance.now() - t0;
  const kinds = urls.map((u) => (/[?&]r=/.test(u) ? 'resume' : 'ticket'));
  assert.deepEqual(kinds, ['ticket', 'resume', 'ticket'], `connect order: ${kinds.join(', ')}`);
  assert.ok(refusedResumes <= 1, `${refusedResumes} resume tries`);
  assert.ok(ms < 4000, `back in ${Math.round(ms)} ms`);
  await net.leave();
});
