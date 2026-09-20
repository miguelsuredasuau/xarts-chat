# xarts-chat ↔ Promote: who owns what

Two agents work in this repo: **Claude** (the chat) and **Codex** (the connection to Promote). This page fixes the boundaries so neither overwrites the other. Change a contract below only in this file, with a version bump, and say so in the commit message.

## Ownership

| Area | Owner | Files |
| --- | --- | --- |
| Chat UI, dataset view, feedback UI | Claude | `web/*` |
| Agent tools, prompt, inspector | Claude | `mcp/xarts-tools.mjs`, `server/prompt.mjs`, `server/claude.mjs`, `lib/inspect.mjs`, `lib/sql.mjs` |
| Release resolution (reading Promote's registry) | Claude | `lib/release.mjs`, `scripts/install-release.mjs` |
| Coverage and quality sweeps | Claude | `scripts/coverage.mjs`, `scripts/quality-sweep.mjs` |
| Progress journal, durable writes | Codex | `lib/journal.mjs` |
| Promote intake of chat records | Codex | in the Promote repo |
| Shared, edit with care | both | `server/main.mjs`, `server/record.mjs`, `lib/feedback.mjs`, `tests/unit.test.mjs` |

For shared files: small, local edits; run `npm test` before and after; don't reformat or move code you didn't write.

## Contracts (v1.1 — additive handoff revision, 2026-09-19)

**Chat → Promote** (Promote reads; the chat never waits on it):

| What | Where | Schema |
| --- | --- | --- |
| One record per chat turn | `runs/outbox/<runId>.json` (+ `runs/<runId>/record.json`) | `xarts-chat/run-record@1`, see [RUN-RECORD.md](RUN-RECORD.md) |
| One file per feedback event | `runs/outbox/feedback-<id>.json` (+ `runs/feedback.jsonl`) | `xarts-chat/feedback@1`, see [FEEDBACK.md](FEEDBACK.md) |
| Streamed progress of a turn | `runs/<runId>/events.jsonl`, `GET /api/progress/<runId>` | `xarts-chat/progress@1` (Codex) |
| Library quality map | `runs/coverage.json`, `runs/quality.json`, `runs/quality-shots/` | produced by `npm run coverage` / `npm run quality` |

Outbox files are written atomically and never rewritten. Promote should treat them as immutable and track what it has consumed on its side. It must never delete them from the chat's `runs/`.

**Promote → chat:**

| What | Where | Schema |
| --- | --- | --- |
| Active Xarts release | `$PROMOTE_REGISTRY/active.json`, `releases/<id>.json`, `packages/<sha256>.tgz` | [RELEASE-REGISTRY.md](RELEASE-REGISTRY.md) |

## Guarantees the chat keeps (don't break them)

- A chart's numbers come only from SQL the server runs. `chart_render` rejects `spec.data`.
- An active Promote release that fails hash verification is **refused**; the chat never falls back silently to the baseline.
- The outcome in a run record comes from tool logs, not from the assistant's text.
- Cost is only what `claude -p` reports, labelled as such.

## Suggested first incidents for Promote

From [FINDINGS.md](FINDINGS.md), in order of how cleanly they can be verified:

1. **F1: `main` can't build its SDK.** Verify: `build-sdk` succeeds on the candidate commit.
2. **F2: the package can't run outside the monorepo.** Verify: `render-cli/sdk/check-consumer.mjs <tarball>` passes. Visible payoff in the chat: the release pill shows **0 workarounds** and `release.shims` is `[]` in new run records.
3. **F5: `numberFormat` + waterfall sign placement.** A bounded growth case: the contract already reserves the field.
4. **F6: 27 forms clip their own text.** `npm run quality` is the before/after measure.

## Checks before handing over

```sh
npm test                    # 18 unit tests, no network
node tests/ui-flow.mjs      # real browser + 2 claude -p turns (costs ~$0.50)
```


## v1.1 integration additions (Codex, 2026-09-19)

Existing `@1` records remain readable; these additions do not reinterpret old observations as gate evidence. Include `integration v1.1` in the eventual commit message; no commit is made by this document.

- Progress entries carry `schema`, unique `eventId`, `at`, `runId`, event type `t` and the visible event fields. The submitted request is logged before streaming begins. Assistant-visible text, tool activity, errors and completion are retained. Hidden model reasoning is not captured. A truncated final line after a crash is ignored; previous complete entries survive. Old runs cannot acquire an invented historical stream.
- Optional run field `agent.completion` is `confirmed`, `missing` or `cancelled`. `outcome` still describes tool-observed artifact behavior. A rendered artifact alone does not confirm completion of the Claude turn. Legacy records without the field have unknown completion.
- Outbox publication is create-only and atomic. Repeating identical bytes is harmless; attempting to replace an existing event with different content fails. Neither receiver nor producer silently rewrites evidence.
- Promoted writes delivery receipts on its side. The chat optionally reads them using `PROMOTE_RECEIPTS` or ignored `.local/integration.json` (`promoteReceipts`). `GET /api/promote-receipts/<source-file>.json` returns `not_connected`, `pending`, `received`, `quarantined` or `unavailable`. `received` with `awaiting_triage` means persisted observation, not an approved repair or release.
- The registry wire schema is `lib/registry-wire.mjs`, vendored from Promoted's `contracts/registry-wire.mjs`. It validates the full existing v1 release record and optional package metadata; package hashes are still checked separately. Core Release and the consumer envelope remain distinct. Future changes to this copy belong to Claude and must stay compatible with the producer.
- Promoted archives quality/coverage reports as `xarts-chat/quality-snapshot@1` receiver envelopes containing the source kind, content digest and original observations. These source files are replaceable sweep summaries, unlike immutable outbox events. Their results remain diagnostic hints, not protected gates.

Ownership handback: before this ownership agreement was supplied, Codex added receipt display to `web/app.js`, strict registry validation to `lib/release.mjs`, and process launch/cancellation handling to `server/claude.mjs`. Those changes remain for Claude to maintain; subsequent Codex work follows the ownership table above.

Current backend status (2026-09-19): outbox import, local receipts and real Devin dispatch are implemented. One F1 session returned a candidate and has stopped. Promote now schedules independent SDK build, protected standalone consumer checks and replay of a saved SQL-backed request before guarded registry activation. The F2 candidate has passed nine compiler tests; Docker interruption prevented the complete package check, so no repaired release is active yet. These are implementation changes, not a wire-contract revision.

Chat startup handoff: Promote provides `scripts/start-chat.mjs <chat-root>` to set `PROMOTE_REGISTRY` to its `.local/registry` without changing Claude-owned release resolution. The local chat has been connected to that registry; it continues using the labelled baseline until a release passes every required gate. The scheduler can watch a configured repair branch, freezes each fetched SHA and verifies it before activation. No additional Devin session or spending allowance is implied by verification.

## v1.2 exact release replay (2026-09-20)

Promote can replay a saved chart through the real chat MCP `chart_render` tool after publishing an accepted package. It reuses the original spec and SQL; the MCP server executes the SQL, and Promote requires the original data hash. It does not provide `spec.data` or call Claude.

The existing `xarts-chat/run-record@1` wire schema remains backward-compatible. Optional `replay` metadata records `sourceRunId`, `sourceArtifact`, `initiatedBy: promote_controller`, `dataHash` and `releaseId`. The runner is explicitly `promote-exact-replay`, with `model: null` and `usage: null`; no Claude cost is invented. Records, progress and outbox use the existing durable writers. These observations establish chat consumption, not a substitute for Promote's independent release gates.

The chat supports read-only links `/?run=<savedRunId>` for recording and inspection. Opening one shows saved artifacts without calling an agent. The active-release pill always describes the package for the next request; saved-run tags identify the historical package of the selected record.
