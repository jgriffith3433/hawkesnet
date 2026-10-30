// Makes the beta Hawkes Net box on Google Cloud (J, 2026-10-29: beta never touches live): https://hawkesnet.hawkesgen.ai,
// following hawkesnet `beta`, with its own data, Gen key (made on gen-beta) and SSH key. Mirrors the live box (the VM
// hawkes-net in hawkes-prod, us-east4-c, e2-small, Ubuntu 24.04, tag hawkes-web), except the size and region: Google's
// free tier covers one e2-micro (2 shared vCPUs, 1 GB) a month in us-east1, us-west1 or us-central1, with a 30 GB
// standard disk. Hawkes Net with one relay worker idles at about 230 MB (hub and worker, measured 2026-10-29), so beta's
// playtests fit, with cloud-init's 2 GB swap behind it.
//
//   node deploy/provision-gce.mjs            what it would make; changes nothing
//   node deploy/provision-gce.mjs --apply    makes what's missing (safe to run again), then the DNS record, then the state
//   then: node deploy/setup.mjs --lane beta  (code, settings, units, Caddy: as the live box)
//
// What it makes, in project hawkes-prod (where live Net's firewall rules are: tag hawkes-web opens 80/443 to everyone,
// and hawkes-ssh-j opens 22 to J's addresses): the SSH key hawkesstudio/deploy/.keys/net_beta_ed25519, a static address
// hawkes-net-beta-ip (us-east1), the VM hawkes-net-beta (e2-micro, us-east1-b, 30 GB pd-standard, no service account:
// the box never calls Google), first boot deploy/cloud-init.sh, and on Cloudflare the A record hawkesnet.hawkesgen.ai
// (DNS only: Caddy gets its certificate from Let's Encrypt over HTTP). State: hawkesstudio/deploy/.keys/net-beta.json.
// Needs: gcloud signed in as J, and the `cf` CLI signed in (cf auth login) for the DNS step.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { lane } from './lane.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APPLY = process.argv.includes('--apply');
const L = lane('beta');
const PROJECT = 'hawkes-prod';
const REGION = 'us-east1';
const ZONE = 'us-east1-b';
const NAME = 'hawkes-net-beta';
const IP_NAME = `${NAME}-ip`;
const TYPE = 'e2-micro';
const DISK_GB = 30;
const TAG = 'hawkes-web';
const DNS_ZONE = 'hawkesgen.ai';
const KEYS = path.resolve(HERE, '..', '..', 'hawkesstudio', 'deploy', '.keys');
const KEY_FILE = path.join(KEYS, 'net_beta_ed25519');
const STATE_FILE = path.join(KEYS, L.stateFile);
const log = (s) => console.log(`[net-beta] ${s}`);

const sdk = path.join(process.env.LOCALAPPDATA ?? '', 'Google', 'Cloud SDK', 'google-cloud-sdk');
// gcloud through the SDK's own Python on Windows (no cmd.exe quoting), plain gcloud elsewhere.
function gcloud(...a) {
  const [bin, pre] = process.platform === 'win32' ? [path.join(sdk, 'platform', 'bundledpython', 'python.exe'), [path.join(sdk, 'lib', 'gcloud.py')]] : ['gcloud', []];
  return spawnSync(bin, [...pre, ...a, `--project=${PROJECT}`, '--quiet'], { encoding: 'utf8' });
}
const gjson = (...a) => { const r = gcloud(...a, '--format=json'); return r.status === 0 ? JSON.parse(r.stdout || 'null') : null; };
const must = (r, what) => { if (r.status !== 0) throw new Error(`${what}: ${(r.stderr || r.stdout).trim().split('\n').slice(-3).join(' | ')}`); return r; };
// The cf CLI's own script through Node (no shell, so JSON arguments arrive intact on Windows).
function cf(...a) {
  const root = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['root', '-g'], { encoding: 'utf8', shell: process.platform === 'win32' }).stdout.trim();
  const r = spawnSync(process.execPath, [path.join(root, 'cf', 'bin', 'cf'), ...a], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`cf ${a.slice(0, 3).join(' ')}: ${(r.stderr || r.stdout).slice(-300)}`);
  try { return JSON.parse(r.stdout); } catch { return r.stdout; }
}

const vm = gjson('compute', 'instances', 'describe', NAME, `--zone=${ZONE}`);
const ip = gjson('compute', 'addresses', 'describe', IP_NAME, `--region=${REGION}`);
const rules = gjson('compute', 'firewall-rules', 'list') ?? [];
const web = rules.find((r) => (r.targetTags ?? []).includes(TAG) && (r.allowed ?? []).some((x) => (x.ports ?? []).includes('443')));
const sshRule = rules.find((r) => (r.targetTags ?? []).includes(TAG) && (r.allowed ?? []).some((x) => (x.ports ?? []).includes('22')));
log('plan:');
log(`  SSH key ${KEY_FILE}: ${fs.existsSync(KEY_FILE) ? 'exists' : 'new (ed25519)'}`);
log(`  address ${IP_NAME} (${REGION}): ${ip ? `exists, ${ip.address}` : 'new, static'}`);
log(`  VM ${NAME}: ${vm ? `exists (${vm.status}, ${String(vm.machineType).split('/').pop()})` : `${TYPE} in ${ZONE}, ${DISK_GB} GB pd-standard, Ubuntu 24.04, tag ${TAG}, no service account`}`);
log(`  firewall (tag ${TAG}, live's rules): 80/443 ${web ? `${web.name}` : 'MISSING'}, SSH ${sshRule ? `${sshRule.name} from ${(sshRule.sourceRanges ?? []).join(', ')}` : 'MISSING'}`);
log(`  DNS: A ${L.host} -> the address (Cloudflare, DNS only)`);
log(`  cost: the e2-micro and its 30 GB standard disk are in Google's free tier (one per billing account); the address is about $3.65/month while in use if the free tier doesn't cover it; data out past 1 GB a month is about $0.12/GB`);
if (!web || !sshRule) log('  the firewall rules are live Net\'s (hawkes-web, hawkes-ssh-j): add them first if they are gone');
if (!APPLY) { log('nothing changed (--apply to make it)'); process.exit(0); }

if (!fs.existsSync(KEY_FILE)) {
  fs.mkdirSync(KEYS, { recursive: true });
  const r = spawnSync('ssh-keygen', ['-t', 'ed25519', '-N', '', '-C', NAME, '-f', KEY_FILE], { encoding: 'utf8', windowsHide: true });
  if (r.status !== 0) throw new Error(`ssh-keygen failed: ${r.stderr}`);
  if (process.platform === 'win32') spawnSync('icacls', [KEY_FILE, '/inheritance:r', '/grant:r', `${process.env.USERNAME}:R`], { stdio: 'ignore' });
  log(`made ${KEY_FILE}`);
}
let address = ip?.address;
if (!address) {
  must(gcloud('compute', 'addresses', 'create', IP_NAME, `--region=${REGION}`), 'address');
  address = gjson('compute', 'addresses', 'describe', IP_NAME, `--region=${REGION}`)?.address;
  log(`address ${IP_NAME}: ${address}`);
}
if (!vm) {
  // First boot script and SSH key as files (no quoting), the script with Unix line ends.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'net-beta-'));
  const init = path.join(tmp, 'cloud-init.sh');
  const keys = path.join(tmp, 'ssh-keys');
  fs.writeFileSync(init, fs.readFileSync(path.join(HERE, 'cloud-init.sh'), 'utf8').replace(/\r\n/g, '\n'));
  fs.writeFileSync(keys, `ubuntu:${fs.readFileSync(`${KEY_FILE}.pub`, 'utf8').trim()}\n`);
  try {
    must(gcloud('compute', 'instances', 'create', NAME, `--zone=${ZONE}`, `--machine-type=${TYPE}`,
      '--image-family=ubuntu-2404-lts-amd64', '--image-project=ubuntu-os-cloud', `--boot-disk-size=${DISK_GB}GB`, '--boot-disk-type=pd-standard',
      `--address=${address}`, `--tags=${TAG}`, '--labels=app=hawkes-net,lane=beta', '--no-service-account', '--no-scopes',
      '--shielded-secure-boot', `--metadata-from-file=user-data=${init},ssh-keys=${keys}`), 'VM');
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  log(`VM ${NAME} made; first boot takes a few minutes (deploy/setup.mjs waits for it)`);
}

// Cloudflare: hawkesnet.hawkesgen.ai -> the address (updated if it points elsewhere).
const have = cf('dns', 'records', 'list', '-z', DNS_ZONE);
const rows = (Array.isArray(have) ? have : have.result ?? []).filter((r) => r.name === L.host);
const same = rows.find((r) => r.type === 'A' && r.content === address);
if (same) log(`DNS: A ${L.host} -> ${address} already there`);
else {
  for (const r of rows) { cf('dns', 'records', 'delete', '-z', DNS_ZONE, r.id, '--force'); log(`DNS: removed old ${r.type} ${L.host} -> ${r.content}`); }
  cf('dns', 'records', 'create', '-z', DNS_ZONE, '--body', JSON.stringify({ type: 'A', name: L.host, content: address, ttl: 300, proxied: false }));
  log(`DNS: A ${L.host} -> ${address}`);
}

const state = { lane: 'beta', project: PROJECT, zone: ZONE, instance: NAME, ip: address, key: KEY_FILE, host: L.host, type: TYPE };
fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
log(`state ${STATE_FILE}`);
log('next: node deploy/setup.mjs --lane beta');
