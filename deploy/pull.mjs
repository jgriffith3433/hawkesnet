// The Hawkes Net box deploys itself (hawkes-net-pull.timer, every 2 minutes): when hawkesnet's main moved and the change
// touches the service (src/, the SDK in sdk/js, public/, projects.json, deploy/), it runs the tests (test/: no packages
// needed) on a clean copy of the new commit, fast-forwards, restarts (the relay drains first) and checks health; a commit
// whose tests or health fail is skipped. Other changes (docs, the Unity package) are fast-forwarded with no restart.
// Runs as root. No dependencies.   node deploy/pull.mjs [--dry-run]
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const DIR = '/srv/hawkes/hawkesnet';
const STATE = '/srv/hawkes/net-data/pull.json';
const DRY = process.argv.includes('--dry-run');
const say = (...a) => console.log('[net-pull]', ...a);
const git = (...a) => execFileSync('sudo', ['-u', 'hawkes', '-H', 'git', '-C', DIR, ...a], { encoding: 'utf8' }).trim();
const state = (() => { try { return JSON.parse(fs.readFileSync(STATE, 'utf8')); } catch { return {}; } })();
const save = () => { if (!DRY) fs.writeFileSync(STATE, JSON.stringify(state, null, 2)); };
const NET = /^(src\/|sdk\/js\/|public\/|projects\.json|deploy\/)/;

const healthy = async () => {
  for (let i = 0; i < 20; i++) {
    const ok = await fetch('http://127.0.0.1:8800/healthz', { signal: AbortSignal.timeout(3000) }).then((r) => r.ok).catch(() => false);
    if (ok) return true;
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
};

/** Hawkes Net's tests on a clean copy of `sha` (they need no packages), niced, with no secrets in the environment. */
function testedHere(sha) {
  if (state.tested?.sha === sha) return state.tested.ok;
  const wt = '/srv/hawkes/.net-test';
  const cleanup = () => { try { git('worktree', 'remove', '--force', wt); } catch { /* not there */ } fs.rmSync(wt, { recursive: true, force: true }); try { git('worktree', 'prune'); } catch { /* fine */ } };
  const t0 = Date.now();
  try {
    cleanup();
    git('worktree', 'add', '--detach', '--quiet', wt, sha);
    const tests = fs.readdirSync(path.join(wt, 'test')).filter((f) => f.endsWith('.test.ts')).map((f) => `test/${f}`);
    try {
      execFileSync('sudo', ['-u', 'hawkes', '-H', 'env', '-i', 'PATH=/usr/local/bin:/usr/bin:/bin', 'HOME=/home/hawkes', 'LANG=C.UTF-8', 'CI=1', 'nice', '-n', '19', 'node', '--disable-warning=ExperimentalWarning', '--test', '--test-timeout=120000', ...tests], { cwd: wt, stdio: ['ignore', 'pipe', 'pipe'], timeout: 15 * 60_000, maxBuffer: 64 * 1024 * 1024 });
      state.tested = { sha, ok: true, at: new Date().toISOString(), seconds: Math.round((Date.now() - t0) / 1000) };
    } catch (e) {
      const out = `${e.stdout ?? ''}\n${e.stderr ?? ''}`.split('\n').filter((l) => /^(✖|not ok)/.test(l.trim())).slice(0, 6).join(' | ');
      state.tested = { sha, ok: false, at: new Date().toISOString(), detail: (out || String(e.message).split('\n')[0]).slice(0, 500) };
    }
  } catch (e) {
    say(`${sha.slice(0, 7)}: couldn't set up the test copy: ${String(e.message).split('\n')[0]}`);
    return null;
  } finally { cleanup(); }
  save();
  return state.tested.ok;
}

git('fetch', '--quiet', 'origin', 'main');
const head = git('rev-parse', 'HEAD');
const tip = git('rev-parse', 'origin/main');
if (head === tip || state.bad === tip) process.exit(0);
// Already in what's running (the box was set up from a branch ahead of main): nothing to do until main passes it.
try { git('merge-base', '--is-ancestor', tip, head); process.exit(0); } catch { /* main has something new */ }
const changed = git('diff', '--name-only', head, tip).split('\n').filter(Boolean);
const touchesNet = changed.some((f) => NET.test(f));
if (DRY) { say(`would ${touchesNet ? 'test and deploy' : 'fast-forward'} ${head.slice(0, 7)} -> ${tip.slice(0, 7)}`); process.exit(0); }
if (!touchesNet) { git('merge', '--ff-only', '--quiet', tip); say(`${tip.slice(0, 7)}: nothing for Hawkes Net, fast-forwarded`); process.exit(0); }

say(`${tip.slice(0, 7)}: Hawkes Net changed; testing here`);
const ok = testedHere(tip);
if (ok === null) process.exit(0);
if (!ok) { say(`${tip.slice(0, 7)}: tests failed, not deploying: ${state.tested?.detail ?? ''}`); state.bad = tip; save(); process.exit(0); }
git('merge', '--ff-only', '--quiet', tip);
execFileSync('systemctl', ['restart', 'hawkes-net']);
if (await healthy()) {
  say(`deployed ${head.slice(0, 7)} -> ${tip.slice(0, 7)}`);
  state.deployed = { sha: tip, at: new Date().toISOString() };
  save();
} else {
  say(`${tip.slice(0, 7)}: unhealthy after restart, going back to ${head.slice(0, 7)}`);
  git('reset', '--hard', '--quiet', head);
  execFileSync('systemctl', ['restart', 'hawkes-net']);
  state.bad = tip;
  save();
}
