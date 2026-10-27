// A Hawkes Net service on this PC, for trying it in a browser: http://127.0.0.1:<port>/demo is the demo (open it in two tabs).
// Its own scratch data folder; pages on localhost may use the public ticket door; keys are checked with the Gen on this PC
// (HAWKESGEN_URL, default http://127.0.0.1:8790) and usage goes there when NET_GEN_KEY is set.
//   node tools/net-dev.mjs [port]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const port = Number(process.argv[2] || process.env.PORT || 8796);
process.env.NET_DATA_DIR ??= fs.mkdtempSync(path.join(os.tmpdir(), 'hn-dev-'));
process.env.NET_WORKERS ??= '1';
process.env.NET_TRUST_LOCALHOST ??= '1';
const { startHub } = await import('../src/hub.ts');
const hub = await startHub({ port, host: '127.0.0.1', genUrl: process.env.HAWKESGEN_URL ?? 'http://127.0.0.1:8790', genKey: process.env.NET_GEN_KEY });
console.log(`Hawkes Net (dev) on ${hub.url}/demo  (data: ${process.env.NET_DATA_DIR})`);
process.on('SIGINT', () => void hub.stop().then(() => process.exit(0)));
