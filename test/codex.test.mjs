import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, appendFile, stat, utimes, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { collectCodex } from '../src/collect/codex.mjs';

async function fixture(t) {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), 'codex-collector-'));
  t.after(() => rm(homeDir, { recursive: true, force: true }));
  const dir = path.join(homeDir, 'sessions', '2026', '09', '28');
  await mkdir(dir, { recursive: true });
  return { homeDir, dir };
}

async function rollout(dir, name, records, tail = '') {
  const file = path.join(dir, `rollout-${name}.jsonl`);
  await writeFile(file, records.map(record => JSON.stringify(record)).join('\n') + '\n' + tail);
  return file;
}

function row(type, payload, timestamp = '2026-09-28T12:00:00Z') {
  return { timestamp, type, payload };
}

test('links children, tracks model switches and sums each response once', async t => {
  const { homeDir, dir } = await fixture(t);
  const parentFile = await rollout(dir, 'parent', [
    row('session_meta', { session_id: 'parent', timestamp: '2026-09-28T11:00:00Z', cwd: '/work' }),
    row('turn_context', { model: 'model-a' }),
    row('turn_context', { model: 'model-b' }, '2026-09-28T12:01:00Z'),
    row('token_usage_record', { thread_id: 'parent', response_id: 'r1', usage: {
      input_tokens: 100, cached_input_tokens: 40, cache_write_input_tokens: 10,
      output_tokens: 20, reasoning_output_tokens: 5, total_tokens: 120,
    } }),
    row('token_usage_record', { thread_id: 'parent', response_id: 'r1', usage: { input_tokens: 999, output_tokens: 999 } }),
    row('token_usage_record', { thread_id: 'parent', response_id: 'r2', usage: { input_tokens: 30, cached_input_tokens: 8, output_tokens: 7 } }),
    row('event_msg', { type: 'token_count', info: { total_token_usage: { input_tokens: 5000, output_tokens: 5000 } } }),
    row('event_msg', { type: 'task_complete', completed_at: '2026-09-28T12:03:00Z' }, '2026-09-28T12:03:01Z'),
  ]);
  await rollout(dir, 'child', [
    row('session_meta', { id: 'child', parent_thread_id: 'parent', timestamp: '2026-09-28T12:00:00Z', agent_nickname: 'worker' }),
    row('turn_context', { model: 'model-c' }),
  ]);
  const { agents, warnings } = await collectCodex({ homeDir, sinceMs: 0 });
  assert.deepEqual(warnings, []);
  assert.equal(agents.length, 2);
  const parent = agents.find(agent => agent.session_id === 'parent');
  const child = agents.find(agent => agent.session_id === 'child');
  assert.equal(parent.source_path, parentFile);
  assert.equal(parent.agent_id, 'codex:parent');
  assert.equal(parent.kind, 'root');
  assert.equal(parent.parent_agent_id, null);
  assert.deepEqual(parent.models_observed, ['model-a', 'model-b']);
  assert.equal(parent.model, 'model-b');
  assert.equal(parent.started_at, '2026-09-28T11:00:00.000Z');
  assert.equal(parent.last_observed_at, '2026-09-28T12:03:01.000Z');
  assert.equal(parent.last_turn_ended_at, '2026-09-28T12:03:00.000Z');
  assert.equal(parent.ended_at, null);
  assert.equal(parent.lifecycle_evidence, 'codex_turn_end');
  assert.equal(parent.workspace_path, '/work');
  assert.equal(parent.usage.basis, 'codex_response_records');
  assert.deepEqual(parent.usage.raw, {
    input_tokens: 130, cached_input_tokens: 48, cache_write_input_tokens: 10,
    output_tokens: 27, reasoning_output_tokens: 5, total_tokens: 120,
  });
  assert.equal(parent.usage.input_tokens, 130);
  assert.equal(parent.usage.total_tokens, 157);
  assert.equal(child.kind, 'subagent');
  assert.equal(child.parent_agent_id, 'codex:parent');
  assert.equal(child.display_name, 'worker');
  assert.equal(child.workspace_path, null);
});

test('uses thread IDs for identity when rollouts share a session ID', async t => {
  const { homeDir, dir } = await fixture(t);
  await rollout(dir, 'shared-parent', [
    row('session_meta', { id: 'root-thread', session_id: 'shared-session' }),
  ]);
  await rollout(dir, 'shared-child', [
    row('session_meta', {
      id: 'child-thread', session_id: 'shared-session', parent_thread_id: 'root-thread',
      timestamp: '2026-09-28T12:00:00Z', cwd: '/child-work', agent_nickname: 'worker',
    }),
    row('session_meta', {
      id: 'shared-session', session_id: 'shared-session',
      timestamp: '2026-09-28T10:00:00Z', cwd: '/root-work', agent_nickname: 'root',
    }, '2026-09-28T12:01:00Z'),
    row('turn_context', { model: 'model-after-metadata' }, '2026-09-28T12:02:00Z'),
  ]);

  const { agents, warnings } = await collectCodex({ homeDir, sinceMs: 0 });
  assert.deepEqual(warnings, []);
  assert.equal(agents.length, 2);
  assert.deepEqual(new Set(agents.map(agent => agent.agent_id)),
    new Set(['codex:root-thread', 'codex:child-thread']));
  assert.ok(agents.every(agent => agent.session_id === 'shared-session'));
  const child = agents.find(agent => agent.agent_id === 'codex:child-thread');
  assert.equal(child.kind, 'subagent');
  assert.equal(child.parent_agent_id, 'codex:root-thread');
  assert.equal(child.started_at, '2026-09-28T12:00:00.000Z');
  assert.equal(child.workspace_path, '/child-work');
  assert.equal(child.display_name, 'worker');
  assert.equal(child.last_observed_at, '2026-09-28T12:02:00.000Z');
  assert.equal(child.model, 'model-after-metadata');
});

test('uses latest legacy snapshot only without response records', async t => {
  const { homeDir, dir } = await fixture(t);
  await rollout(dir, 'legacy', [
    row('session_meta', { id: 'legacy' }),
    row('event_msg', { type: 'token_count', info: { total_token_usage: { input_tokens: 10, output_tokens: 2 } } }),
    row('event_msg', { type: 'token_count', info: { total_token_usage: { input_tokens: 15, cached_input_tokens: 5, output_tokens: 3 } } }),
  ]);
  const { agents } = await collectCodex({ homeDir, sinceMs: 0 });
  assert.equal(agents[0].usage.basis, 'codex_legacy_snapshot');
  assert.deepEqual(agents[0].usage.raw, { input_tokens: 15, cached_input_tokens: 5, output_tokens: 3 });
  assert.equal(agents[0].usage.total_tokens, 18);
});

test('skips malformed records and an incomplete trailing line without leaking content', async t => {
  const { homeDir, dir } = await fixture(t);
  const file = await rollout(dir, 'broken', [row('session_meta', { id: 'broken' })], '{"type":"token_usage_record","payload":{"secret":"private"');
  await appendFile(file, '{not-json}\n');
  const { agents, warnings } = await collectCodex({ homeDir, sinceMs: 0 });
  assert.equal(agents.length, 1);
  assert.equal(agents[0].usage.basis, 'none');
  assert.ok(warnings.length > 0);
  assert.ok(warnings.every(warning => !warning.includes('private')));
});

test('filters by age, caps selected files, and invalidates changed-file cache', async t => {
  const { homeDir, dir } = await fixture(t);
  const old = await rollout(dir, 'old', [row('session_meta', { id: 'old' })]);
  const fresh = await rollout(dir, 'fresh', [row('session_meta', { id: 'fresh' })]);
  const cutoff = Date.now() - 10_000;
  await utimes(old, new Date(cutoff - 1000), new Date(cutoff - 1000));
  const first = await collectCodex({ homeDir, sinceMs: cutoff, maxFiles: 1 });
  assert.deepEqual(first.agents.map(agent => agent.session_id), ['fresh']);
  first.agents[0].models_observed.push('caller-mutation');
  await appendFile(fresh, JSON.stringify(row('turn_context', { model: 'new-model' })) + '\n');
  const info = await stat(fresh);
  await utimes(fresh, info.atime, new Date(info.mtimeMs + 2000));
  const second = await collectCodex({ homeDir, sinceMs: cutoff, maxFiles: 1 });
  assert.deepEqual(second.agents[0].models_observed, ['new-model']);
  assert.equal(second.agents[0].model, 'new-model');
  const none = await collectCodex({ homeDir, sinceMs: Date.now() + 60_000 });
  assert.deepEqual(none.agents, []);
});

test('uses record timestamps when lifecycle payload timestamps are absent and discloses file cap', async t => {
  const { homeDir, dir } = await fixture(t);
  await rollout(dir, 'fallback', [
    row('session_meta', { id: 'fallback' }, '2026-09-28T10:00:00Z'),
    row('event_msg', { type: 'task_complete' }, '2026-09-28T10:05:00Z'),
  ]);
  await rollout(dir, 'other', [row('session_meta', { id: 'other' })]);
  const complete = await collectCodex({ homeDir, sinceMs: 0 });
  const fallback = complete.agents.find(agent => agent.session_id === 'fallback');
  assert.equal(fallback.started_at, '2026-09-28T10:00:00.000Z');
  assert.equal(fallback.last_turn_ended_at, '2026-09-28T10:05:00.000Z');
  assert.equal(fallback.lifecycle_evidence, 'codex_turn_end');
  const limited = await collectCodex({ homeDir, sinceMs: 0, maxFiles: 1 });
  assert.equal(limited.agents.length, 1);
  assert.ok(limited.warnings.some(warning => warning.includes('partial')));
});
