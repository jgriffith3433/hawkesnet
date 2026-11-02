// The two boxes' lanes (deploy/lane.mjs): beta follows `beta` and checks keys with gen-beta, live follows `main` and
// checks them with live Gen; a box set up before lanes (no NET_DEPLOY_BRANCH) stays live.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
// @ts-ignore: a plain .mjs module (deploy/ has no types)
import { lane, laneBranch, envFor, caddyfileFor, envProblem, envGenMoved } from '../deploy/lane.mjs';

test('beta and live never share a Gen, a branch, an address or a node id', () => {
  const live = lane('live'), beta = lane('beta');
  assert.equal(beta.gen, 'https://gen-beta-388576319982.us-central1.run.app', 'Gen beta direct, not through the Worker');
  assert.equal(live.gen, 'https://hawkesgen.ai');
  assert.equal(beta.host, 'hawkesnet.hawkesgen.ai');
  assert.equal(live.host, 'net.hawkesgen.ai');
  for (const k of ['gen', 'branch', 'host', 'nodeId', 'stateFile', 'ownerKey']) assert.notEqual(beta[k], live[k], k);
  assert.throws(() => lane('staging'));
});

test("a box's branch comes from its settings; anything but beta is live's main", () => {
  assert.equal(laneBranch('NET_DEPLOY_BRANCH=beta\n'), 'beta');
  assert.equal(laneBranch('NET_PORT=8800\nNET_GEN_URL=https://hawkesgen.ai\n'), 'main', 'the live box written before lanes');
  assert.equal(laneBranch('NET_DEPLOY_BRANCH=dev\n'), 'main');
  assert.equal(laneBranch(''), 'main');
});

test("the beta box's settings: gen-beta, its own address and node, one worker, following beta", () => {
  const text = envFor(lane('beta'), 'hg_test', 2);
  assert.match(text, /^NET_GEN_URL=https:\/\/gen-beta-388576319982\.us-central1\.run\.app$/m);
  assert.match(text, /^NET_PUBLIC_URL=wss:\/\/hawkesnet\.hawkesgen\.ai\/v1\/net\/ws$/m);
  assert.match(text, /^NET_NODE_ID=net-beta-1$/m);
  assert.match(text, /^NET_WORKERS=1$/m);
  assert.equal(laneBranch(text), 'beta');
  assert.equal(envProblem(text, lane('beta')), null);
  assert.match(String(envProblem(text, lane('live'))), /gen-beta/, 'a beta box is never taken for live');
  const live = envFor(lane('live'), 'hg_test', 2);
  assert.match(live, /^NET_GEN_URL=https:\/\/hawkesgen\.ai$/m);
  assert.match(live, /^NET_WORKERS=2$/m);
  assert.equal(laneBranch(live), 'main');
  // The live box's file from before lanes (no branch line) is still live.
  assert.equal(envProblem('NET_GEN_URL=https://hawkesgen.ai\n', lane('live')), null);
  assert.ok(envProblem('NET_GEN_URL=https://hawkesgen.ai\n', lane('beta')));
  // Gen's old names are the same Gen (a box set up before 2026-10-29), and setup moves them to the lane's.
  assert.equal(envProblem('NET_GEN_URL=https://gen.hawkesgen.ai\nNET_DEPLOY_BRANCH=main\n', lane('live')), null);
  assert.equal(envProblem('NET_GEN_URL=https://gen-beta.hawkesgen.ai\nNET_DEPLOY_BRANCH=beta\n', lane('beta')), null);
  assert.ok(envProblem('NET_GEN_URL=https://gen.hawkesgen.ai\nNET_DEPLOY_BRANCH=beta\n', lane('beta')));
  // The beta box set up with beta.hawkesgen.ai (the Worker) is moved to Gen beta's own address.
  assert.equal(envProblem('NET_GEN_URL=https://beta.hawkesgen.ai\nNET_DEPLOY_BRANCH=beta\n', lane('beta')), null);
  assert.equal(envGenMoved('NET_GEN_URL=https://beta.hawkesgen.ai\n', lane('beta')), 'NET_GEN_URL=https://gen-beta-388576319982.us-central1.run.app\n');
  assert.equal(envGenMoved('A=1\nNET_GEN_URL=https://gen.hawkesgen.ai\n', lane('live')), 'A=1\nNET_GEN_URL=https://hawkesgen.ai\n');
  assert.equal(envGenMoved('NET_GEN_URL=https://hawkesgen.ai\n', lane('live')), null);
});

test("Caddy serves the lane's own name", () => {
  const text = fs.readFileSync(new URL('../deploy/Caddyfile', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  const beta = caddyfileFor(text, lane('beta'));
  assert.match(beta, /^hawkesnet\.hawkesgen\.ai, net-beta\.hawkesgames\.com \{$/m);
  assert.doesNotMatch(beta, /^net\.hawkesgen\.ai/m);
  assert.equal(caddyfileFor(text, lane('live')), text);
});

test("the portal's beta key (ustg_*) may make tickets in the portal's project", () => {
  const p = JSON.parse(fs.readFileSync(new URL('../projects.json', import.meta.url), 'utf8'));
  assert.ok(p.projects.hawkesgenwebsite.keyProjects.includes('ustg_*'));
  assert.ok(p.projects.hawkesgenwebsite.keyProjects.includes('usr_*'));
});

test("Studio's beta sites (sites.hawkesgen.ai) get test rooms for Hawkes's own Net games, never live ones", () => {
  const p = JSON.parse(fs.readFileSync(new URL('../projects.json', import.meta.url), 'utf8')).projects;
  for (const id of ['netdemo', 'doseofdestruction', 'sickofit', 'yoobaland']) {
    assert.ok(p[id].testOrigins.includes('https://sites.hawkesgen.ai'), id);
    assert.ok(!p[id].origins.includes('https://sites.hawkesgen.ai'), id + ': a shared host is never a live origin');
  }
});
