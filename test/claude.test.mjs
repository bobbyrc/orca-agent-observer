import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, appendFile, rm, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { collectClaude } from '../src/collect/claude.mjs';

const t0 = '2026-01-01T12:00:00Z';
const t1 = '2026-01-01T12:01:00Z';
const t2 = '2026-01-01T12:02:00Z';
const usage = (input, create, read, output) => ({
  input_tokens: input, cache_creation_input_tokens: create,
  cache_read_input_tokens: read, output_tokens: output,
});
const assistant = (id, time, model, tokens, content = []) => ({
  type: 'assistant', timestamp: time, cwd: '/workspace/demo',
  message: { id, model, usage: tokens, content },
});
const lines = records => records.map(record => JSON.stringify(record)).join('\n') + '\n';

test('collects roots and nested children with final message usage and observed models', async t => {
  const homeDir = await mkdtemp(join(tmpdir(), 'claude-collector-'));
  t.after(() => rm(homeDir, { recursive: true, force: true }));
  const project = join(homeDir, 'projects', 'project');
  const children = join(project, 'session-1', 'subagents');
  await mkdir(children, { recursive: true });
  await writeFile(join(project, 'session-1.jsonl'), lines([
    assistant('r1', t0, 'served-root', usage(1, 2, 3, 4), [{ type: 'tool_use', name: 'Agent', id: 'spawn-a' }]),
  ]));
  await writeFile(join(children, 'agent-a.jsonl'), lines([
    assistant('a1', t0, 'served-old', usage(1, 2, 3, 4)),
    assistant('a1', t1, 'served-new', usage(10, 20, 30, 40), [{ type: 'tool_use', name: 'Agent', id: 'spawn-b' }]),
    assistant('a2', t2, 'served-new', usage(2, 3, 4, 5)),
  ]) + '{malformed}\n{also malformed}\n{incomplete');
  await writeFile(join(children, 'agent-a.meta.json'), JSON.stringify({
    toolUseId: 'spawn-a', agentType: 'Explore', model: 'requested-model',
  }));
  await writeFile(join(children, 'agent-b.jsonl'), lines([
    assistant('b1', t2, 'nested-model', usage(0, 0, 0, 2)),
  ]));
  await writeFile(join(children, 'agent-b.meta.json'), JSON.stringify({ parentAgentId: 'a', toolUseId: 'spawn-b' }));
  await writeFile(join(children, 'agent-c.jsonl'), lines([
    assistant('c1', t2, 'missing-cache', { input_tokens: 2, output_tokens: 3 }),
    assistant('c2', t2, 'missing-cache', usage(4, 5, 6, 7)),
  ]));
  await writeFile(join(children, 'agent-c.meta.json'), JSON.stringify({ toolUseId: 'unknown' }));

  const result = await collectClaude({ homeDir, sinceMs: 0 });
  const rows = new Map(result.agents.map(row => [row.agent_id, row]));
  assert.equal(rows.size, 4);
  const root = rows.get('claude:session-1:root');
  const a = rows.get('claude:session-1:a');
  const b = rows.get('claude:session-1:b');
  const c = rows.get('claude:session-1:c');
  assert.equal(root.kind, 'root');
  assert.equal(root.parent_agent_id, null);
  assert.equal(a.parent_agent_id, root.agent_id);
  assert.equal(b.parent_agent_id, a.agent_id);
  assert.equal(c.parent_agent_id, null);
  assert.equal(c.kind, 'subagent');
  assert.equal(a.model, 'served-new');
  assert.deepEqual(a.models_observed, ['served-old', 'served-new']);
  assert.deepEqual(a.usage.raw, usage(12, 23, 34, 45));
  assert.equal(a.usage.input_tokens, 69);
  assert.equal(a.usage.total_tokens, 114);
  assert.equal(a.display_name, 'Explore');
  assert.equal(a.workspace_path, '/workspace/demo');
  assert.equal(a.started_at, t0.replace('Z', '.000Z'));
  assert.equal(a.last_observed_at, t2.replace('Z', '.000Z'));
  assert.equal(a.ended_at, null);
  assert.equal(a.lifecycle_evidence, 'transcript_only');
  assert.equal(c.usage.input_tokens, null);
  assert.equal(c.usage.total_tokens, null);
  assert.equal(c.usage.raw.cache_creation_input_tokens, 5);
  assert.equal(c.usage.output_tokens, 10);
  assert.deepEqual(result.warnings, ['Skipped a malformed Claude transcript line.']);

  // A repeated call uses the parsed cache; changing size and mtime invalidates it.
  await appendFile(join(children, 'agent-b.jsonl'), lines([assistant('b2', t2, 'changed-model', usage(1, 1, 1, 1))]));
  const updated = await collectClaude({ homeDir, sinceMs: 0 });
  assert.equal(updated.agents.find(row => row.agent_id === b.agent_id).model, 'changed-model');
  await writeFile(join(children, 'agent-c.meta.json'), JSON.stringify({ parentAgentId: 'a', agentType: 'Review' }));
  const relinked = await collectClaude({ homeDir, sinceMs: 0 });
  const changedChild = relinked.agents.find(row => row.agent_id === c.agent_id);
  assert.equal(changedChild.parent_agent_id, a.agent_id);
  assert.equal(changedChild.display_name, 'Review');

  const old = new Date('2000-01-01T00:00:00Z');
  await utimes(join(project, 'session-1.jsonl'), old, old);
  const recent = await collectClaude({ homeDir, sinceMs: Date.parse('2025-01-01T00:00:00Z'), maxFiles: 2 });
  assert.equal(recent.agents.length, 2);
  assert.ok(recent.agents.every(row => row.kind === 'subagent'));
  assert.ok(recent.warnings.some(w => w.includes('maxFiles')));
});

test('an incomplete final JSONL line is treated as in-flight', async t => {
  const homeDir = await mkdtemp(join(tmpdir(), 'claude-collector-'));
  t.after(() => rm(homeDir, { recursive: true, force: true }));
  const project = join(homeDir, 'projects', 'project');
  await mkdir(project, { recursive: true });
  const path = join(project, 'session-2.jsonl');
  await writeFile(path, lines([assistant('one', t0, 'served', usage(1, 1, 1, 1))]) + '{partial');
  const first = await collectClaude({ homeDir, sinceMs: 0 });
  assert.equal(first.agents.length, 1);
  assert.deepEqual(first.warnings, []);

  await appendFile(path, '\n{bad complete}\n');
  const second = await collectClaude({ homeDir, sinceMs: 0 });
  assert.deepEqual(second.warnings, ['Skipped a malformed Claude transcript line.']);
});

test('reports the latest model when a transcript returns to an earlier model', async t => {
  const homeDir = await mkdtemp(join(tmpdir(), 'claude-collector-'));
  t.after(() => rm(homeDir, { recursive: true, force: true }));
  const project = join(homeDir, 'projects', 'project');
  await mkdir(project, { recursive: true });
  await writeFile(join(project, 'session-model.jsonl'), lines([
    assistant('one', t0, 'model-a', usage(1, 1, 1, 1)),
    assistant('two', t1, 'model-b', usage(1, 1, 1, 1)),
    assistant('three', t2, 'model-a', usage(1, 1, 1, 1)),
  ]));

  const { agents } = await collectClaude({ homeDir, sinceMs: 0 });
  assert.equal(agents[0].model, 'model-a');
  assert.deepEqual(agents[0].models_observed, ['model-a', 'model-b']);
});

test('warns for null and array sidecars without failing collection', async t => {
  const homeDir = await mkdtemp(join(tmpdir(), 'claude-collector-'));
  t.after(() => rm(homeDir, { recursive: true, force: true }));
  const children = join(homeDir, 'projects', 'project', 'session-sidecar', 'subagents');
  await mkdir(children, { recursive: true });
  for (const [name, sidecar] of [['a', 'null'], ['b', '[]']]) {
    await writeFile(join(children, `agent-${name}.jsonl`), lines([
      assistant(name, t0, 'model', usage(1, 1, 1, 1)),
    ]));
    await writeFile(join(children, `agent-${name}.meta.json`), sidecar);
  }

  const result = await collectClaude({ homeDir, sinceMs: 0 });
  assert.equal(result.agents.length, 2);
  assert.ok(result.agents.every(row => row.parent_agent_id === null && row.display_name === null));
  assert.deepEqual(result.warnings, ['Could not parse a Claude sidecar.']);
});

test('cached parent linking does not change previously returned rows', async t => {
  const homeDir = await mkdtemp(join(tmpdir(), 'claude-collector-'));
  t.after(() => rm(homeDir, { recursive: true, force: true }));
  const project = join(homeDir, 'projects', 'project');
  const children = join(project, 'session-link', 'subagents');
  await mkdir(children, { recursive: true });
  const rootPath = join(project, 'session-link.jsonl');
  const childPath = join(children, 'agent-a.jsonl');
  await writeFile(rootPath, lines([assistant('root', t0, 'model', usage(1, 1, 1, 1))]));
  await writeFile(childPath, lines([assistant('child', t0, 'model', usage(1, 1, 1, 1))]));
  await writeFile(join(children, 'agent-a.meta.json'), JSON.stringify({ parentAgentId: 'root' }));
  await utimes(rootPath, new Date('2026-01-01T00:00:00Z'), new Date('2026-01-01T00:00:00Z'));
  await utimes(childPath, new Date('2026-01-02T00:00:00Z'), new Date('2026-01-02T00:00:00Z'));

  const first = await collectClaude({ homeDir, sinceMs: 0 });
  const firstChild = first.agents.find(row => row.kind === 'subagent');
  assert.equal(firstChild.parent_agent_id, 'claude:session-link:root');
  const scoped = await collectClaude({ homeDir, sinceMs: Date.parse('2026-01-01T12:00:00Z') });
  assert.equal(scoped.agents.length, 1);
  assert.equal(scoped.agents[0].parent_agent_id, null);
  assert.equal(firstChild.parent_agent_id, 'claude:session-link:root');
});

test('retains deduplicated parse warnings for unchanged cached files', async t => {
  const homeDir = await mkdtemp(join(tmpdir(), 'claude-collector-'));
  t.after(() => rm(homeDir, { recursive: true, force: true }));
  const project = join(homeDir, 'projects', 'project');
  await mkdir(project, { recursive: true });
  await writeFile(join(project, 'session-warning.jsonl'), lines([
    assistant('one', t0, 'model', usage(1, 1, 1, 1)),
  ]) + '{bad}\n{also bad}\n');

  const first = await collectClaude({ homeDir, sinceMs: 0 });
  const second = await collectClaude({ homeDir, sinceMs: 0 });
  assert.deepEqual(first.warnings, ['Skipped a malformed Claude transcript line.']);
  assert.deepEqual(second.warnings, first.warnings);
});
