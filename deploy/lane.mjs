// The two Hawkes Net boxes, one per lane (J, 2026-10-29: dev -> beta -> main, and beta never touches live). Each has its
// own address, branch, Gen (which checks API keys for it: GET /v1/net/whoami), Gen key, data and SSH key. Used by
// deploy/setup.mjs (what to write on a box), deploy/pull.mjs (which branch the box follows) and
// deploy/provision-gce.mjs (the beta VM). No dependencies.
export const LANES = {
  live: {
    host: 'net.hawkesgen.ai', branch: 'main', gen: 'https://gen.hawkesgen.ai', ownerKey: 'genKey',
    nodeId: 'net-1', stateFile: 'net.json', keyName: 'hawkes-net box',
  },
  beta: {
    host: 'hawkesnet.hawkesgen.ai', branch: 'beta', gen: 'https://gen-beta.hawkesgen.ai', ownerKey: 'genBetaKey',
    nodeId: 'net-beta-1', stateFile: 'net-beta.json', keyName: 'hawkes-net beta box',
    // An e2-micro (1 GB): one relay worker keeps the box well inside its memory; beta's players are playtests.
    workers: 1, capacity: 500,
  },
};

export function lane(name) {
  const l = LANES[name];
  if (!l) throw new Error(`--lane live | beta (got ${name})`);
  return { name, ...l };
}

/** The branch a box follows, from its /etc/hawkes/net.env (only `beta` or `main`; anything else means live's `main`). */
export function laneBranch(envText) {
  const b = /^NET_DEPLOY_BRANCH=\s*([A-Za-z0-9._-]+)\s*$/m.exec(envText ?? '')?.[1];
  return b === 'beta' ? 'beta' : 'main';
}

/** /etc/hawkes/net.env for a box of this lane. The key is a Gen key for the project "hawkesnet" made on the lane's Gen. */
export function envFor(l, genKey, vcpu) {
  const workers = l.workers ?? vcpu;
  return [
    `# Hawkes Net box settings, lane ${l.name} (hawkesnet deploy/setup.mjs). The key is a Gen key for the project "hawkesnet" on ${l.gen}.`,
    'NET_PORT=8800', 'NET_HOST=127.0.0.1', 'NET_DATA_DIR=/srv/hawkes/net-data',
    `NET_GEN_URL=${l.gen}`, `NET_GEN_KEY=${genKey}`,
    `NET_PUBLIC_URL=wss://${l.host}/v1/net/ws`, `NET_WORKERS=${workers}`, `NET_CAPACITY=${l.capacity ?? workers * 2000}`, `NET_NODE_ID=${l.nodeId}`,
    `NET_DEPLOY_BRANCH=${l.branch}`,
    'NODE_ENV=production', '',
  ].join('\n');
}

/** deploy/Caddyfile (written for net.hawkesgen.ai) for this lane's address. */
export function caddyfileFor(text, l) {
  if (!/^net\.hawkesgen\.ai \{$/m.test(text)) throw new Error('deploy/Caddyfile has no "net.hawkesgen.ai {" site block');
  return text.replace(/^net\.hawkesgen\.ai \{$/m, `${l.host} {`);
}

/** What is wrong with a box's existing settings for this lane (a beta box on live Gen, or the other way), or null. */
export function envProblem(envText, l) {
  const gen = /^NET_GEN_URL=(.*)$/m.exec(envText ?? '')?.[1]?.trim() || 'https://gen.hawkesgen.ai';
  if (gen.replace(/\/+$/, '') !== l.gen) return `NET_GEN_URL is ${gen}, lane ${l.name} uses ${l.gen}`;
  if (laneBranch(envText) !== l.branch) return `the box follows ${laneBranch(envText)}, lane ${l.name} follows ${l.branch}`;
  return null;
}
