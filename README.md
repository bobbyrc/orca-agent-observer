# Orca Agent Observer

A local browser view of observed Codex CLI and Claude Code sessions and subagents.

## Start and use

Requires Node.js 24 or newer. From this directory:

```sh
npm start
```

Open `http://127.0.0.1:4173/` in a browser. You can also enter that address manually in the Orca browser. The server reads local transcript files and binds only to `127.0.0.1`; it does not install an Orca plugin or contact a remote service. Stop it with Ctrl-C.

The default folders are `~/.codex` and `~/.claude`. Set `CODEX_HOME`, `CLAUDE_CONFIG_DIR`, or `PORT` before starting to change them:

```sh
CODEX_HOME=/path/to/codex CLAUDE_CONFIG_DIR=/path/to/claude PORT=4174 npm start
```

Run the synthetic tests with `npm test`. No external packages are required.

## What the numbers mean

**Files modified** (24h or 7d) selects transcript files by modification time. A selected file can contain an older session and earlier token usage. **Last transcript event** defaults to **Past hour** and shows rows whose `last_observed_at` falls within that interval relative to collection time. Choose **Any time in scanned files** to show all rows from the selected files. An older ancestor may also appear as **Parent context** to explain a matching row's ancestry. The displayed count is matching recorded sessions, never a count of running agents. Actual live state requires separately installed lifecycle tracking, which this app does not currently have.

The server examines at most 500 files per provider for 24 hours or 1,000 per provider for 7 days; warnings indicate incomplete collection when detected. Refresh bypasses the server's five-second snapshot cache, while unchanged files can still use the collectors' parsed metadata cache.

Rows show observed timestamps, model IDs, ancestry when available, and reported token counters. Observed span includes gaps and does not prove a worker was active throughout. File timestamps and lifecycle events do not prove a worker is currently running. Open, truncated, or missing transcripts can undercount usage. Codex cached input is already part of input tokens; Claude cache creation and cache reads are separate input categories. Token counts are not a cost estimate. Prompt, message, and tool content is not part of the API response.

The local API is `GET /api/snapshot?days=1` (or `days=7`). Add `refresh=1` to bypass its short cache. See [the data contract](docs/data-contract.md) for field definitions.
