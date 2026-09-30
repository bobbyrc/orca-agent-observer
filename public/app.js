'use strict';

const $ = id => document.getElementById(id);
const state = { snapshot: null, selected: null, collapsed: new Set(), pending: false, queued: false, lastSuccess: 0, failed: false };
const providers = { codex_cli: 'Codex CLI', claude_code: 'Claude Code' };
const compact = new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 });
const exact = new Intl.NumberFormat();
const timeFormat = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'long' });
const number = (value, short = false) => value == null ? '—' : (short ? compact : exact).format(value);
const timestamp = value => value && Number.isFinite(Date.parse(value)) ? timeFormat.format(new Date(value)) : 'Not reported by this source';
const name = row => row.display_name || row.agent_id.slice(0, 25);
function span(row) {
  if (!row.started_at || !row.last_observed_at) return '—';
  const seconds = Math.floor((Date.parse(row.last_observed_at) - Date.parse(row.started_at)) / 1000);
  if (!Number.isFinite(seconds) || seconds < 0) return '—';
  if (seconds === 0) return 'Single observation';
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ${Math.floor(seconds % 3600 / 60)}m`;
  return `${Math.floor(seconds / 86400)}d ${Math.floor(seconds % 86400 / 3600)}h`;
}
function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
function facts(section, entries) {
  const list = el('dl', 'facts');
  for (const [label, value] of entries) list.append(el('dt', '', label), el('dd', '', value ?? 'Not reported by this source'));
  section.append(list);
}
function heading(section, title) { section.append(el('h3', '', title)); }
function sortBranches(children) {
  const latest = new Map();
  function branchTime(row) {
    if (latest.has(row.agent_id)) return latest.get(row.agent_id);
    const observed = Date.parse(row.last_observed_at);
    const started = Date.parse(row.started_at);
    let time = Number.isFinite(observed) ? observed : Number.isFinite(started) ? started : null;
    for (const child of children.get(row.agent_id) || []) {
      const childTime = branchTime(child);
      if (childTime !== null && (time === null || childTime > time)) time = childTime;
    }
    latest.set(row.agent_id, time);
    return time;
  }
  for (const group of children.values()) group.sort((a, b) => {
    const aTime = branchTime(a); const bTime = branchTime(b);
    if (aTime === null || bTime === null) {
      if (aTime !== bTime) return aTime === null ? 1 : -1;
    } else if (aTime !== bTime) return bTime - aTime;
    return a.agent_id < b.agent_id ? -1 : a.agent_id > b.agent_id ? 1 : 0;
  });
}
function filterRows(rows, query, provider, recency, collectedAt) {
  const byId = new Map(rows.map(row => [row.agent_id, row]));
  const parents = new Map();
  for (const row of rows) {
    let parent = byId.get(row.parent_agent_id); const seen = new Set([row.agent_id]); let cursor = parent;
    while (cursor) { if (seen.has(cursor.agent_id)) { parent = null; break; } seen.add(cursor.agent_id); cursor = byId.get(cursor.parent_agent_id); }
    parents.set(row.agent_id, parent?.agent_id || null);
  }
  const collected = Date.parse(collectedAt);
  const windowMs = recency === 'hour' ? 3600000 : recency === 'day' ? 86400000 : null;
  const matches = new Set(rows.filter(row => {
    if (provider && row.provider !== provider) return false;
    if (query && ![row.display_name, row.agent_id, row.model, row.workspace_path].some(value => value?.toLowerCase().includes(query))) return false;
    if (windowMs === null) return true;
    const observed = Date.parse(row.last_observed_at);
    const age = collected - observed;
    return Number.isFinite(age) && age >= 0 && age <= windowMs;
  }).map(row => row.agent_id));
  const visible = new Set(matches);
  for (const id of matches) { let parent = parents.get(id); while (parent) { visible.add(parent); parent = parents.get(parent); } }
  return { parents, matches, visible };
}
function renderDetails() {
  const section = $('details');
  section.replaceChildren(el('h2', '', 'Session details'));
  section.firstChild.id = 'details-title';
  if (!state.selected) { section.append(el('p', 'empty', 'Select a session to inspect its observations and reported usage.')); return; }
  const row = state.snapshot.agents.find(row => row.agent_id === state.selected);
  if (!row) { section.append(el('p', 'empty', 'The selected session is no longer in the current observations.'), el('p', 'explanation', state.selected)); return; }
  section.append(el('p', 'detail-name', name(row)), el('p', 'detail-provider', `${providers[row.provider] || row.provider} · ${row.kind === 'subagent' ? 'Subagent' : 'Root session'}`));
  heading(section, 'Identity');
  const byId = new Map(state.snapshot.agents.map(item => [item.agent_id, item]));
  const ancestry = []; const seen = new Set([row.agent_id]); let parent = byId.get(row.parent_agent_id);
  while (parent && !seen.has(parent.agent_id)) { seen.add(parent.agent_id); ancestry.unshift(name(parent)); parent = byId.get(parent.parent_agent_id); }
  facts(section, [['Agent ID', row.agent_id], ['Session ID', row.session_id], ['Parent', row.kind === 'root' ? 'Root session' : row.parent_agent_id || 'Parent not observed'], ['Ancestry', ancestry.length ? ancestry.join(' → ') : 'No observed ancestry'], ['Workspace', row.workspace_path], ['Source', row.source_path]]);
  heading(section, 'Observations');
  facts(section, [['Observed start', timestamp(row.started_at)], ['Observed span', span(row)], ['Last observed', timestamp(row.last_observed_at)], ['Last reported model', row.model], ['Models observed', row.models_observed?.join(', ') || 'Not reported by this source'], ['Lifecycle evidence', { transcript_only: 'Transcript observations only', none: 'None reported', claude_hook_start: 'Claude start hook', claude_hook_stop: 'Claude stop hook', codex_turn_end: 'Codex turn ended' }[row.lifecycle_evidence] || 'None reported']]);
  section.append(el('p', 'explanation', 'The observed span covers available timestamps, including gaps. It is not active runtime. Lifecycle evidence does not establish current live status. Session tokens may include earlier models.'));
  heading(section, 'Reported tokens');
  const usage = row.usage || { basis: 'none', raw: {} };
  const known = usage.basis !== 'none';
  facts(section, [['Input including cache', number(known ? usage.input_tokens : null)], ['Output', number(known ? usage.output_tokens : null)], ['Total', number(known ? usage.total_tokens : null)], ['Accounting', { codex_response_records: 'Deduplicated response records, summed', codex_legacy_snapshot: 'Latest cumulative session snapshot', claude_message_snapshots: 'Final snapshot per message, summed', none: 'Usage scope unknown' }[usage.basis] || 'Usage scope unknown'], ['Scope', known ? 'This session’s own transcript; descendants are not added' : 'Usage scope unknown']]);
  section.append(el('p', 'explanation', usage.basis === 'codex_legacy_snapshot' ? 'Legacy snapshots can miss usage, including compaction calls. Missing measurements are shown as —.' : 'An open or truncated transcript can undercount usage. Missing measurements are shown as —; a reported zero is 0.'));
  heading(section, 'Raw provider counters');
  const raw = Object.entries(usage.raw || {});
  if (raw.length) facts(section, raw.map(([key, value]) => [key, number(value)]));
  else section.append(el('p', 'explanation', 'No raw token counters reported by this source.'));
  section.append(el('p', 'explanation', row.provider === 'claude_code' ? 'Claude raw input excludes cache reads and cache creation. Normalized input includes all three categories when reported.' : 'Codex input already includes cached input. Cache write counters are preserved here and are not added again.'));
}
function render() {
  if (!state.snapshot) return;
  const active = document.activeElement;
  const focusId = active?.dataset.agent; const focusAction = active?.dataset.action;
  const rows = state.snapshot.agents;
  const query = $('search').value.trim().toLowerCase(); const provider = $('provider').value; const recency = $('recency').value;
  const { parents, matches, visible } = filterRows(rows, query, provider, recency, state.snapshot.collected_at);
  const children = new Map();
  for (const row of rows) if (visible.has(row.agent_id)) { const key = parents.get(row.agent_id); if (!children.has(key)) children.set(key, []); children.get(key).push(row); }
  sortBranches(children);
  const filtering = Boolean(query || provider);
  function appendRows(list, parentId) {
    for (const row of children.get(parentId) || []) {
      const item = el('li', 'session'); const line = el('div', `row${state.selected === row.agent_id ? ' selected' : ''}`);
      const descendants = children.get(row.agent_id); const expanded = filtering || !state.collapsed.has(row.agent_id);
      if (descendants?.length) {
        const toggle = el('button', 'expander', expanded ? '⌄' : '›'); toggle.type = 'button'; toggle.dataset.agent = row.agent_id; toggle.dataset.action = 'expand';
        toggle.setAttribute('aria-label', `${expanded ? 'Collapse' : 'Expand'} ${name(row)}`); toggle.setAttribute('aria-expanded', String(expanded));
        if (filtering) { toggle.disabled = true; toggle.setAttribute('aria-label', `Ancestors expanded while filtering: ${name(row)}`); }
        toggle.addEventListener('click', () => { if (expanded) state.collapsed.add(row.agent_id); else state.collapsed.delete(row.agent_id); render(); }); line.append(toggle);
      } else line.append(el('span', 'spacer'));
      const select = el('button', 'select-session'); select.type = 'button'; select.dataset.agent = row.agent_id; select.dataset.action = 'select'; select.setAttribute('aria-pressed', String(state.selected === row.agent_id));
      select.append(el('span', 'name', name(row)), el('span', 'model', `${providers[row.provider] || row.provider} · ${row.model || 'Model unavailable'}`));
      if (!matches.has(row.agent_id)) select.append(el('span', 'parent-note', 'Parent context'));
      const metrics = el('span', 'metrics');
      for (const [label, value] of [['Observation span', span(row)], ['Tokens', number(row.usage?.basis !== 'none' ? row.usage?.total_tokens : null, true)]]) { const metric = el('span'); metric.append(el('span', 'metric-label', label), document.createTextNode(value)); metrics.append(metric); }
      select.append(metrics, el('span', 'observed', `Last transcript event ${row.last_observed_at ? timestamp(row.last_observed_at) : '—'}`));
      if (row.kind === 'subagent' && !parents.get(row.agent_id)) select.append(el('span', 'parent-note', 'Parent not observed'));
      select.addEventListener('click', () => { state.selected = row.agent_id; render(); }); line.append(select); item.append(line);
      if (descendants?.length && expanded) { const nested = el('ul', 'children'); appendRows(nested, row.agent_id); item.append(nested); }
      list.append(item);
    }
  }
  const list = $('sessions'); list.replaceChildren(); appendRows(list, null);
  $('count').textContent = `${matches.size} matching ${matches.size === 1 ? 'session' : 'sessions'}`;
  $('empty').hidden = visible.size > 0; $('empty').textContent = recency === 'hour' && !filtering ? 'No transcript events in the past hour among scanned files. Widen either filter to see more history.' : rows.length ? 'No sessions match these filters.' : 'No sessions observed in this scope.';
  $('scope').textContent = `${state.snapshot.scope.label} · Since ${timestamp(state.snapshot.scope.since)}`;
  $('collected').textContent = `Last collected ${timestamp(state.snapshot.collected_at)}`;
  const warnings = $('warnings'); warnings.replaceChildren(); warnings.hidden = !state.snapshot.warnings.length;
  if (state.snapshot.warnings.length) { warnings.append(el('p', '', 'Some source data could not be read. Observations or token totals may be incomplete.')); for (const warning of state.snapshot.warnings) warnings.append(el('p', '', warning)); }
  renderDetails();
  if (focusId) Array.from(list.querySelectorAll('button')).find(button => button.dataset.agent === focusId && button.dataset.action === focusAction)?.focus({ preventScroll: true });
}
function notice(text) { $('notice').textContent = text; $('notice').hidden = !text; }
async function refresh(manual = false) {
  if (state.pending) { if (manual) state.queued = true; return; }
  state.pending = true; $('refresh').textContent = 'Refreshing…'; $('refresh').setAttribute('aria-busy', 'true');
  const controller = new AbortController(); const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const requestedDays = $('lookback').value;
    const response = await fetch(`/api/snapshot?days=${encodeURIComponent(requestedDays)}${manual ? '&refresh=1' : ''}`, { signal: controller.signal, cache: 'no-store' });
    if (!response.ok) throw new Error(`Collection returned HTTP ${response.status}`);
    const snapshot = await response.json();
    if ($('lookback').value !== requestedDays) return;
    if (snapshot.schema_version !== 1 || !Array.isArray(snapshot.agents) || !snapshot.scope || !Array.isArray(snapshot.warnings) || !Number.isFinite(Date.parse(snapshot.collected_at))) throw new Error('Unsupported observation response');
    const ids = new Set();
    for (const row of snapshot.agents) { if (typeof row.agent_id !== 'string' || ids.has(row.agent_id)) throw new Error('Observation response contains missing or duplicate identities'); ids.add(row.agent_id); }
    state.snapshot = snapshot; state.lastSuccess = Date.now(); state.failed = false; notice(''); render();
    if (manual) $('announcer').textContent = `Observations refreshed. ${snapshot.agents.length} sessions.`;
  } catch (error) {
    state.failed = true; const message = `Update failed. ${error.name === 'AbortError' ? 'Collection timed out.' : error.message} ${state.snapshot ? 'Showing the last successful collection.' : 'No observations are available yet.'} Use Refresh to retry.`;
    notice(message); $('announcer').textContent = message;
    if (!state.snapshot) $('empty').textContent = 'Session observations are unavailable.';
  } finally {
    clearTimeout(timeout); state.pending = false; $('refresh').textContent = 'Refresh'; $('refresh').removeAttribute('aria-busy');
    if (state.queued) { state.queued = false; refresh(true); }
  }
}
$('refresh').addEventListener('click', () => refresh(true));
$('search').addEventListener('input', render);
$('provider').addEventListener('change', render);
$('recency').addEventListener('change', render);
$('lookback').addEventListener('change', () => refresh(true));
$('auto').addEventListener('change', () => { if ($('auto').checked) refresh(); else if (!state.failed) notice('Automatic refresh paused. Use Refresh to collect observations.'); });
setInterval(() => {
  if (!$('auto').checked) return;
  if (!state.failed && state.lastSuccess && Date.now() - state.lastSuccess > 20000) notice('Updates delayed. Showing the last successful collection; updates are expected every 5 seconds.');
  refresh();
}, 5000);
refresh();
