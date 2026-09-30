# Plan

- [x] Confirm telemetry payloads and lifecycle events for Codex and Claude Code from official sources and local metadata.
- [x] Define a common worker record for parent/child links, actual model, token counts, observed start or span, and last observed activity; preserve source-specific cache counts.
- [x] Choose UI delivery: local browser app.
- [x] Codex collector unit (Node 24 ESM, parallel): src/collect/codex.mjs and test/codex.test.mjs; depends on docs/data-contract.md and the frozen snapshot envelope.
- [x] Claude collector unit (Node 24 ESM, parallel): src/collect/claude.mjs and test/claude.test.mjs; depends on docs/data-contract.md and the frozen snapshot envelope.
- [x] Browser UI unit: public/index.html, public/app.js, public/styles.css; depends on docs/ui-spec.md and docs/data-contract.md. Native browser controls, same-origin refresh, stable session tree and per-session details.
- [x] Integration/documentation unit: src/server.mjs, package.json, test/server.test.mjs, README; depends on both collectors and browser UI.
- [ ] Final verification: run collector checks and browser checks against the settled implementation; depends on integration.

## Final review

- [ ] Check telemetry labels against the source payloads, including cache semantics and the distinction between observed activity and confirmed running state.
- [ ] Review the chosen UI path, setup documentation, and repository contents.
- [x] Complete an independent top-tier defect review and fix its four Claude collector defects.
- [x] Run the settled collector checks: 12 tests pass.
- [x] Verify server routes in-process.
- [x] Validate in-process API responses: 24h has 152 rows and 152 unique IDs; 7d has 893 rows and 893 unique IDs. A user screenshot exposed duplicate identities; the Codex collector now takes identity from the first valid `session_meta`, and both scopes pass the uniqueness check.
- [x] Inspect the user's live-page screenshot: it renders 155 rows, and exposed oldest-first branch ordering and an overbroad warning intro. `public/app.js` now sorts visible sibling branches by their latest descendant observation and uses precise warning copy.
- [x] Verify the sort against isolated real data: 158 rows across 10 root branches, newest first. A separate top-tier defect review found no issue.
- [x] Correct the recency interpretation: 159 was a historical transcript count, not an active-session count. The default UI filters by `last_observed_at` in the past hour, separately from the 24h or 7d file-mtime scan used to select source files. It labels running status as unavailable and shows Parent context.
- [x] Fix the independent top-tier review findings for collapsed branches and empty-search copy.
- [x] Run settled-tree checks: 12 collector tests pass, `public/app.js` passes syntax validation, and an in-process 24h snapshot selects 166 rows by file mtime; 33 sessions match the past-hour activity filter, with 34 visible rows including one ancestor for context.
- [ ] Verify localhost HTTP and browser end to end.
- [ ] Track live-state lifecycle behavior from real session events.
- [ ] Confirm the final UI visually in a browser.

The earlier 152-row API count, 155-row screenshot, and 158-row sort check were observations from previous snapshots, not active-session counts. Live-state lifecycle tracking and browser visual confirmation remain open.
