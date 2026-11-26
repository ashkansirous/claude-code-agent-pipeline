// node --test tests/settings-shape.test.mjs
// settings.example.json carries the hooks wiring, plugin switches and skill visibility; merge it into ~/.claude/settings.json.
// The board's client plugin ships disabled; enable it only if you run that board.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const settings = JSON.parse(fs.readFileSync(path.join(ROOT, 'settings.example.json'), 'utf8'));

test('enabledPlugins lists agent-board but ships it disabled', () => {
  assert.equal(settings.enabledPlugins['agent-board@agent-progress-board'], false);
});

test('every enabled plugin has its marketplace declared', () => {
  const known = new Set(Object.keys(settings.extraKnownMarketplaces));
  for (const key of Object.keys(settings.enabledPlugins)) {
    const market = key.split('@')[1];
    assert.ok(known.has(market) || market === 'claude-plugins-official', `${key}: marketplace ${market} is declared`);
  }
});

test('skillOverrides values are valid and name existing own skills or built-ins', () => {
  const allowed = new Set(['on', 'name-only', 'user-invocable-only', 'off']);
  const builtIns = new Set(['dataviz', 'keybindings-help', 'fewer-permission-prompts', 'claude-approvals', 'schedule', 'find-skills', 'context7-mcp']); // built-in or vendor skills installed outside this repo
  for (const [name, value] of Object.entries(settings.skillOverrides)) {
    assert.ok(allowed.has(value), `${name}: ${value} is a skillOverrides value`);
    assert.ok(builtIns.has(name) || fs.existsSync(path.join(ROOT, 'skills', name, 'SKILL.md')), `${name} is a skill of this repo or a built-in`);
  }
});
