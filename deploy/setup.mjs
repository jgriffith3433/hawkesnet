// Sets up (or repairs) the Hawkes Net box over SSH, from J's PC. Idempotent; secrets travel on stdin, never in arguments.
// The box itself is made by hawkesstudio/deploy/provision-net.mjs (state in hawkesstudio/deploy/.keys/net.json).
//
//   node deploy/setup.mjs                 the box from that state file, Gen's key for it made if missing
//   node deploy/setup.mjs --host <ip> --key <ssh key>
//
// What it does: the GitHub token for pulls (from this PC's git credentials, as the other boxes have), the hawkesgen
// checkout in /srv/hawkes/hawkesnet (Hawkes Net needs no npm packages), /etc/hawkes/net.env with a Gen key for the
// project "hawkesnet" (made through Gen's API with this PC's owner key the first time), the units (hawkes-net, its pull
// timer) and Caddy. After this the box deploys itself from main (deploy/pull.mjs).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const arg = (k) => { const i = process.argv.indexOf(`--${k}`); return i >= 0 ? process.argv[i + 1] : undefined; };
const stateFile = path.resolve(HERE, '..', '..', 'hawkesstudio', 'deploy', '.keys', 'net.json');
const st = fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, 'utf8')) : {};
const host = arg('host') ?? st.ip;
const key = arg('key') ?? st.key;
if (!host || !key) throw new Error('usage: node deploy/setup.mjs [--host <ip> --key <ssh key>] (or make the box with hawkesstudio/deploy/provision-net.mjs)');
const DIR = '/srv/hawkes/hawkesnet';
const BRANCH = arg('branch') ?? 'main'; // a branch only to try a change before it is on main (the box then follows main)
const step = (s) => console.log(`[net-setup] ${s}`);

function ssh(command, input) {
  const r = spawnSync('ssh', ['-i', key, '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=accept-new', '-o', 'ConnectTimeout=15', `ubuntu@${host}`, command], { input, encoding: 'utf8', windowsHide: true });
  if (r.status !== 0) throw new Error(`ssh failed (${r.status}): ${(r.stderr || r.stdout).trim().split('\n').slice(-3).join(' | ')}`);
  return r.stdout.trim();
}
const put = (file, dest, mode, owner = 'root:root') => ssh(`sudo install -m ${mode} -o ${owner.split(':')[0]} -g ${owner.split(':')[1]} /dev/stdin ${dest}`, fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n'));

step('waiting for first boot (cloud-init)');
for (let i = 0; ; i++) {
  let ready = false;
  try { ready = ssh('test -f /var/lib/hawkes/ready && echo yes || echo no') === 'yes'; } catch { /* not answering yet */ }
  if (ready) break;
  if (i > 60) throw new Error('first boot did not finish in 15 minutes: see /var/log/hawkes-init.log on the box');
  await new Promise((r) => setTimeout(r, 15_000));
}

step('GitHub token for pulls (/etc/hawkes/github.env)');
if (ssh('sudo test -s /etc/hawkes/github.env && echo yes || echo no') !== 'yes') {
  const creds = fs.readFileSync(path.join(os.homedir(), '.git-credentials'), 'utf8');
  const token = /https:\/\/[^:\s]+:([^@\s]+)@github\.com/.exec(creds)?.[1];
  if (!token) throw new Error('no GitHub token in ~/.git-credentials');
  ssh('sudo install -d -m 755 /etc/hawkes && sudo install -m 640 -o root -g hawkes /dev/stdin /etc/hawkes/github.env', `GITHUB_TOKEN=${decodeURIComponent(token)}\n`);
}
ssh(`sudo install -m 755 /dev/stdin /usr/local/bin/git-credential-hawkes-net`, '#!/bin/sh\n[ "$1" = get ] || exit 0\necho username=x-access-token\necho "password=$(sed -n \'s/^GITHUB_TOKEN=//p\' /etc/hawkes/github.env)"\n');
ssh(`sudo -u hawkes -H git config --global credential.https://github.com.helper /usr/local/bin/git-credential-hawkes-net && sudo -u hawkes -H git config --global pull.ff only`);

step('code');
console.log(ssh(`sudo install -d -o hawkes -g hawkes /srv/hawkes && if [ -d ${DIR}/.git ]; then sudo -u hawkes -H git -C ${DIR} fetch -q origin ${BRANCH} && sudo -u hawkes -H git -C ${DIR} checkout -q --detach origin/${BRANCH}; else sudo -u hawkes -H git clone -q --branch ${BRANCH} https://github.com/jgriffith3433/hawkesnet.git ${DIR}; fi && sudo install -d -m 700 -o hawkes -g hawkes /srv/hawkes/net-data && sudo -u hawkes -H git -C ${DIR} log -1 --format='%h %s'`));

step('settings (/etc/hawkes/net.env)');
if (ssh('sudo test -s /etc/hawkes/net.env && echo yes || echo no') !== 'yes') {
  // A Gen key for the project "hawkesnet": the box sends usage with it. Made with this PC's Gen owner key.
  const c = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.hawkes', 'client.json'), 'utf8'));
  const gen = String(c.genUrl).trim().replace(/\/+$/, '');
  const r = await fetch(`${gen}/v1/clients`, { method: 'POST', headers: { Authorization: `Bearer ${String(c.genKey).trim()}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ name: `hawkes-net box (${st.instanceId ?? host})`, role: 'user', projects: ['hawkesnet'] }) });
  if (!r.ok) throw new Error(`Gen would not make the box's key: ${r.status} ${(await r.text()).slice(0, 200)}`);
  const made = await r.json();
  const vcpu = Number(ssh('nproc')) || 2;
  const envText = [
    '# Hawkes Net box settings (hawkesnet deploy/setup.mjs). The key is a Gen key for the project "hawkesnet".',
    'NET_PORT=8800', 'NET_HOST=127.0.0.1', 'NET_DATA_DIR=/srv/hawkes/net-data',
    'NET_GEN_URL=https://gen.hawkesgen.com', `NET_GEN_KEY=${made.key}`,
    'NET_PUBLIC_URL=wss://net.hawkesgen.com/v1/net/ws', `NET_WORKERS=${vcpu}`, `NET_CAPACITY=${vcpu * 2000}`, `NET_NODE_ID=net-1`,
    'NODE_ENV=production', '',
  ].join('\n');
  ssh('sudo install -m 640 -o root -g hawkes /dev/stdin /etc/hawkes/net.env', envText);
  step(`made Gen key ${made.client?.id ?? ''} for the box (kept only on the box)`);
}

step('services');
put(path.join(HERE, 'hawkes-net.service'), '/etc/systemd/system/hawkes-net.service', 644);
put(path.join(HERE, 'hawkes-net-pull.service'), '/etc/systemd/system/hawkes-net-pull.service', 644);
put(path.join(HERE, 'hawkes-net-pull.timer'), '/etc/systemd/system/hawkes-net-pull.timer', 644);
ssh('sudo systemctl daemon-reload && sudo systemctl enable -q hawkes-net hawkes-net-pull.timer && sudo systemctl restart hawkes-net && sudo systemctl start hawkes-net-pull.timer');
console.log(ssh('for i in $(seq 1 20); do curl -s -m 3 http://127.0.0.1:8800/healthz && exit 0; sleep 1; done; sudo journalctl -u hawkes-net -n 30 --no-pager; exit 1'));

step('Caddy');
put(path.join(HERE, 'Caddyfile'), '/tmp/Caddyfile.net', 644);
ssh('sudo install -d -o caddy -g caddy /var/log/caddy && sudo -u caddy caddy validate --config /tmp/Caddyfile.net --adapter caddyfile >/dev/null 2>&1 && sudo install -m 644 /tmp/Caddyfile.net /etc/caddy/Caddyfile && sudo rm /tmp/Caddyfile.net && sudo systemctl daemon-reload && sudo systemctl reload-or-restart caddy && systemctl is-active caddy');
step('done: https://net.hawkesgen.com/healthz');
