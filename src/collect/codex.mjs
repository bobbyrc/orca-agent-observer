import { createReadStream } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';

const COUNTERS = [
  'input_tokens', 'cached_input_tokens', 'cache_write_input_tokens',
  'output_tokens', 'reasoning_output_tokens', 'total_tokens',
];
const MAX_WARNINGS = 10;
const MAX_LINE_BYTES = 1024 * 1024;
const parsedCache = new Map();

function timestamp(value) {
  if (typeof value !== 'string') return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

function later(a, b) {
  return !a || (b && b > a) ? b : a;
}

function warn(warnings, message) {
  if (warnings.length < MAX_WARNINGS) warnings.push(message);
}

function counters(value) {
  if (!value || typeof value !== 'object') return {};
  const result = {};
  for (const key of COUNTERS) {
    if (Number.isSafeInteger(value[key]) && value[key] >= 0) result[key] = value[key];
  }
  return result;
}

function addCounters(target, source) {
  for (const [key, value] of Object.entries(source)) {
    const sum = (target[key] ?? 0) + value;
    if (Number.isSafeInteger(sum)) target[key] = sum;
  }
}

function usage(raw, basis) {
  const input = raw.input_tokens ?? null;
  const output = raw.output_tokens ?? null;
  const total = input !== null && output !== null && Number.isSafeInteger(input + output)
    ? input + output : null;
  return { raw, input_tokens: input, output_tokens: output, total_tokens: total, basis };
}

async function scanFiles(homeDir, sinceMs, maxFiles, warnings) {
  const root = path.join(homeDir, 'sessions');
  const files = [];
  async function descend(dir, depth) {
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); }
    catch (error) {
      if (error.code !== 'ENOENT') warn(warnings, 'Unable to read a Codex sessions directory.');
      return;
    }
    for (const entry of entries) {
      const name = entry.name;
      if (depth < 3) {
        if (entry.isDirectory() &&
            (depth === 0 ? /^\d{4}$/.test(name) : /^\d{2}$/.test(name))) {
          await descend(path.join(dir, name), depth + 1);
        }
      } else if (entry.isFile() && /^rollout-.*\.jsonl$/.test(name)) {
        const file = path.join(dir, name);
        try {
          const info = await stat(file);
          if (info.mtimeMs >= sinceMs) files.push({ file, mtimeMs: info.mtimeMs, size: info.size });
        } catch { warn(warnings, 'Unable to inspect a Codex rollout.'); }
      }
    }
  }
  await descend(root, 0);
  files.sort((a, b) => b.mtimeMs - a.mtimeMs || a.file.localeCompare(b.file));
  if (files.length > maxFiles) warn(warnings, 'Codex rollout file limit reached; collection is partial.');
  return files.slice(0, maxFiles);
}

async function parseFile(file, warnings) {
  let threadId = null;
  let sessionId = null;
  let parentId = null;
  let startedAt = null;
  let lastObservedAt = null;
  let lastTurnEndedAt = null;
  let model = null;
  let displayName = null;
  let workspacePath = null;
  const modelsObserved = [];
  const seenResponses = new Set();
  const raw = {};
  let hasResponses = false;
  let legacyRaw = null;

  function recordLine(line) {
    let record;
    try { record = JSON.parse(line); }
    catch { warn(warnings, 'Malformed Codex rollout record skipped.'); return; }
    if (!record || typeof record !== 'object') return;
    const payload = record.payload;
    if (!payload || typeof payload !== 'object') return;
    lastObservedAt = later(lastObservedAt, timestamp(record.timestamp));
    if (record.type === 'session_meta') {
      const id = payload.id ?? payload.session_id;
      const session = payload.session_id ?? payload.id;
      // Child rollouts can repeat session_meta with the root's ID later on.
      // The first valid metadata record identifies the rollout's thread.
      if (!threadId && typeof id === 'string' && id && typeof session === 'string' && session) {
        threadId = id;
        sessionId = session;
        if (typeof payload.parent_thread_id === 'string' && payload.parent_thread_id) parentId = payload.parent_thread_id;
        startedAt = timestamp(payload.timestamp) ?? timestamp(record.timestamp);
        if (typeof payload.cwd === 'string' && payload.cwd) workspacePath = payload.cwd;
        const name = payload.agent_nickname ?? payload.agent_path;
        if (typeof name === 'string' && name) displayName = name;
      }
    } else if (record.type === 'turn_context') {
      if (typeof payload.model === 'string' && payload.model) {
        model = payload.model;
        if (!modelsObserved.includes(model)) modelsObserved.push(model);
      }
    } else if (record.type === 'token_usage_record') {
      const threadId = payload.thread_id;
      const responseId = payload.response_id;
      if (typeof threadId !== 'string' || !threadId || typeof responseId !== 'string' || !responseId) {
        warn(warnings, 'Codex usage record without response identity skipped.');
        return;
      }
      const key = JSON.stringify([threadId, responseId]);
      if (seenResponses.has(key)) return;
      seenResponses.add(key);
      hasResponses = true;
      addCounters(raw, counters(payload.usage));
    } else if (record.type === 'event_msg' && payload.type === 'token_count') {
      const snapshot = counters(payload.info?.total_token_usage);
      if (Object.keys(snapshot).length) legacyRaw = snapshot;
    } else if ((record.type === 'event_msg' && payload.type === 'task_complete') || record.type === 'task_complete') {
      lastTurnEndedAt = later(lastTurnEndedAt, timestamp(payload.completed_at) ?? timestamp(record.timestamp));
    }
  }

  try {
    const stream = createReadStream(file);
    let pending = Buffer.alloc(0);
    let discarding = false;
    for await (const chunk of stream) {
      let start = 0;
      for (let i = 0; i < chunk.length; i++) {
        if (chunk[i] !== 10) continue;
        const part = chunk.subarray(start, i);
        if (!discarding && pending.length + part.length <= MAX_LINE_BYTES) {
          const line = Buffer.concat([pending, part]).toString('utf8').trim();
          if (line) recordLine(line);
        } else warn(warnings, 'Oversized Codex rollout record skipped.');
        pending = Buffer.alloc(0);
        discarding = false;
        start = i + 1;
      }
      if (start < chunk.length && !discarding) {
        const part = chunk.subarray(start);
        if (pending.length + part.length <= MAX_LINE_BYTES) pending = Buffer.concat([pending, part]);
        else { pending = Buffer.alloc(0); discarding = true; }
      }
    }
    // An unterminated final line may still be in flight; never count it.
  } catch {
    warn(warnings, 'Unable to read a Codex rollout.');
    return null;
  }
  if (!threadId || !sessionId) {
    warn(warnings, 'Codex rollout without session metadata skipped.');
    return null;
  }
  const chosenRaw = hasResponses ? raw : legacyRaw ?? {};
  const basis = hasResponses ? 'codex_response_records' : legacyRaw ? 'codex_legacy_snapshot' : 'none';
  return {
    schema_version: 1,
    agent_id: `codex:${threadId}`,
    provider: 'codex_cli',
    session_id: sessionId,
    kind: parentId ? 'subagent' : 'root',
    parent_agent_id: parentId ? `codex:${parentId}` : null,
    model,
    models_observed: modelsObserved,
    started_at: startedAt,
    last_observed_at: lastObservedAt,
    ended_at: null,
    last_turn_ended_at: lastTurnEndedAt,
    lifecycle_evidence: lastTurnEndedAt ? 'codex_turn_end' : lastObservedAt ? 'transcript_only' : 'none',
    usage: usage(chosenRaw, basis),
    source_path: file,
    display_name: displayName,
    workspace_path: workspacePath,
  };
}

export async function collectCodex({ homeDir, sinceMs, maxFiles = 500 }) {
  if (typeof homeDir !== 'string' || !homeDir) throw new TypeError('homeDir must be a directory path');
  if (!Number.isFinite(sinceMs)) throw new TypeError('sinceMs must be a timestamp in milliseconds');
  if (!Number.isSafeInteger(maxFiles) || maxFiles < 0) throw new TypeError('maxFiles must be a nonnegative integer');
  const warnings = [];
  const files = await scanFiles(homeDir, sinceMs, maxFiles, warnings);
  const selected = new Set(files.map(({ file }) => file));
  for (const file of parsedCache.keys()) if (!selected.has(file)) parsedCache.delete(file);
  const agents = [];
  for (const { file, mtimeMs, size } of files) {
    let cached = parsedCache.get(file);
    if (!cached || cached.mtimeMs !== mtimeMs || cached.size !== size) {
      const fileWarnings = [];
      const row = await parseFile(file, fileWarnings);
      cached = { mtimeMs, size, row, warnings: fileWarnings };
      parsedCache.set(file, cached);
    }
    for (const warning of cached.warnings) warn(warnings, warning);
    const { row } = cached;
    if (row) agents.push(structuredClone(row));
  }
  return { agents, warnings };
}
