import { createServer as createHttpServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { collectCodex } from './collect/codex.mjs';
import { collectClaude } from './collect/claude.mjs';

const publicDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');
const assets = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/index.html', ['index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/styles.css', ['styles.css', 'text/css; charset=utf-8']],
]);
const CACHE_MS = 5_000;

function sendJson(response, status, value) {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  response.end(JSON.stringify(value));
}

/** Create a localhost-only server. Collector overrides are for synthetic tests. */
export function createServer({
  codexCollector = collectCodex,
  claudeCollector = collectClaude,
  codexHome = process.env.CODEX_HOME || join(homedir(), '.codex'),
  claudeHome = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'),
  now = () => Date.now(),
} = {}) {
  const cache = new Map();

  async function snapshot(days, refresh) {
    const current = now();
    const previous = cache.get(days);
    if (previous?.pending) return previous.pending;
    if (!refresh && previous && current - previous.createdAt < CACHE_MS) return previous.value;

    const sinceMs = current - days * 24 * 60 * 60 * 1_000;
    const maxFiles = days === 1 ? 500 : 1_000;
    const pending = (async () => {
      const results = await Promise.allSettled([
        codexCollector({ homeDir: codexHome, sinceMs, maxFiles }),
        claudeCollector({ homeDir: claudeHome, sinceMs, maxFiles }),
      ]);
      const agents = [];
      const warnings = [];
      for (const [index, result] of results.entries()) {
        if (result.status === 'rejected') {
          warnings.push(`Could not collect ${index === 0 ? 'Codex' : 'Claude Code'} sessions.`);
          continue;
        }
        agents.push(...result.value.agents);
        warnings.push(...result.value.warnings);
      }
      return {
        schema_version: 1,
        collected_at: new Date(current).toISOString(),
        scope: {
          label: `Files updated in last ${days === 1 ? '24 hours' : '7 days'}`,
          since: new Date(sinceMs).toISOString(),
        },
        agents,
        warnings,
      };
    })();
    cache.set(days, { pending });
    try {
      const value = await pending;
      cache.set(days, { value, createdAt: current });
      return value;
    } catch (error) {
      cache.delete(days);
      throw error;
    }
  }

  return createHttpServer(async (request, response) => {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      sendJson(response, 405, { error: 'Method not allowed' });
      return;
    }
    let url;
    try { url = new URL(request.url, 'http://localhost'); }
    catch { sendJson(response, 400, { error: 'Invalid URL' }); return; }
    if (url.pathname === '/api/snapshot') {
      if (request.method !== 'GET') {
        sendJson(response, 405, { error: 'Method not allowed' });
        return;
      }
      const dayValues = url.searchParams.getAll('days');
      const days = dayValues.length ? dayValues[0] : '1';
      if (dayValues.length > 1 || (days !== '1' && days !== '7')) {
        sendJson(response, 400, { error: 'days must be 1 or 7' });
        return;
      }
      try { sendJson(response, 200, await snapshot(Number(days), url.searchParams.get('refresh') === '1')); }
      catch { sendJson(response, 500, { error: 'Could not collect sessions' }); }
      return;
    }
    const asset = assets.get(url.pathname);
    if (!asset) { sendJson(response, 404, { error: 'Not found' }); return; }
    try {
      const body = await readFile(join(publicDir, asset[0]));
      response.writeHead(200, {
        'content-type': asset[1],
        'content-length': body.length,
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
      });
      response.end(request.method === 'HEAD' ? undefined : body);
    } catch { sendJson(response, 500, { error: 'Could not read asset' }); }
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === fileURLToPath(new URL(`file://${process.argv[1]}`))) {
  const port = Number(process.env.PORT ?? 4173);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    process.stderr.write('PORT must be an integer from 1 to 65535.\n');
    process.exitCode = 1;
  } else {
    createServer().listen(port, '127.0.0.1', () => {
      process.stdout.write(`Agent observer: http://127.0.0.1:${port}\n`);
    });
  }
}
