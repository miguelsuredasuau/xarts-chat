# xarts-chat

Ask for a chart in plain language, get an Xarts chart built from a SQLite dataset. `claude -p` does the thinking; the Xarts library, **as released by Promote**, does the drawing. Every turn leaves a run record for Promote to triage.

```
browser ──► server/main.mjs ──► claude -p  (tools: mcp__xarts only, spend ceiling per turn)
                                  └─► mcp/xarts-tools.mjs
                                        ├─ data_schema / data_query   read-only SQLite
                                        ├─ chart_search / describe    catalogue of the installed release
                                        └─ chart_render               server runs the SQL, library renders,
                                                                       inspector reads the output back
        ◄── SSE: steps, text, chart ──┘
runs/<runId>/record.json + runs/outbox/  ──►  Promote
```

## Run it

```sh
npm ci
npm run db        # creates synthetic finance data; do not run over a database you need
# Supply an SDK tarball built from the private charts repository (see docs/HOSTING.md):
node scripts/install-release.mjs baseline --tarball /absolute/path/visx-render-VERSION.tgz --sha FULL_SOURCE_SHA
npm start         # http://127.0.0.1:4320
npm test          # unit tests; no paid agent calls
npm run coverage  # does every catalogue form render with this release? → runs/coverage.json
npm run quality   # does it read well? overlaps, clipping, truncation → runs/quality.json
npm run feedback:export   # ratings + preferences → runs/feedback-dataset/
```

For a fresh machine, private SDK access, persistent storage and remote hosting, see [Hosting handoff](docs/HOSTING.md). `npm run setup` uses a local cached tarball and is not a fresh-clone bootstrap.

Two views:
- **Chat:** ask, watch the steps, inspect the chart's Data & SQL, Spec and Record, then rate it (👍/👎 with reasons, "better than the previous version?").
- **Dataset:** browse every table with units, run read-only SQL, and **"Open in dataset console"** from any chart to re-run its exact query. The console confirms the rows match the chart's data hash.

Requires Node 22 (the start script uses the pinned 22.22.1 runtime if present) and a logged-in `claude` CLI.

| Variable | Default | |
| --- | --- | --- |
| `PROMOTE_REGISTRY` | unset | Promote's release registry. When it has an active release, that release is used ([spec](docs/RELEASE-REGISTRY.md)) |
| `XARTS_CHAT_BUDGET_USD` | `1.5` | `--max-budget-usd` for each turn |
| `XARTS_CHAT_MODEL` | claude default | `--model` for `claude -p` |
| `PORT` | `4320` | Binds to 127.0.0.1 only |

## Guarantees, and where they're enforced

- **The agent reads what it drew.** After each render, headless Chrome lays out the SVG. The agent gets back the image, every printed label, and read-back checks: overlaps (text on text and text on markers), clipping, truncation, label precision, and where the SQL's numbers came from. It must check them before answering ([checks](docs/RUN-RECORD.md#local-checks-are-not-gates)).
- **Feedback changes the next chart.** `chart_describe` returns what people approved or rejected for that form ([FEEDBACK.md](docs/FEEDBACK.md)).
- **Numbers come only from SQL the server runs.** `chart_render` rejects a spec that includes `data`. Each chart's SQL, rows and data hash are saved next to it.
- **Read-only data.** A single `SELECT`/`WITH` statement, enforced by the guard in `lib/sql.mjs` **and** by a read-only SQLite handle.
- **The right version.** An active Promote release is verified by sha256 before use. If it fails verification, the chat refuses; it never falls back quietly. The baseline is labelled as such everywhere.
- **Restricted agent.** `--tools ""`, `--strict-mcp-config`, `--allowedTools mcp__xarts`, a per-turn spend ceiling, and no project or user settings (`--setting-sources project` in an empty sandbox).
- **Honest accounting.** Cost is what `claude -p` reports, labelled as such.

## Current state (2026-09-19)

- The **baseline is `45c2b242`**, 13 commits behind `main`, because `main` can't build its package ([F1](docs/FINDINGS.md)).
- It runs with **two runtime workarounds** because the package can't run outside the monorepo ([F2](docs/FINDINGS.md)). Both are shown in the UI and recorded in every run.
- Promote implements registry publication after independent verification. No repaired release is active yet; the full package check remains blocked by the local Docker interruption.

Docs: [release registry](docs/RELEASE-REGISTRY.md) · [run record](docs/RUN-RECORD.md) · [feedback](docs/FEEDBACK.md) · [findings](docs/FINDINGS.md).
