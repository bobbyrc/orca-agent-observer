import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { createServer } from '../src/server.mjs';

const calls = [];
let clock = Date.parse('2026-09-28T12:00:00.000Z');
let failClaude = false;
let pauseCodex = null;
const row = { schema_version: 1, agent_id: 'codex:synthetic', provider: 'codex_cli' };
const server = createServer({
  codexHome: '/synthetic/codex',
  claudeHome: '/synthetic/claude',
  now: () => clock,
  codexCollector: async options => {
    calls.push(['codex', options]);
    if (pauseCodex) await pauseCodex;
    return { agents: [row], warnings: ['Codex transcript selection reached maxFiles.'] };
  },
  claudeCollector: async options => {
    calls.push(['claude', options]);
    if (failClaude) throw new Error('private transcript content must not reach clients');
    return { agents: [], warnings: [] };
  },
});
let base;

before(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => new Promise(resolve => server.close(resolve)));

test('snapshot scopes, bounded collectors, and short cache', async () => {
  const first = await (await fetch(`${base}/api/snapshot`)).json();
  assert.equal(first.schema_version, 1);
  assert.equal(first.collected_at, '2026-09-28T12:00:00.000Z');
  assert.deepEqual(first.scope, {
    label: 'Files updated in last 24 hours',
    since: '2026-09-27T12:00:00.000Z',
  });
  assert.deepEqual(first.agents, [row]);
  assert.deepEqual(first.warnings, ['Codex transcript selection reached maxFiles.']);
  assert.deepEqual(calls.slice(0, 2), [
    ['codex', { homeDir: '/synthetic/codex', sinceMs: clock - 86_400_000, maxFiles: 500 }],
    ['claude', { homeDir: '/synthetic/claude', sinceMs: clock - 86_400_000, maxFiles: 500 }],
  ]);

  await fetch(`${base}/api/snapshot?days=1`);
  assert.equal(calls.length, 2);
  const weekly = await (await fetch(`${base}/api/snapshot?days=7`)).json();
  assert.equal(weekly.scope.label, 'Files updated in last 7 days');
  assert.equal(weekly.scope.since, '2026-09-21T12:00:00.000Z');
  assert.equal(calls[2][1].maxFiles, 1_000);
  assert.equal(calls[3][1].maxFiles, 1_000);

  await fetch(`${base}/api/snapshot?days=1&refresh=1`);
  assert.equal(calls.length, 6);
  clock += 5_001;
  await fetch(`${base}/api/snapshot?days=1`);
  assert.equal(calls.length, 8);
});

test('simultaneous requests share a collection', async () => {
  let release;
  pauseCodex = new Promise(resolve => { release = resolve; });
  const a = fetch(`${base}/api/snapshot?days=7&refresh=1`);
  const b = fetch(`${base}/api/snapshot?days=7&refresh=1`);
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(calls.length, 10);
  release();
  pauseCodex = null;
  assert.deepEqual(await (await a).json(), await (await b).json());
});

test('provider failure returns partial results and hides exception text', async () => {
  failClaude = true;
  const response = await fetch(`${base}/api/snapshot?days=1&refresh=1`);
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.deepEqual(data.agents, [row]);
  assert(data.warnings.includes('Could not collect Claude Code sessions.'));
  assert(!JSON.stringify(data).includes('private transcript content'));
  failClaude = false;
});

test('only declared assets and valid API requests are served', async () => {
  for (const [path, type] of [
    ['/', 'text/html'], ['/index.html', 'text/html'],
    ['/app.js', 'text/javascript'], ['/styles.css', 'text/css'],
  ]) {
    const response = await fetch(base + path);
    assert.equal(response.status, 200);
    assert(response.headers.get('content-type').startsWith(type));
    assert((await response.text()).length > 0);
  }
  for (const path of ['/README.md', '/src/server.mjs', '/%2e%2e/README.md']) {
    assert.equal((await fetch(base + path)).status, 404);
  }
  assert.equal((await fetch(`${base}/api/snapshot?days=2`)).status, 400);
  assert.equal((await fetch(`${base}/api/snapshot?days=1&days=7`)).status, 400);
  assert.equal((await fetch(`${base}/api/snapshot`, { method: 'POST' })).status, 405);
});
