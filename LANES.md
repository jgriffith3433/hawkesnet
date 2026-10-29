# Hawkes Net: lanes, local dev and deploys

Generated from `hawkesstudio/tools/lanes/repos.json` (`node ../hawkesstudio/tools/lanes/lanes.mjs docs`); the whole
picture for every repo is `hawkesstudio/docs/lanes.md`.

**Branches: `dev` -> `beta` -> `main`.** Work on `dev` (local). `beta` is for testing. `main` is live.
Agents' fixes land on `beta` (pull requests Studio merges); `sync.bat` brings them into `dev`.

| | Address |
|---|---|
| Local | [http://127.0.0.1:8796](http://127.0.0.1:8796) |
| Beta | [https://hawkesnet.hawkesgen.ai](https://hawkesnet.hawkesgen.ai) |
| Live | [https://net.hawkesgen.ai](https://net.hawkesgen.ai) |
| Deploys (GitHub Actions) | [github.com/jgriffith3433/hawkesnet/actions](https://github.com/jgriffith3433/hawkesnet/actions) |

**How it deploys:** Push beta: the beta Net VM pulls it. Push main: the live Net VM (hawkes-net) pulls it on its timer.

| Command (double-click, or run in a terminal here) | What it does |
|---|---|
| `dev.bat` | Switch to `dev`, bring it up to date, start the dev server (`npm run dev`), print the links |
| `deploy-beta.bat [patch\|minor\|major]` | Send `dev` to `beta` after `npm run typecheck`, tagged `vX.Y.Z-beta.N` |
| `deploy-prod.bat [patch\|minor\|major]` | Send `beta` to `main` (live), tagged `vX.Y.Z`; asks you to type DEPLOY |
| `status.bat` | What's waiting for beta and for live, the last tags |
| `links.bat [local\|beta\|prod]` | The addresses; with a lane, open them |
| `sync.bat` | Bring `beta`'s newer commits (agents' fixes) into `dev` |

Versions: live tags are `vX.Y.Z`; each beta deploy on the way is `vX.Y.Z-beta.N`. The default step is minor; pass
`patch` or `major` to choose. `deploy-prod` gives beta's commit the version its beta tag was heading to.
