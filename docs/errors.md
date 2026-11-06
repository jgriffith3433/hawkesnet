# Hawkes Net errors

Every error the service answers with is JSON with a stable `code`, a plain `message` and a `docs` link to its entry here:

```json
{ "code": "room_invalid", "message": "room is 1 to 64 of letters, digits and / _ . -", "docs": "https://net.hawkesgen.ai/docs/errors#room_invalid", "error": "room is 1 to 64 of letters, digits and / _ . -" }
```

Match on `code`: codes never change or get reused. `message` is for people and may be reworded; it often names the thing that was wrong. `error` repeats `message` for older SDKs and pages. The HTTP status is the one in the table.
The live page is https://net.hawkesgen.ai/docs/errors; the same list is served as JSON at `/v1/net/errors`.

| Code | Status | What it means | What to do |
|---|---|---|---|
| <a id="not_found"></a>`not_found` | 404 | No such route | Check the path against the API list in the docs. |
| <a id="method_not_allowed"></a>`method_not_allowed` | 405 | Wrong HTTP method for this route | Use the method the route documents (POST for tickets, publish and room). |
| <a id="bad_json"></a>`bad_json` | 400 | The body is not valid JSON | Send a JSON object with Content-Type: application/json. |
| <a id="body_too_large"></a>`body_too_large` | 413 | The request body is over the size limit | Send less: the limit is 256 KB (16 KB for records, 2 MB for publish). |
| <a id="internal"></a>`internal` | 500 | The service failed on its own | Try again in a moment. If it keeps happening, tell us the time and the route. |
| <a id="key_required"></a>`key_required` | 401 | This route needs an API key | Send a Gen API key as Authorization: Bearer YOUR_KEY. |
| <a id="key_invalid"></a>`key_invalid` | 401 | The API key is unknown or disabled | Check the key on your Gen account; make a new one if it was disabled. |
| <a id="key_or_site_required"></a>`key_or_site_required` | 401 | No key, and the request did not come from a project site | Send an API key, or call from a page on one of the project's own sites. |
| <a id="key_project_forbidden"></a>`key_project_forbidden` | 403 | The key may not act for that project | Use a key made for this project, or ask the project's owner. |
| <a id="owner_key_required"></a>`owner_key_required` | 403 | Only an owner key may do this | This is an operator action; ordinary keys cannot do it. |
| <a id="admin_key_required"></a>`admin_key_required` | 403 | Only an owner or admin key may do this | This is an operator view; ordinary keys cannot open it. |
| <a id="node_key_forbidden"></a>`node_key_forbidden` | 403 | The key is not a Hawkes Net node key | Relay nodes report with a key that may act for the project "hawkesnet". |
| <a id="ticket_rate_limited"></a>`ticket_rate_limited` | 429 | Too many tickets or records from this address or project | Wait a minute and try again; ask for fewer tickets (reuse the SDK's join). |
| <a id="project_invalid"></a>`project_invalid` | 400 | The project id is missing or malformed | Send the project id as made on net.hawkesgen.ai: letters, digits, . _ - |
| <a id="project_not_found"></a>`project_not_found` | 404 | No such project | Make the project on net.hawkesgen.ai, or check the id. |
| <a id="room_invalid"></a>`room_invalid` | 400 | The room name is not allowed | A room is 1 to 64 of letters, digits and / _ . - |
| <a id="room_prefix_invalid"></a>`room_prefix_invalid` | 400 | The room prefix for a publish is not allowed | Use "PREFIX/*" with a valid room name as the prefix (at least 3 characters with the slash). |
| <a id="site_not_allowed"></a>`site_not_allowed` | 403 | Tickets without a key only go to the project's own sites | Add the page's site to the project in the dashboard, or send an API key. |
| <a id="role_needs_key"></a>`role_needs_key` | 403 | bot and test tickets need an API key | Ask for these roles from a server with a key, never from a page. |
| <a id="project_disabled"></a>`project_disabled` | 403 | The project has no transport it may use | Open the project in the dashboard and turn on peer-to-peer or relay. |
| <a id="sdk_too_old"></a>`sdk_too_old` | 426 | The SDK is too old for this service | Reload the page, or update @hawkesgen/net. |
| <a id="rooms_limit"></a>`rooms_limit` | 429 | The project has its most rooms open | Close idle rooms, or raise the plan's limit. |
| <a id="rooms_waiting_limit"></a>`rooms_waiting_limit` | 429 | Too many rooms are waiting for players | Let the waiting rooms fill or time out, then try again. |
| <a id="players_limit"></a>`players_limit` | 429 | The project has its most players online | Try again when players leave, or raise the plan's limit. |
| <a id="no_node"></a>`no_node` | 503 | No relay node is up | Try again in a minute; the status page shows when a node is back. |
| <a id="kick_target_required"></a>`kick_target_required` | 400 | Kick needs to know who | Send `sub` (your game's id for the player) or `peer` (p1, p2, ...). |
| <a id="counts_not_public"></a>`counts_not_public` | 403 | The project has no public counts | Public counts need at least one site on the project. |
| <a id="counts_rooms_invalid"></a>`counts_rooms_invalid` | 400 | The rooms list is not 1 to 24 valid room names | Send rooms=a,b,c with 1 to 24 valid room names. |
| <a id="node_not_taking_requests"></a>`node_not_taking_requests` | 501 | The room's node takes no publishes or requests | Nothing to do: this node cannot be reached from the hub. Try again later. |
| <a id="node_not_answering"></a>`node_not_answering` | 503 | The room's node did not answer | Try again; the room may have moved. |
| <a id="publish_refused"></a>`publish_refused` | 401 | The node refused the publish token | Tokens last 30 seconds and work once; publish again through POST /v1/net/publish. |
| <a id="account_required"></a>`account_required` | 400 | No account to act for | Send `owner`, the account the project belongs to. |
| <a id="key_no_account"></a>`key_no_account` | 403 | The key does not act for an account | Use the key the portal gives your signed-in account. |
| <a id="project_name_required"></a>`project_name_required` | 400 | The project needs a name | Send a non-empty `name`. |
| <a id="project_limit"></a>`project_limit` | 409 | The account has its most projects | Delete a project you no longer use. |
| <a id="project_id_invalid"></a>`project_id_invalid` | 400 | The new project id is not allowed | Use 3 to 40 lower-case letters, digits and -, starting with a letter. |
| <a id="project_id_taken"></a>`project_id_taken` | 409 | That project id is taken | Pick another id. |
| <a id="sites_invalid"></a>`sites_invalid` | 400 | A site is not allowed | Use https://your-game.com with no path, up to the plan's number of sites; localhost needs no entry. |
| <a id="project_unclaimed"></a>`project_unclaimed` | 409 | One of Hawkes's games nobody has taken | An admin takes it first (POST /v1/net/projects/ID/claim). |
| <a id="project_not_in_account"></a>`project_not_in_account` | 409 | The project is not in an account | Make it through POST /v1/net/projects. |
| <a id="room_size_invalid"></a>`room_size_invalid` | 400 | The room size is outside the plan | A room holds 1 up to the plan's players per room. |
| <a id="admin_required"></a>`admin_required` | 403 | Only an admin takes Hawkes's games | Ask Hawkes; this is not for customer accounts. |
| <a id="not_hawkes_game"></a>`not_hawkes_game` | 404 | That project is not one of Hawkes's games | Check the id; customer projects are made, not claimed. |
| <a id="project_in_other_account"></a>`project_in_other_account` | 409 | The project is in another account | It belongs to someone else; use your own project. |
| <a id="record_invalid"></a>`record_invalid` | 400 | The record is not a well-formed signed event | Send a signed event: id, pubkey, sig, created_at near now, kind, tags, content. |
| <a id="record_tag_invalid"></a>`record_tag_invalid` | 400 | The record's tag is missing or malformed | Tag it ["t", tag]: letters, digits and / _ . : - up to 80, and a ["d", key] up to 120. |
| <a id="record_site_not_allowed"></a>`record_site_not_allowed` | 403 | Records without a key only from the project's own sites | Write from one of the project's sites, or send an API key. |
| <a id="record_too_large"></a>`record_too_large` | 413 | The record is over the size limit | Records are at most 8 KB; store less. |
| <a id="records_daily_limit"></a>`records_daily_limit` | 429 | The project wrote its most records today | Try again tomorrow, or write fewer records. |
| <a id="node_invalid"></a>`node_invalid` | 400 | The node's id or url is not allowed | A node id is letters, digits and . _ -; its url is ws:// or wss://. |
| <a id="ws_handshake_invalid"></a>`ws_handshake_invalid` | 400 | Not a WebSocket handshake | Connect with a WebSocket client (Upgrade: websocket and a Sec-WebSocket-Key). |
| <a id="ws_ticket_required"></a>`ws_ticket_required` | 401 | The websocket needs a ticket | Ask POST /v1/net/ticket, then connect with ?t=TICKET (or ?r=RESUME_TOKEN). |
| <a id="node_draining"></a>`node_draining` | 503 | The node is draining | Ask for a new ticket; it will point at another node. |
| <a id="node_restarting"></a>`node_restarting` | 503 | The node's worker is restarting | Try again in a second. |
| <a id="connections_limit"></a>`connections_limit` | 429 | Too many websocket connections from this address | Close idle connections; one page needs one. |
| <a id="resume_gone"></a>`resume_gone` | 410 | The resume token's place in the room is gone | Join again with a new ticket. |
| <a id="ticket_refused"></a>`ticket_refused` | 401 | The node refused the ticket (bad signature or expired) | Ask for a new ticket and connect at once; they last about a minute. |
| <a id="ticket_wrong_node"></a>`ticket_wrong_node` | 409 | The ticket is for another relay node | Connect to the relayUrl the ticket came with. |
| <a id="ticket_used"></a>`ticket_used` | 401 | The ticket was already used | A ticket works once; ask for a new one to reconnect. |
| <a id="ticket_stale"></a>`ticket_stale` | 409 | The ticket is old for this room | Ask for a new ticket. |
| <a id="publish_token_bad"></a>`publish_token_bad` | 400 | The publish token is missing or malformed | Publish through POST /v1/net/publish, which signs it. |

_Made from `src/errors.ts`; `test/errors.test.ts` fails when this file differs from it (regenerate with `node tools/errors-md.mjs`)._
