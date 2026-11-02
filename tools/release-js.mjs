// Publishes the JS SDK (sdk/js, @hawkesgen/net) to its public repo, jgriffith3433/hawkesnet-js, tagged v<version>, so
// games depend on it by version: "@hawkesgen/net": "https://github.com/jgriffith3433/hawkesnet-js/archive/refs/tags/v1.2.1.tar.gz" (npm once it is there).
// sdk/js stays the source (the relay nodes run its core); the public repo is a copy of its files at the root.
//
//   node tools/release-js.mjs            copy, commit and tag the version in sdk/js/package.json; push with --push
//   node tools/release-js.mjs --push     ...and push main and the tag
//
// Needs a checkout of hawkesnet-js next to this repo. --push uses whatever git access the machine already has (a Claude
// session with both repos needs no token); ops-release-js only checks a release, it keeps no token for hawkesnet-js.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'sdk', 'js');
const DEST = path.resolve(ROOT, '..', 'hawkesnet-js');
const push = process.argv.includes('--push');
const env = { ...process.env, GIT_CONFIG_COUNT: '2', GIT_CONFIG_KEY_0: 'credential.helper', GIT_CONFIG_VALUE_0: '', GIT_CONFIG_KEY_1: 'credential.helper', GIT_CONFIG_VALUE_1: 'store', GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' };
const git = (...args) => execFileSync('git', args, { cwd: DEST, env, encoding: 'utf8' }).trim();

if (!fs.existsSync(path.join(DEST, '.git'))) throw new Error(`No checkout at ${DEST}: git clone https://github.com/jgriffith3433/hawkesnet-js.git`);
const pkg = JSON.parse(fs.readFileSync(path.join(SRC, 'package.json'), 'utf8'));
const tag = `v${pkg.version}`;
const core = fs.readFileSync(path.join(SRC, 'hawkes-net-core.mjs'), 'utf8');
if (!core.includes(`VERSION = '${pkg.version}'`)) throw new Error(`hawkes-net-core.mjs VERSION is not ${pkg.version}: bump both together`);
if (git('tag', '--list', tag)) throw new Error(`${tag} is already released: bump the version in sdk/js/package.json and the core`);

for (const f of [...pkg.files, 'package.json']) fs.copyFileSync(path.join(SRC, f), path.join(DEST, f));
git('add', '-A');
if (git('status', '--porcelain')) git('commit', '-q', '-m', `@hawkesgen/net ${pkg.version}`);
git('tag', '-a', tag, '-m', `@hawkesgen/net ${pkg.version}`);
console.log(`hawkesnet-js: ${tag} at ${git('rev-parse', '--short', 'HEAD')}`);
if (push) {
  git('push', '-q', 'origin', 'HEAD:main');
  git('push', '-q', 'origin', tag);
  console.log(`pushed: "@hawkesgen/net": "https://github.com/jgriffith3433/hawkesnet-js/archive/refs/tags/${tag}.tar.gz"`);
} else console.log('not pushed (--push to publish)');
