# Run record: `xarts-chat/run-record@1`

Each chat turn writes one record to:
- `runs/<runId>/record.json`, next to its artifacts;
- `runs/outbox/<runId>.json`, for Promote to consume;
- one summary line in `runs/index.jsonl`.

The outcome is **derived from what the tools logged** (`runs/<runId>/tools.jsonl`), never from how the assistant describes its own work.

| Field | Meaning |
| --- | --- |
| `request.message`, `messageHash` | What the person asked |
| `dataset.sha256`, `nature` | Exact database bytes; `synthetic` for the bundled sample |
| `release` | `kind` (`promote` or `baseline`), `releaseId`, `sourceSha`, `packageHash`, `version`, and the runtime workarounds in use (`shims`) |
| `agent` | `claude -p` session id, model, the allowed tools; `usage.costUsd` **as reported by the claude -p result event** |
| `outcome` | `rendered` · `rendered_with_warnings` · `rendered_with_failures` · `render_failed` · `no_chart` · `tool_delivery_error` · `budget_exhausted` · `cancelled` · `error` · `release_unavailable` |
| `renders[]` | Per attempt: chart id, **the SQL the server executed**, row count, `dataHash`, `svgHash`, library warnings, local checks, error code |
| `queries[]` | Exploration queries (not chart data) |
| `signals[]` | Triage hints for Promote (below) |

## Signals

| `kind` | Raised when | Suggested Promote handling |
| --- | --- | --- |
| `input_error` | The library rejected the input with a 422-class code (its own `diagnosticStatus`), or xarts-chat's SQL guard rejected it | Usually none. Recurring patterns may point to a catalogue or contract problem |
| `possible_library_defect` | A render failed with a 500-class code (including uncoded errors), or a local check failed on a successful render | Reproduce from `renders[].sql` plus the spec file, then open an incident |
| `tool_delivery_error` | The server logged a tool success but Claude received it as an error (e.g. a malformed MCP result), so the agent answered without seeing its result | Bug in xarts-chat, not Xarts |
| `packaging_workaround` | The release needed runtime workarounds | Incident on packaging; resolved when a release needs no workarounds |

`recovered: true` means the agent got past the failure later in the same turn. It is still a signal: the library made a caller try again.

## Local checks are not gates

`renders[].checks` are observations made by xarts-chat. They do **not** replace Promote's protected gates (A03 meaning, A04 artifact).

| Check | How | Fails / warns when |
| --- | --- | --- |
| `svg-root`, `finite-geometry` | SVG text | Not one standalone `<svg>`; NaN/Infinity in geometry |
| `item-range` | catalogue | Row count outside the form's range |
| `library-warnings` | library | The library reported warnings |
| `text-overlap` | headless Chrome layout | Two text boxes overlap by ≥ 20% of the smaller one |
| `text-clipped` | headless Chrome layout | Text outside the canvas (fail) |
| `labels-truncated` | printed text | Labels shortened with an ellipsis |
| `label-precision` | printed text, parsed per locale | Numeric labels with 3+ decimals, which can be misread by a factor of 1,000 across locales |
| `sql-provenance` | SQL text | No dataset table (fail) or numeric literals in the SELECT list (warn) |

The inspector also returns the **rendered PNG and every printed label to the agent**, which must check them before answering. The PNG is saved as `runs/<runId>/chart-N.png`.

## Reproducing a render

```sh
# spec without data, the SQL, and the rows the SQL returned at the time:
runs/<runId>/chart-N.spec.json
runs/<runId>/chart-N.data.json   # { sql, rowCount, dataHash, rows }
```

Re-run the SQL against a database with the same `dataset.sha256`, check the `dataHash`, add the rows as `data` and render with the package named by `release.packageHash`.
