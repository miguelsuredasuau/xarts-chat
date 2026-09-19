# Human feedback → Promote

People rate charts in the chat. That signal feeds three loops, fastest first. **None of them trains a model today.** "Reinforcement learning" is the long-term option. The first two loops work now.

| Loop | Latency | What it changes |
| --- | --- | --- |
| **1. House notes** | next request | `chart_describe` returns `houseNotes` for the form: approved spec patterns (title, columns, formatting, SQL), counts of dislike reasons, and recent user notes. The agent follows what people approved and avoids what they rejected. |
| **2. Evaluation and incidents** | next Promote cycle | `npm run feedback:export` writes `eval-cases.jsonl`. Every disliked chart becomes a regression case with the request, what went wrong, and the failing chart. Re-run them against a new prompt, model or **Xarts release** before shipping. Reasons like `numbers_wrong` or `units_format` on a library form become Promote incidents. |
| **3. Preference data** | later | `preferences.jsonl` holds chosen vs rejected versions of the same request, with spec, SQL, data hash, checks, release and model. That's the shape preference-tuning methods (e.g. DPO) expect, if you ever train or tune. |

## What's captured

- **Rating:** up or down on a chart. A down rating takes reasons (`numbers_wrong`, `units_format`, `wrong_form`, `hard_to_read`, `title_misleading`, `missed_request`) and a free note.
- **Preference:** when a conversation has more than one chart, "Better than the previous version?" gives `this`, `previous` or `same`.
- Every event stores a **snapshot** of what was judged, so it stays valid after the run folder is deleted and can't be attributed to the wrong chart.

Files: `runs/feedback.jsonl` (log), `runs/outbox/feedback-<id>.json` (for Promote), `runs/feedback-dataset/*.jsonl` (export).

## Honest caveats

- Feedback comes from a handful of people, so it's anecdotal until volume grows. `houseNotes` shows counts so the agent can weigh them.
- A thumbs-down doesn't say whether the library, the agent or the data was at fault. The reasons and the checks in the snapshot help Promote separate them. Triage still needs judgement.
