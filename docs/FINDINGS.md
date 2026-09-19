# Findings: real Xarts defects found while building xarts-chat

Found on 2026-09-19 against `miguelsuredasuau/visx-anlak`. These are observed, not seeded. Each item gives evidence and how to reproduce it, so it can be handed to Promote as an incident.

## F1: `main` cannot build its SDK package

- **Symptom:** `node render-cli/build-sdk.mjs --out out-x` fails on `main@e3ebca5e` with `TS2339: Property 'pasos' does not exist on type 'EscuchaDeclarada'` (`core/interaccion/eventoDeclarado.ts:385`). `pnpm typecheck` passes on the same commit.
- **Cause:** `pasos` (and `escritura`, one commit earlier) are added to `EscuchaDeclarada` by module augmentation in `pasosDeclarados.ts` / `escrituraDeclarada.ts`. `eventoDeclarado.ts` uses those fields without importing the files that declare them. The whole-repo `tsc` includes every file, so it passes. The SDK compiler only follows imports from its entry points, so it fails.
- **Bisect:** last good `45c2b242`; **first bad `e9059b4b`** (2026-09-12, "fix: el sobre no copiaba la escritura…"). `4f76d56a` repeats the pattern with `pasos`.
- **Why the gates missed it:** `typecheck` is whole-program, and the SDK build isn't a required check on these commits.
- **Class:** library defect in packaging, plus a weak gate: the SDK compile should be a gate.
- **Impact:** no release can be built from `main`. xarts-chat runs the `45c2b242` baseline, 13 commits behind.

## F2: the packaged library can't run outside the monorepo

- **Symptom:** in the installed tarball from `45c2b242`, `renderSvg` fails with `ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING` on `node_modules/@anlak/ui-kit/src/index.ts`. The repo's own `render-cli/sdk/check-consumer.mjs <tarball>` fails the same way at `spreadsheet-base-node.mjs`.
- **Cause:** `@anlak/ui-kit` ships raw `.ts/.tsx` source (`"main": "./src/index.ts"`) and imports `../../../core/layout` and `../../../core/theme/*`. Those paths only exist inside the monorepo.
- **Workaround in xarts-chat (recorded in every run):** `ts-loader` (the render process runs with `--import tsx`) and `core-symlink` (`visx-render/node_modules/core → ../core`). The tarball bytes are not modified.
- **Class:** library defect in packaging. `check-consumer` would catch it, but it doesn't run in CI.

## F3: data-contract errors thrown without a code

- **Symptom:** asking for the EBITDA bridge, Claude first tried `ui-waterfall-ui` with columns named `step/amount_eur`. The library threw `ui-waterfall-ui: 8 de 8 filas no traen un importe numérico …` as a plain `Error`, so `errorCode` returned `RENDER_FAILED` and `diagnosticStatus` classified it as **500 (library failure)**, not 422 (input). The agent recovered on the next attempt.
- **Location:** `charts/UIWaterfall/UIWaterfall.data.ts` (~line 166) and `charts/PriceWaterfallChart/PriceWaterfallChart.data.ts` (~line 250), which use `throw new Error` where `ChartDataError('INVALID_BINDING' | 'INVALID_DATA')` belongs.
- **Scope, not yet audited:** `main` has 1,058 plain `throw new Error(` sites across 190 `*.data.ts` modules. Some are genuine internal invariants, but input-validation throws among them are misclassified the same way.
- **Class:** weak gate. A lint rule should require coded errors for input validation in data modules. Run record: see `signals[].kind = possible_library_defect`, `code = RENDER_FAILED`.

## F4: line chart end label collides with the legend

- **Symptom:** "How has monthly revenue evolved by region?" renders a `line` chart where the "Iberia" direct end label overlaps the legend block. The legend also repeats information the end labels already give.
- **Cause (measured):** the end label «Iberia» (x 668–697.5) ends 7.5 px before the legend text «UK», but runs into the legend's colour dot between them. Text-to-text checks miss it.
- **Status:** first seen by eye. The inspector now checks text against small marks (dots, swatches) and flags it: `text-overlap: «Iberia» over «a dot»`. The same check raises nothing on the waterfall charts.

## F5: waterfall labels have no precision control and misplace the sign

- **Symptom 1 (reported by the user):** after "make it in thousands of euros", the data was divided by 1,000 but the labels printed `105.908`. In en-GB that's a decimal; to a reader used to a decimal comma it's 105,908, so the chart **reads** as unchanged. The subtitle said thousands.
- **Symptom 2 (reported by the agent after reading its own output):** with `overrides.style.valueFormat { prefix: "€", suffix: "k" }`, negatives print as `€-110.3k` rather than `-€110.3k`. A rounded `-29.0` prints as `€-29k` next to `€-63.5k`, so precision is inconsistent within one chart.
- **Cause:** `charts/WaterfallChart/WaterfallChart.tsx:63` builds labels as `prefix + formatMeasuredAmount(value) + suffix`. `formatMeasuredAmount` (`core/i18n/formatMeasuredAmount.ts`) prints up to 6 significant decimals of the data and drops trailing zeros, and the prefix goes in front of the sign. `numberFormat` (per-role decimals) is listed as *reserved, not implemented* in `docs/CONTRACT.md`.
- **Workaround in xarts-chat:** the `label-precision` read-back check flags 3+ decimal labels, and the agent rounds in SQL. The sign placement can't be worked around from the spec.
- **Class:** missing capability (`numberFormat`) plus a library defect (sign placement). Good Promote growth case: the contract already reserves the field name.

## Measured coverage (`npm run coverage`, `runs/coverage.json`)

For the baseline release, 391 of 394 catalogue forms render their own demo spec through the installed package: all 251 data charts, 96 of 99 frameworks (3 have no demo) and all 44 conceptual forms, in 4.9 s total. **Renders is not reads well:**

## F6: 27 demo charts clip their own text; 24 have overlapping text (`npm run quality`)

The inspector ran on all 391 demo specs through the baseline package (91 s): **317 pass, 47 warn, 27 fail**.
- **Clipping (27 forms, a fail):** text more than max(3 px, 20% of line height) outside the canvas. Checked by eye: `breakeven` cuts its x-axis title "Units Sold" at the bottom; `alluvial` cuts "Premium (200)" and "Enterprise (100)" on the left and "Churned (200)" on the right. Smaller overshoots (e.g. the "$100K" tick on `area`, 2.7 px) are below the threshold on purpose.
- **Overlaps (24 forms, a warn):** e.g. `adjacency` («Payment Service» over «Notification»), `clustered-heatmap`, `correlation`, `brush` («2022» over «ene 22»).
- **Truncated labels (29 forms, a warn).**
- **Not detected yet:** a label struck through by a **line** (e.g. "BEP: 7.500 units" on `breakeven`). The inspector checks text against text and against small marks, not against paths.
- Per-form results in `runs/quality.json`; images of every flagged form in `runs/quality-shots/`. These are demo datasets, so some issues may only show at these sizes, but each is reproducible from `specs/demo/<id>.json`.
