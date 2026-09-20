# Self-testing xarts-chat

Use Node 22. Install dependencies with `npm ci --ignore-scripts`. Install Chrome/Chromium and set `CHROME_PATH` if it is not in a standard location.

- `npm test` runs the fast SQL, record, feedback, geometry and release checks.
- `npm run test:app` starts an isolated application server, drives Chrome through saved history, reload, feedback attribution and evidence tabs, and checks that writes through the SQL console are refused. It writes a screenshot and summary to `.local/test-artifacts` (or `TEST_ARTIFACTS`). Missing Chrome fails the test.
- `npm run sandbox` starts the same application with a fresh temporary database and three saved runs across two conversations. Open the printed URL. New chat requests return a synthetic fixture chart, with no Claude or SDK call. Each launch uses separate state; the normal runs, registry and finance database are untouched.

The sandbox is for exploratory browser testing: try keyboard navigation, rapid history switching, chart/data/spec/record tabs, feedback on old runs, narrow viewports, empty questions and invalid SQL. Capture steps, expected/observed results, screenshots and console errors. Confirm a suspected bug twice. Keep temporary probes outside the checkout.

**Scope of evidence:** the UI says “UI SANDBOX · no model or SDK”. Passing these tests does not verify numerical chart correctness, real model behavior or a Promote release. To verify the real library, build the exact Xarts revision with `pnpm build:sdk`, run its standalone `test:consumer <tarball>` checks, and explicitly install that tarball through the release-registry workflow. Never turn a fixture result into a release gate.

Promote's **Explore & test** screen can commission a bounded Devin session against this committed setup. It retrieves an unverified report and queues findings for independent reproduction. A test request is not permission to edit or merge source.
