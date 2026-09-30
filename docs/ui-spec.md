# Agent Usage UI specification

## Purpose and scope

Show each observed agent session's identity, parent relationship, model, observed span, and reported token usage in a compact inspector. Support the same content in a browser tab or an Orca sidebar panel. The transport supplies observations; the view must not assume direct access to Orca, local files, or a live agent process.

Orca already supports nested Codex subagent rows and individual model labels. The additional value here is inspecting activity and usage together, including the limits of the available observations. See [Orca PR #14627](https://github.com/stablyai/orca/pull/14627).

## Information hierarchy

1. **Header:** “Agent Usage”, a labelled Refresh button when refresh is supported, the observation scope, and the last successful collection time.
2. **Session list:** root sessions with explicitly linked descendants. Each row presents name, optional verified status, model, observed span, and token usage in that order.
3. **Selected session details:** full identity, source, observed timestamps, model attribution, token breakdown, and any unavailable or stale-data explanation.

Use “Observed sessions” for the default scope unless the collector can reliably identify the active worktree. Offer a scope selector only for scopes the collector actually supports. Scope text must distinguish a selected directory or worktree from all sessions observed on a host.

Immediate-parent tree edges require the source relationships defined in [the data contract](data-contract.md). Claude's documented `<session-id>/subagents/agent-<agent-id>.jsonl` location establishes root-session membership, so it may support session grouping. It does not by itself establish the immediate spawning parent of a nested child: require the adjacent sidecar's `parentAgentId`, or its `toolUseId` joined to the spawning `Agent` call in a parent transcript. Codex's `parent_thread_id` establishes its immediate parent. Do not infer other relationships from arbitrary directory nesting, similar names, start times, or model names. Show a child with an unresolved immediate parent at the top level of its known session group with “Parent not observed”; retain its subagent identity rather than relabelling it as a root agent. Preserve source identifiers and prevent duplicate rows for the same identity; unresolved identity conflicts must not be silently combined.

## Labels and measurement rules

| Label | Meaning and presentation |
| --- | --- |
| Name | Source-provided session or agent name; fall back to a shortened session identifier. Full identifier remains selectable in details. |
| Model | Model explicitly reported for this session. Do not inherit the parent's model. If only the latest model is known, label it “Last reported model” in details; session tokens may include earlier models. |
| Observed start | Earliest timestamp in the observations available to this collector. This is not necessarily the actual process or session start. |
| Observed span | `last_observed_at` minus observed start. This measures the span covered by observations, including gaps; it is not active runtime. Never advance it using the current wall clock. A single observation reads “Single observation”. |
| Last observed | Contract field `last_observed_at`: latest valid record or lifecycle-hook timestamp, not necessarily an activity event. Relative wording is allowed, with an absolute timestamp and timezone in details. This measures an observation's age, not liveness. Reserve “Last activity” for a separate, explicitly defined activity-specific field if a collector provides one. |
| Tokens | Source-reported usage with a known accounting scope. Use compact numbers in rows and exact counts in details. A confirmed zero is `0`; missing data is `—`. |
| Last collected | Last successful collection time. Keep separate from Last observed: a fresh collection can contain an old record. |
| Status | Render only when the source provides an explicit lifecycle state. Include attribution and freshness in details. Never derive Working, Idle, Done, or Stuck from file age, elapsed time, missing activity, or the presence of a session file. |

The token detail must identify whether values are cumulative or incremental and whether they cover this session alone or include descendants. Sum incremental records only after deduplication; do not sum cumulative snapshots. Do not add parent and child totals without proof that their scopes are disjoint. If accounting is ambiguous, display “Usage scope unknown” and omit the ambiguous total. Show input, output, and cached counts only when their meanings and inclusion rules are known. Do not introduce cost estimates or progress percentages.

If a future source verifies live status and start/end timestamps, it may add “Elapsed” as a separate metric with a stated definition. The default view remains observation-based.

## Row layout

Use stacked lines rather than a wide table:

- First line: expansion control, session name, and an optional source-verified status.
- Second line: model, or “Model unavailable”.
- Third line: “Span” and “Tokens”, with their values. Details expand the abbreviated Span label to Observed span.

Indent each generation modestly and use a quiet connector line. At deep nesting, allow horizontal space for the name by limiting visual indentation; preserve the full ancestry in details. Do not use a graph canvas. Keep rows in a stable order while observations refresh. New rows may append in observed-start order; updates must not continually reorder existing rows.

Sidebar and browser layouts use the same components and semantics. The sidebar fills its available width with one scrollable list and inline details. A sufficiently wide browser view may place selected details beside the list. No fixed host width is required, and no essential metric or action should require horizontal scrolling at a 320px content width.

## Data states

| State | Presentation |
| --- | --- |
| Initial collection | “Reading session observations…”; no invented rows or placeholder numeric values. |
| Empty supported scope | “No sessions observed in this scope.” Show the selected scope and last successful collection time. |
| No selected context | “Select a workspace to inspect its sessions.” Use only when workspace selection is actually required by the integration. |
| Missing field | `—` in the metric position; explain “Not reported by this source” or the specific known reason in details. Never substitute zero. |
| Partial collection | Preserve available rows and show “Some sessions could not be read” with a concise source-specific explanation. Do not imply the roster is complete. |
| Refresh failure | Retain the last successful snapshot, mark it “Update failed”, and retain its collection timestamp. Offer Retry only when supported. |
| Stale collection | Mark “Updates delayed” only when the collector reports a freshness failure or its declared update deadline has passed. Show the last successful collection time. Do not call an agent stalled. |
| Unsupported source | “Session observations are unavailable from this source.” Do not present this as an empty successful scan. |
| Verified completion | Show the reported completion state and timestamp if supplied. Do not fabricate completion from missing files or a disconnected collector. |

A source reporting recent collection does not prove an agent is live. Conversely, an old Last observed timestamp does not establish a failed collector. Show these independently. On loss of a live-state source, make its last reported state visibly stale rather than continuing a Working animation.

## Interaction

- Expansion controls reveal descendants; selecting a session reveals its details without changing expansion.
- Preserve selection and expansion across successful refreshes by stable identity. If the selected session is no longer present, explain that it is no longer in the current observations instead of selecting a different row silently.
- Refresh requests update the current scope, retain the previous snapshot while pending, and do not move keyboard focus.
- Details show full names, exact metric values, absolute timestamps with timezone, source attribution, and data-quality explanations. Essential information must not be available only through hover.
- A navigation action such as “Open session” appears only if the integration can resolve and open the actual session. The initial design does not assume this capability.
- Keep observation controls read-only. Agent interruption, messaging, model switching, and task dispatch are outside this inspector's scope.

## Keyboard and accessibility

Use a semantic tree only if implementing its complete keyboard behavior: one tab stop, Up/Down between visible rows, Right to expand or move into children, Left to collapse or move to the parent, Home/End to the first/last visible row, and Enter to select details. Expose level, expanded state, and selected state to assistive technology. An alternative implementation may use nested lists with separately labelled native buttons; do not add tree roles without tree keyboard behavior.

Give controls visible focus rings and accessible names, including “Expand [session name]”, “Collapse [session name]”, and “Refresh observations”. Keep touch/click targets at least 24px. Pair any status color with text or a distinct labelled icon. Announce refresh failures and successful manual refreshes politely; do not announce every timer or usage-value update. Respect reduced-motion preferences and avoid pulsing indicators for observation-only data.

## Minimal visual tokens

Use system UI typography, approximately 13px body text and 14px semibold section titles, with tabular digits for measurements. Start with 12px outer padding, 8px between groups, 4px between related lines, 12px indentation per level, subtle 1px borders, and 4–6px corner radii. Allow text zoom and multiline wrapping.

Define semantic tokens for background, foreground, muted foreground, border, selected background, focus ring, and warning foreground/background. In an Orca panel, map applicable tokens to the host's injected CSS variables; provide accessible light and dark defaults in a standalone browser view. Avoid assigning green or animated accents to unverified activity. The [Orca sample panel](https://github.com/stablyai/orca/blob/main/examples/plugins/hello-orca/panel.html) demonstrates the host theme variables. Its [panel host](https://github.com/stablyai/orca/blob/main/src/renderer/src/components/right-sidebar/PluginPanel.tsx) owns panel loading and suspension; keep those host states distinct from this view's collection states.

## Acceptance checks

- A session with unknown tokens shows `—`, while a reported zero shows `0`.
- A session's span remains unchanged when the clock advances without a newer `last_observed_at`.
- A refreshed snapshot containing old observations does not mark the collector stale or the session live.
- Missing parent, missing model, unknown usage scope, partial collection, and failed refresh each have explicit explanations.
- Parent and child usage cannot be double-counted in a displayed total.
- Refresh preserves selection, expansion, focus, and stable row order.
- The list and details remain usable by keyboard, at 200% text zoom, in both themes, and at 320px content width.
- No source-verified live state means no Working/Done inference, elapsed-runtime counter, or progress animation.
