// Every error the service answers with (docs/errors.md, served at /docs/errors): a stable `code`, a plain `message` and a
// `docs` link to that code's entry. The catalog is the one list: the docs page, docs/errors.md and the tests read it.
// A body is { code, message, docs, error }; `error` repeats `message` for the older SDKs and pages that read it.
// Add a code here (never reuse or rename one: games match on them), then a case in test/errors.test.ts.
export type ErrorEntry = { status: number; title: string; fix: string };

export const ERRORS = {
  // ---- any request
  not_found: { status: 404, title: 'No such route', fix: 'Check the path against the API list in the docs.' },
  method_not_allowed: { status: 405, title: 'Wrong HTTP method for this route', fix: 'Use the method the route documents (POST for tickets, publish and room).' },
  bad_json: { status: 400, title: 'The body is not valid JSON', fix: 'Send a JSON object with Content-Type: application/json.' },
  body_too_large: { status: 413, title: 'The request body is over the size limit', fix: 'Send less: the limit is 256 KB (16 KB for records, 2 MB for publish).' },
  internal: { status: 500, title: 'The service failed on its own', fix: 'Try again in a moment. If it keeps happening, tell us the time and the route.' },
  // ---- keys
  key_required: { status: 401, title: 'This route needs an API key', fix: 'Send a Gen API key as Authorization: Bearer YOUR_KEY.' },
  key_invalid: { status: 401, title: 'The API key is unknown or disabled', fix: 'Check the key on your Gen account; make a new one if it was disabled.' },
  key_or_site_required: { status: 401, title: 'No key, and the request did not come from a project site', fix: 'Send an API key, or call from a page on one of the project\'s own sites.' },
  key_project_forbidden: { status: 403, title: 'The key may not act for that project', fix: 'Use a key made for this project, or ask the project\'s owner.' },
  owner_key_required: { status: 403, title: 'Only an owner key may do this', fix: 'This is an operator action; ordinary keys cannot do it.' },
  admin_key_required: { status: 403, title: 'Only an owner or admin key may do this', fix: 'This is an operator view; ordinary keys cannot open it.' },
  node_key_forbidden: { status: 403, title: 'The key is not a Hawkes Net node key', fix: 'Relay nodes report with a key that may act for the project "hawkesnet".' },
  // ---- tickets
  ticket_rate_limited: { status: 429, title: 'Too many tickets or records from this address or project', fix: 'Wait a minute and try again; ask for fewer tickets (reuse the SDK\'s join).' },
  project_invalid: { status: 400, title: 'The project id is missing or malformed', fix: 'Send the project id as made on net.hawkesgen.ai: letters, digits, . _ -' },
  project_not_found: { status: 404, title: 'No such project', fix: 'Make the project on net.hawkesgen.ai, or check the id.' },
  room_invalid: { status: 400, title: 'The room name is not allowed', fix: 'A room is 1 to 64 of letters, digits and / _ . -' },
  room_prefix_invalid: { status: 400, title: 'The room prefix for a publish is not allowed', fix: 'Use "PREFIX/*" with a valid room name as the prefix (at least 3 characters with the slash).' },
  site_not_allowed: { status: 403, title: 'Tickets without a key only go to the project\'s own sites', fix: 'Add the page\'s site to the project in the dashboard, or send an API key.' },
  role_needs_key: { status: 403, title: 'bot and test tickets need an API key', fix: 'Ask for these roles from a server with a key, never from a page.' },
  project_disabled: { status: 403, title: 'The project has no transport it may use', fix: 'Open the project in the dashboard and turn on peer-to-peer or relay.' },
  sdk_too_old: { status: 426, title: 'The SDK is too old for this service', fix: 'Reload the page, or update @hawkesgen/net.' },
  rooms_limit: { status: 429, title: 'The project has its most rooms open', fix: 'Close idle rooms, or raise the plan\'s limit.' },
  rooms_waiting_limit: { status: 429, title: 'Too many rooms are waiting for players', fix: 'Let the waiting rooms fill or time out, then try again.' },
  players_limit: { status: 429, title: 'The project has its most players online', fix: 'Try again when players leave, or raise the plan\'s limit.' },
  no_node: { status: 503, title: 'No relay node is up', fix: 'Try again in a minute; the status page shows when a node is back.' },
  // ---- publish, rooms, counts
  kick_target_required: { status: 400, title: 'Kick needs to know who', fix: 'Send `sub` (your game\'s id for the player) or `peer` (p1, p2, ...).' },
  counts_not_public: { status: 403, title: 'The project has no public counts', fix: 'Public counts need at least one site on the project.' },
  counts_rooms_invalid: { status: 400, title: 'The rooms list is not 1 to 24 valid room names', fix: 'Send rooms=a,b,c with 1 to 24 valid room names.' },
  node_not_taking_requests: { status: 501, title: 'The room\'s node takes no publishes or requests', fix: 'Nothing to do: this node cannot be reached from the hub. Try again later.' },
  node_not_answering: { status: 503, title: 'The room\'s node did not answer', fix: 'Try again; the room may have moved.' },
  publish_refused: { status: 401, title: 'The node refused the publish token', fix: 'Tokens last 30 seconds and work once; publish again through POST /v1/net/publish.' },
  // ---- projects and accounts
  account_required: { status: 400, title: 'No account to act for', fix: 'Send `owner`, the account the project belongs to.' },
  key_no_account: { status: 403, title: 'The key does not act for an account', fix: 'Use the key the portal gives your signed-in account.' },
  project_name_required: { status: 400, title: 'The project needs a name', fix: 'Send a non-empty `name`.' },
  project_limit: { status: 409, title: 'The account has its most projects', fix: 'Delete a project you no longer use.' },
  project_id_invalid: { status: 400, title: 'The new project id is not allowed', fix: 'Use 3 to 40 lower-case letters, digits and -, starting with a letter.' },
  project_id_taken: { status: 409, title: 'That project id is taken', fix: 'Pick another id.' },
  sites_invalid: { status: 400, title: 'A site is not allowed', fix: 'Use https://your-game.com with no path, up to the plan\'s number of sites; localhost needs no entry.' },
  project_unclaimed: { status: 409, title: 'One of Hawkes\'s games nobody has taken', fix: 'An admin takes it first (POST /v1/net/projects/ID/claim).' },
  project_not_in_account: { status: 409, title: 'The project is not in an account', fix: 'Make it through POST /v1/net/projects.' },
  room_size_invalid: { status: 400, title: 'The room size is outside the plan', fix: 'A room holds 1 up to the plan\'s players per room.' },
  admin_required: { status: 403, title: 'Only an admin takes Hawkes\'s games', fix: 'Ask Hawkes; this is not for customer accounts.' },
  not_hawkes_game: { status: 404, title: 'That project is not one of Hawkes\'s games', fix: 'Check the id; customer projects are made, not claimed.' },
  project_in_other_account: { status: 409, title: 'The project is in another account', fix: 'It belongs to someone else; use your own project.' },
  // ---- records
  record_invalid: { status: 400, title: 'The record is not a well-formed signed event', fix: 'Send a signed event: id, pubkey, sig, created_at near now, kind, tags, content.' },
  record_tag_invalid: { status: 400, title: 'The record\'s tag is missing or malformed', fix: 'Tag it ["t", tag]: letters, digits and / _ . : - up to 80, and a ["d", key] up to 120.' },
  record_site_not_allowed: { status: 403, title: 'Records without a key only from the project\'s own sites', fix: 'Write from one of the project\'s sites, or send an API key.' },
  record_too_large: { status: 413, title: 'The record is over the size limit', fix: 'Records are at most 8 KB; store less.' },
  records_daily_limit: { status: 429, title: 'The project wrote its most records today', fix: 'Try again tomorrow, or write fewer records.' },
  // ---- nodes
  node_invalid: { status: 400, title: 'The node\'s id or url is not allowed', fix: 'A node id is letters, digits and . _ -; its url is ws:// or wss://.' },
  // ---- the relay's websocket and node HTTP (answered as HTTP before the socket opens)
  ws_handshake_invalid: { status: 400, title: 'Not a WebSocket handshake', fix: 'Connect with a WebSocket client (Upgrade: websocket and a Sec-WebSocket-Key).' },
  ws_ticket_required: { status: 401, title: 'The websocket needs a ticket', fix: 'Ask POST /v1/net/ticket, then connect with ?t=TICKET (or ?r=RESUME_TOKEN).' },
  node_draining: { status: 503, title: 'The node is draining', fix: 'Ask for a new ticket; it will point at another node.' },
  node_restarting: { status: 503, title: 'The node\'s worker is restarting', fix: 'Try again in a second.' },
  connections_limit: { status: 429, title: 'Too many websocket connections from this address', fix: 'Close idle connections; one page needs one.' },
  resume_gone: { status: 410, title: 'The resume token\'s place in the room is gone', fix: 'Join again with a new ticket.' },
  ticket_refused: { status: 401, title: 'The node refused the ticket (bad signature or expired)', fix: 'Ask for a new ticket and connect at once; they last about a minute.' },
  ticket_wrong_node: { status: 409, title: 'The ticket is for another relay node', fix: 'Connect to the relayUrl the ticket came with.' },
  ticket_used: { status: 401, title: 'The ticket was already used', fix: 'A ticket works once; ask for a new one to reconnect.' },
  ticket_stale: { status: 409, title: 'The ticket is old for this room', fix: 'Ask for a new ticket.' },
  publish_token_bad: { status: 400, title: 'The publish token is missing or malformed', fix: 'Publish through POST /v1/net/publish, which signs it.' },
} as const satisfies Record<string, ErrorEntry>;

export type ErrorCode = keyof typeof ERRORS;
export const ERROR_CODES = Object.keys(ERRORS) as ErrorCode[];

/** Where an error's docs entry lives (NET_DOCS_BASE overrides the live address, e.g. on beta). */
export const docsBase = () => (process.env.NET_DOCS_BASE || 'https://net.hawkesgen.ai').replace(/\/+$/, '');
export const docsLink = (code: string) => `${docsBase()}/docs/errors#${code}`;

/** The JSON body of an error: code, message, docs (and `error`, the same text, for older SDKs). */
export function errorBody(code: ErrorCode, message?: string) {
  const m = message || ERRORS[code].title;
  return { code, message: m, docs: docsLink(code), error: m };
}
export const errorStatus = (code: ErrorCode) => ERRORS[code].status;

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

/** docs/errors.md, made from the catalog (a test keeps the file the same). */
export function errorsMarkdown() {
  const rows = ERROR_CODES.map((c) => `| <a id="${c}"></a>\`${c}\` | ${ERRORS[c].status} | ${ERRORS[c].title} | ${ERRORS[c].fix} |`);
  return [
    '# Hawkes Net errors',
    '',
    'Every error the service answers with is JSON with a stable `code`, a plain `message` and a `docs` link to its entry here:',
    '',
    '```json',
    '{ "code": "room_invalid", "message": "room is 1 to 64 of letters, digits and / _ . -", "docs": "https://net.hawkesgen.ai/docs/errors#room_invalid", "error": "room is 1 to 64 of letters, digits and / _ . -" }',
    '```',
    '',
    'Match on `code`: codes never change or get reused. `message` is for people and may be reworded; it often names the thing that was wrong. `error` repeats `message` for older SDKs and pages. The HTTP status is the one in the table.',
    'The live page is https://net.hawkesgen.ai/docs/errors; the same list is served as JSON at `/v1/net/errors`.',
    '',
    '| Code | Status | What it means | What to do |',
    '|---|---|---|---|',
    ...rows,
    '',
    '_Made from `src/errors.ts`; `test/errors.test.ts` fails when this file differs from it (regenerate with `node tools/errors-md.mjs`)._',
    '',
  ].join('\n');
}

/** The public docs page at /docs/errors. */
export function errorsHtml() {
  const rows = ERROR_CODES.map((c) => `<tr id="${c}"><td><a href="#${c}"><code>${c}</code></a></td><td>${ERRORS[c].status}</td><td>${esc(ERRORS[c].title)}</td><td>${esc(ERRORS[c].fix)}</td></tr>`).join('\n');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Hawkes Net errors</title>
<style>body{font:15px/1.5 system-ui,sans-serif;max-width:60rem;margin:2rem auto;padding:0 1rem;background:#0f1115;color:#e6e8ee}a{color:#7cc4ff}code,pre{background:#1a1d24;padding:.1em .35em;border-radius:4px}pre{padding:.8em;overflow:auto}table{border-collapse:collapse;width:100%}td,th{border-bottom:1px solid #2a2f3a;padding:.45em .6em;text-align:left;vertical-align:top}tr:target{background:#1d2a3a}</style></head><body>
<h1>Hawkes Net errors</h1>
<p>Every error the service answers with has a stable <code>code</code>, a plain <code>message</code> and a <code>docs</code> link to its row below.</p>
<pre>{ "code": "room_invalid", "message": "room is 1 to 64 of letters, digits and / _ . -", "docs": "${docsBase()}/docs/errors#room_invalid", "error": "..." }</pre>
<p>Match on <code>code</code>: codes never change. <code>message</code> is for people. <code>error</code> repeats <code>message</code> for older SDKs. The same list as JSON: <a href="/v1/net/errors">/v1/net/errors</a>.</p>
<table><thead><tr><th>Code</th><th>Status</th><th>What it means</th><th>What to do</th></tr></thead><tbody>
${rows}
</tbody></table></body></html>`;
}
