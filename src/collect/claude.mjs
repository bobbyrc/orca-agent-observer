import { createReadStream } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';

const MAX_WARNINGS = 20;
const INPUT_FIELDS = ['input_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens'];
const parsedCache = new Map();

function timestamp(value) {
  if (typeof value !== 'string') return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

function warn(warnings, message) {
  if (warnings.length < MAX_WARNINGS && !warnings.includes(message)) warnings.push(message);
}

async function entries(path) {
  try { return await readdir(path, { withFileTypes: true }); }
  catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

function candidate(path, sessionId, agentId, info) {
  return { path, sessionId, agentId, mtimeMs: info.mtimeMs, size: info.size };
}

async function files(homeDir, sinceMs, maxFiles, warnings) {
  const candidates = [];
  const projectsPath = join(homeDir, 'projects');
  for (const project of await entries(projectsPath)) {
    if (!project.isDirectory()) continue;
    const projectPath = join(projectsPath, project.name);
    for (const item of await entries(projectPath)) {
      if (item.isFile() && item.name.endsWith('.jsonl')) {
        const sessionId = item.name.slice(0, -6);
        const path = join(projectPath, item.name);
        try {
          const info = await stat(path);
          if (info.mtimeMs >= sinceMs) candidates.push(candidate(path, sessionId, null, info));
        } catch { warn(warnings, 'Could not inspect a Claude transcript.'); }
      } else if (item.isDirectory()) {
        const subagentsPath = join(projectPath, item.name, 'subagents');
        for (const child of await entries(subagentsPath)) {
          if (!child.isFile() || !/^agent-.+\.jsonl$/.test(child.name)) continue;
          const path = join(subagentsPath, child.name);
          try {
            const info = await stat(path);
            if (info.mtimeMs >= sinceMs) candidates.push(candidate(path, item.name, child.name.slice(6, -6), info));
          } catch { warn(warnings, 'Could not inspect a Claude transcript.'); }
        }
      }
    }
  }
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs || a.path.localeCompare(b.path));
  if (candidates.length > maxFiles) warn(warnings, 'Claude transcript selection reached maxFiles.');
  return candidates.slice(0, maxFiles);
}

function usageFromSnapshots(snapshots) {
  const raw = {};
  for (const snapshot of snapshots.values()) {
    for (const [key, value] of Object.entries(snapshot)) {
      if (Number.isSafeInteger(value) && value >= 0) raw[key] = (raw[key] ?? 0) + value;
    }
  }
  const presentInEverySnapshot = field => [...snapshots.values()].every(snapshot =>
    Number.isSafeInteger(snapshot[field]) && snapshot[field] >= 0);
  const input = snapshots.size && INPUT_FIELDS.every(presentInEverySnapshot)
    ? INPUT_FIELDS.reduce((sum, field) => sum + raw[field], 0) : null;
  const output = snapshots.size && presentInEverySnapshot('output_tokens') ? raw.output_tokens : null;
  return {
    raw,
    input_tokens: input,
    output_tokens: output,
    total_tokens: input !== null && output !== null ? input + output : null,
    basis: snapshots.size ? 'claude_message_snapshots' : 'none',
  };
}

async function collectFile(file, warnings) {
  const agentId = `claude:${file.sessionId}:${file.agentId ?? 'root'}`;
  const snapshots = new Map();
  const models = [];
  let latestModel = null;
  const toolUseIds = new Set();
  let started = null;
  let last = null;
  let workspacePath = null;
  let sidecar = {};
  if (file.agentId) {
    try {
      const parsed = JSON.parse(await readFile(file.path.slice(0, -6) + '.meta.json', 'utf8'));
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        warn(warnings, 'Could not parse a Claude sidecar.');
      } else {
        sidecar = parsed;
      }
    } catch (error) {
      if (error.code !== 'ENOENT') warn(warnings, 'Could not parse a Claude sidecar.');
    }
  }
  try {
    const stream = createReadStream(file.path);
    let lastByte = null;
    stream.on('data', chunk => { lastByte = chunk.at(-1); });
    const lines = createInterface({ input: stream, crlfDelay: Infinity });
    let malformedPending = false;
    for await (const line of lines) {
      // The preceding bad line is complete only once another line arrives.
      if (malformedPending) warn(warnings, 'Skipped a malformed Claude transcript line.');
      malformedPending = false;
      let record;
      try { record = JSON.parse(line); }
      catch { malformedPending = true; continue; }
      if (!record || typeof record !== 'object') continue;
      const time = timestamp(record.timestamp);
      if (time && (started === null || time < started)) started = time;
      if (time && (last === null || time > last)) last = time;
      if (workspacePath === null && typeof record.cwd === 'string') workspacePath = record.cwd;
      if (record.type !== 'assistant' || !record.message || typeof record.message !== 'object') continue;
      const message = record.message;
      if (typeof message.model === 'string' && message.model) {
        latestModel = message.model;
        if (!models.includes(message.model)) models.push(message.model);
      }
      if (typeof message.id === 'string' && message.usage && typeof message.usage === 'object') {
        snapshots.set(message.id, message.usage);
      }
      if (Array.isArray(message.content)) {
        for (const block of message.content) {
          if (block?.type === 'tool_use' && (block.name === 'Agent' || block.name === 'Task') && typeof block.id === 'string') {
            toolUseIds.add(block.id);
          }
        }
      }
    }
    // Claude may be writing the final line when the file is read.
    if (malformedPending && (lastByte === 10 || lastByte === 13)) {
      warn(warnings, 'Skipped a malformed Claude transcript line.');
    }
  } catch { warn(warnings, 'Could not read a Claude transcript.'); }
  return {
    row: {
      schema_version: 1,
      agent_id: agentId,
      provider: 'claude_code',
      session_id: file.sessionId,
      kind: file.agentId ? 'subagent' : 'root',
      parent_agent_id: null,
      model: latestModel,
      models_observed: models,
      started_at: started,
      last_observed_at: last,
      ended_at: null,
      last_turn_ended_at: null,
      lifecycle_evidence: started === null ? 'none' : 'transcript_only',
      usage: usageFromSnapshots(snapshots),
      source_path: resolve(file.path),
      display_name: typeof sidecar.agentType === 'string' ? sidecar.agentType : null,
      workspace_path: workspacePath,
    },
    sidecar,
    toolUseIds,
  };
}

/** Collect bounded Claude Code transcript metadata and token counts. */
export async function collectClaude({ homeDir, sinceMs, maxFiles = 500 }) {
  const warnings = [];
  const selected = await files(homeDir, sinceMs, Math.max(0, maxFiles), warnings);
  const selectedPaths = new Set(selected.map(file => file.path));
  for (const path of parsedCache.keys()) if (!selectedPaths.has(path)) parsedCache.delete(path);
  const parsed = [];
  for (const file of selected) {
    const cached = parsedCache.get(file.path);
    let sidecarSignature = null;
    if (file.agentId) {
      try {
        const info = await stat(file.path.slice(0, -6) + '.meta.json');
        sidecarSignature = `${info.mtimeMs}:${info.size}`;
      } catch (error) {
        if (error.code !== 'ENOENT') warn(warnings, 'Could not inspect a Claude sidecar.');
      }
    }
    let entry = cached;
    if (!entry || entry.mtimeMs !== file.mtimeMs || entry.size !== file.size || entry.sidecarSignature !== sidecarSignature) {
      const fileWarnings = [];
      const item = await collectFile(file, fileWarnings);
      entry = { mtimeMs: file.mtimeMs, size: file.size, sidecarSignature, item, warnings: fileWarnings };
      parsedCache.set(file.path, entry);
    }
    for (const message of entry.warnings) warn(warnings, message);
    parsed.push({ ...entry.item, row: structuredClone(entry.item.row) });
  }
  const byId = new Map(parsed.map(item => [item.row.agent_id, item]));
  const byToolUse = new Map();
  for (const item of parsed) {
    for (const id of item.toolUseIds) byToolUse.set(`${item.row.session_id}:${id}`, item.row.agent_id);
  }
  for (const item of parsed) {
    if (item.row.kind === 'root') continue;
    item.row.parent_agent_id = null;
    const { parentAgentId, toolUseId } = item.sidecar;
    let parent = null;
    if (typeof parentAgentId === 'string' && parentAgentId) {
      const key = parentAgentId === 'root' ? 'root' : parentAgentId.replace(/^agent-/, '');
      const id = `claude:${item.row.session_id}:${key}`;
      if (byId.has(id)) parent = id;
    }
    if (!parent && typeof toolUseId === 'string') parent = byToolUse.get(`${item.row.session_id}:${toolUseId}`) ?? null;
    if (parent !== item.row.agent_id) item.row.parent_agent_id = parent;
  }
  return { agents: parsed.map(item => item.row), warnings };
}
