# Hosting handoff for Devin

Read [INTEGRATION.md](INTEGRATION.md) before changing integration behavior or shared files.

## Repositories

- Chat (public): https://github.com/miguelsuredasuau/xarts-chat
- Promote (public): https://github.com/miguelsuredasuau/promote
- Charts SDK (private; separate access required): https://github.com/miguelsuredasuau/visx-anlak

The Git repositories contain source, not the running services or their local data.

## Fresh-machine bootstrap

Use Node 22, npm, an authenticated `claude` CLI, and Chrome/Chromium. Export `CHROME_PATH` to the browser executable on Linux. Run the service as a non-root user with browser sandbox support.

```sh
git clone https://github.com/miguelsuredasuau/xarts-chat.git
cd xarts-chat
npm ci
npm test
npm run db
```

`npm run db` generates synthetic finance data. Do not use it to overwrite a database that must be retained.

Until Promote has an accepted active release, obtain a baseline SDK from the private repository. On a separate checkout, using Node 22 and the repository's pinned pnpm:

```sh
git clone https://github.com/miguelsuredasuau/visx-anlak.git xarts-sdk
cd xarts-sdk
git checkout 45c2b2429a54e2b212619a1efaf4040bbd4107a3
corepack pnpm install --frozen-lockfile
node render-cli/build-sdk.mjs --out out-sdk
```

Use the tarball filename reported by `out-sdk/build.json`. Back in the chat checkout:

```sh
node scripts/install-release.mjs baseline --tarball /absolute/path/to/xarts-sdk/out-sdk/visx-render-VERSION.tgz --sha 45c2b2429a54e2b212619a1efaf4040bbd4107a3
npm start
```

The baseline is explicitly labelled and currently needs two runtime workarounds. Do not publish the private SDK tarball into this public repository. A fresh SDK build and a hosted paid chat turn have not been verified as part of this source publication.

For an existing accepted Promote registry, set `PROMOTE_REGISTRY` to its absolute directory and run `node scripts/install-release.mjs current` instead. A bad active-release hash must fail; do not silently substitute the baseline. A repair branch is not an accepted release.

## Connectivity and persistent state

Prefer running Promote and the chat on the same host with persistent storage accessible to both. If they run on different hosts, implement authenticated transport for the artifacts below; Git push does not transfer them.

| Artifact | Local development path | Hosting configuration |
| --- | --- | --- |
| Chat checkout | `/Users/miguelsureda/Desktop/xarts-chat` | Choose the host checkout directory |
| Immutable outbox | `/Users/miguelsureda/Desktop/xarts-chat/runs/outbox` | Under `XARTS_CHAT_RUNS` |
| Progress journals | `/Users/miguelsureda/Desktop/xarts-chat/runs/<runId>/events.jsonl` | Under `XARTS_CHAT_RUNS` |
| Quality snapshot | `/Users/miguelsureda/Desktop/xarts-chat/runs/quality.json` | Under `XARTS_CHAT_RUNS` |
| Coverage snapshot | `/Users/miguelsureda/Desktop/xarts-chat/runs/coverage.json` | Under `XARTS_CHAT_RUNS` |
| SQLite | `/Users/miguelsureda/Desktop/xarts-chat/data/finance.sqlite` | `XARTS_CHAT_DB` |
| Promote registry | `/Users/miguelsureda/Desktop/promote/.local/registry` | `PROMOTE_REGISTRY` |
| Intake receipts | Promote-owned receipt directory | `PROMOTE_RECEIPTS` |

The run schema is **`xarts-chat/run-record@1`**, not `xarts-chat/run@1`. Feedback uses `xarts-chat/feedback@1`; journals use `xarts-chat/progress@1`. Preserve atomic, immutable outbox publication. Configure Promote's intake to read the same runs directory. Preserve the registry's `active.json`, release records, and package files together. The local registry currently has no accepted repaired release; the chat uses `registry/baseline.json`.

Also persist the local baseline registry/packages and allow writable `runtime/` and `.sandbox/` directories. Supply credentials securely on the host, outside Git. Promote's Devin/fal credentials belong in its ignored `.env`; they are not chat credentials. Configure and validate host-specific paths instead of copying Mac paths verbatim.

## HTTP exposure and validation

The server currently binds **127.0.0.1:4320** and accepts only local Host/Origin values. It has no application authentication. An SSH tunnel works with the existing localhost behavior. Public-domain hosting requires an authenticated ingress and deliberate proxy/origin configuration or a reviewed application change; simply publishing a port is insufficient.

Before calling a hosted deployment ready, verify `/api/state`, an authenticated real chart request, its SQL-backed data, progress journal, run outbox, feedback outbox, and Promote's receipt. Then verify a candidate passes independent checks before registry activation and that the next chat turn reports the accepted release. Paid Claude turns and Devin repair sessions have separate budgets; source deployment does not expand the existing Devin spending mandate.
