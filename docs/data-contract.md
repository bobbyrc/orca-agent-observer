# Agent session data contract (v1)

This contract describes one local Codex CLI or Claude Code root agent or subagent. It stores metadata and token counts, never prompt, message, or tool-result content. All timestamps are RFC 3339 UTC strings. A missing measurement is `null`, never zero.

## Row

| Field | Type | Meaning |
| --- | --- | --- |
| `schema_version` | integer, always `1` | Contract version. |
| `agent_id` | string | Provider-scoped stable key: `codex:<thread-id>`, `claude:<session-id>:root`, or `claude:<session-id>:<agent-id>`. For Codex, `<thread-id>` is `session_meta.payload.id` (the per-thread UUID), falling back to `session_meta.payload.session_id` only when `id` is absent. |
| `provider` | `"codex_cli" \| "claude_code"` | Local transcript producer. |
| `session_id` | string | Codex `session_meta.payload.session_id` (the session grouping UUID, falling back to `id` when absent) or Claude Code transcript `sessionId` / parent filename stem. Codex children may share this value with their root. |
| `kind` | `"root" \| "subagent"` | Whether this row has a spawning parent. |
| `parent_agent_id` | string or `null` | Immediate parent in the same provider's key format; `null` for a root or an unresolved link. |
| `display_name` | string or `null` | Safe label supplied by the source, such as a Codex agent nickname or Claude subagent type. Never derive it from prompt or message content. |
| `workspace_path` | string or `null` | Source-reported working directory (`cwd`) when known. |
| `model` | string or `null` | Most recently observed actual/selected model ID. From Claude `assistant.message.model` (served model); from Codex `turn_context.payload.model` (selected model). Do not use Claude sidecar `model`, which is a request and can differ from the served model. |
| `models_observed` | array of strings | Distinct observed model IDs in first-seen order. Empty if unknown. Preserve changes during a session; `model` is the most recently observed ID and may appear earlier in this list if the session returns to a previous model. |
| `started_at` | string or `null` | First known agent start: Codex `session_meta.payload.timestamp`; Claude `SubagentStart` hook when captured, otherwise first transcript timestamp. A transcript-derived value is an observation, not proof of process launch time. |
| `last_observed_at` | string or `null` | Latest valid record timestamp or lifecycle hook timestamp. |
| `ended_at` | string or `null` | Claude `SubagentStop` hook timestamp only when no later `SubagentStart` is known. For Codex, leave `null`: `task_complete` ends a turn and the thread may resume. Without hooks, a Claude transcript's last line does not establish completion. |
| `last_turn_ended_at` | string or `null` | Latest Codex `task_complete.payload.completed_at`; `null` for Claude. |
| `lifecycle_evidence` | `"claude_hook_start" \| "claude_hook_stop" \| "codex_turn_end" \| "transcript_only" \| "none"` | Strongest *latest* relevant observation; a later Claude start supersedes an earlier stop. This is evidence, not a `running` status. |
| `usage` | object | Token measurements defined below. |
| `source_path` | string | Absolute path of the agent's own JSONL transcript or rollout. |

`kind` is `"root"` only when no parent exists. If a child is known but its immediate parent cannot be resolved, keep `kind: "subagent"` and `parent_agent_id: null`; do not attach it to the root by guesswork. For Codex, the first valid `session_meta` in a rollout supplies the authoritative thread ID, session grouping ID, `parent_thread_id`, `started_at`, `cwd` (`workspace_path`), and `display_name`. Later `session_meta` records can carry the shared root ID and must not overwrite those child identity and attribute fields. `parent_thread_id` is the immediate parent link; a shared `session_id` does not establish a parent link. Claude's `<session-id>/subagents/agent-<agent-id>.jsonl` gives the root session; the adjacent `.meta.json` can provide `parentAgentId` for a nested child, or `toolUseId` to join the spawning `Agent` tool call in a parent transcript. Preserve unresolved links until the parent is found.

## `usage` object

| Field | Type | Meaning |
| --- | --- | --- |
| `raw` | object mapping string to nonnegative integer | Sum of provider fields, with their original names and semantics. Empty when unavailable. Do not insert absent fields as zero. |
| `input_tokens` | nonnegative integer or `null` | Total input including cache activity, normalized across providers. |
| `output_tokens` | nonnegative integer or `null` | Provider-reported output. |
| `total_tokens` | nonnegative integer or `null` | `input_tokens + output_tokens` when both are known. |
| `basis` | `"codex_response_records" \| "codex_legacy_snapshot" \| "claude_message_snapshots" \| "none"` | Aggregation method; it does not certify billing completeness. |

For current Codex rollouts, sum `token_usage_record.payload.usage` once per `(thread_id, response_id)`. Its `input_tokens` already includes `cached_input_tokens`; `cache_write_input_tokens`, when present, is retained as a raw field and is **not** added again. Preserve raw `input_tokens`, `cached_input_tokens`, `cache_write_input_tokens`, `output_tokens`, `reasoning_output_tokens`, and `total_tokens` when present. Never sum `turn_token_usage`, `thread_token_usage`, or `token_count` events: they are cumulative snapshots. Older rollouts without response records may use the latest `event_msg` `token_count.info.total_token_usage` as a fallback with `basis: "codex_legacy_snapshot"`; this can miss usage, including some compaction calls.

For Claude, use the final usage snapshot for each distinct `assistant.message.id` in the agent's own transcript, then sum those messages. Repeated rows for one ID are streaming updates, not separate requests. Preserve raw `input_tokens` (uncached), `cache_creation_input_tokens`, `cache_read_input_tokens`, and `output_tokens` when present. Normalize `input_tokens` as the sum of these three input categories; normalize `output_tokens` directly. If a category required for the sum is absent, leave the normalized total `null` unless the provider explicitly defines that absence as zero. Do not infer a per-agent cost from these counts.

An open or truncated file can undercount usage. Never infer that an agent is currently running from file modification time, a recent transcript event, or an unmatched start event. `last_observed_at` means exactly that. Claude hooks can provide start and stop boundaries, but a subagent can resume; pair the latest hook events by agent ID. Elapsed time to `now` requires a separately verified live-state source. Elapsed time between `started_at` and `ended_at` is a completed run span only when both endpoints have lifecycle evidence.

## Synthetic example

```json
{
  "schema_version": 1,
  "agent_id": "claude:11111111-1111-4111-8111-111111111111:agent-example",
  "provider": "claude_code",
  "session_id": "11111111-1111-4111-8111-111111111111",
  "kind": "subagent",
  "parent_agent_id": "claude:11111111-1111-4111-8111-111111111111:root",
  "display_name": "Explore",
  "workspace_path": "/example/workspace",
  "model": "claude-example-model",
  "models_observed": ["claude-example-model"],
  "started_at": "2026-01-01T12:00:00Z",
  "last_observed_at": "2026-01-01T12:02:00Z",
  "ended_at": "2026-01-01T12:02:00Z",
  "last_turn_ended_at": null,
  "lifecycle_evidence": "claude_hook_stop",
  "usage": {
    "raw": {
      "input_tokens": 100,
      "cache_creation_input_tokens": 20,
      "cache_read_input_tokens": 30,
      "output_tokens": 40
    },
    "input_tokens": 150,
    "output_tokens": 40,
    "total_tokens": 190,
    "basis": "claude_message_snapshots"
  },
  "source_path": "/example/projects/project/11111111-1111-4111-8111-111111111111/subagents/agent-example.jsonl"
}
```

## Sources and limits

- [Codex rollout protocol](https://github.com/openai/codex/blob/main/codex-rs/protocol/src/protocol.rs) defines session metadata and per-response `TokenUsageRecord`; [session state](https://github.com/openai/codex/blob/main/codex-rs/core/src/state/session.rs) accumulates turn and thread snapshots. [Rollout storage](https://github.com/openai/codex/blob/main/codex-rs/rollout/src/lib.rs) names active and archived session directories. This contract was checked against local Codex CLI 0.158 files under `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`.
- [Claude Code application data](https://code.claude.com/docs/en/claude-directory) documents root and subagent transcript locations and retention. [Subagent documentation](https://code.claude.com/docs/en/sub-agents) documents `agent-<agentId>.jsonl` and resumability. [Hook reference](https://code.claude.com/docs/en/hooks) defines `SubagentStart` and `SubagentStop` fields, including IDs and the child transcript path. [Anthropic token usage](https://docs.anthropic.com/en/docs/about-claude/pricing) defines the separate input/cache categories. The sidecar join fields and repeated assistant rows were checked against local Claude Code 2.1.284 files; they are observational and may change across versions.
