import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyze } from './main-busy.mjs';

const line = (o) => JSON.stringify(o);
const use = (id, name, input) => line({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name, input }] } });
const result = (id, text) => line({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content: text }] } });
const notice = (id, status) => line({ type: 'user', message: { content: `<task-notification><tool-use-id>${id}</tool-use-id><status>${status}</status></task-notification>` } });
const launch = (id, desc) => [use(id, 'Agent', { description: desc, subagent_type: 'ground-in-code' }), result(id, `Async agent launched\nagentId: ag-${id}`)];

test('a timer-only transcript is not busy', () => {
  const jsonl = [use('t1', 'Bash', { command: 'sleep 600', run_in_background: true }), result('t1', 'Command running in background'),
    use('m1', 'Monitor', { command: 'watch' }), notice('t1', 'completed')].join('\n');
  assert.deepEqual(analyze(jsonl), { busy: false, pending: [] });
});

test('a launched agent without a notification is busy and named', () => {
  assert.deepEqual(analyze(launch('a1', 'check claims').join('\n')), { busy: true, pending: ['check claims'] });
});

test('a launched agent with a completed notification is not busy', () => {
  assert.equal(analyze([...launch('a1', 'x'), notice('a1', 'completed')].join('\n')).busy, false);
  assert.equal(analyze([...launch('a1', 'x'), notice('a1', 'killed')].join('\n')).busy, false);
});

test('a notification with another status leaves it busy', () => {
  assert.equal(analyze([...launch('a1', 'x'), notice('a1', 'running')].join('\n')).busy, true);
});

test('a foreground agent is busy until its result, a TaskStop ends a background one', () => {
  const fg = use('f1', 'Agent', { description: 'fg' });
  assert.equal(analyze(fg).busy, true);
  assert.equal(analyze([fg, result('f1', 'done')].join('\n')).busy, false);
  assert.equal(analyze([...launch('a2', 'bg'), use('s1', 'TaskStop', { task_id: 'ag-a2' })].join('\n')).busy, false);
});

const body = (id, status) => `<task-notification>\n<task-id>ag-${id}</task-id>\n<tool-use-id>${id}</tool-use-id>\n<status>${status}</status>\n<summary>placeholder</summary>\n</task-notification>`;
const queued = (id, status, operation = 'enqueue') => line({ type: 'queue-operation', operation, timestamp: 't', sessionId: 's', content: body(id, status) });
const attached = (id, status) => line({ type: 'attachment', attachment: { type: 'queued_command', prompt: body(id, status) } });

test('real-shape completion records (queue-operation, attachment) end an agent', () => {
  assert.equal(analyze([...launch('a1', 'x'), queued('a1', 'completed')].join('\n')).busy, false);
  assert.equal(analyze([...launch('a1', 'x'), attached('a1', 'completed')].join('\n')).busy, false);
  assert.equal(analyze([...launch('a1', 'x'), queued('a1', 'completed', 'remove')].join('\n')).busy, false);
});

test('several finished agents are not busy; one still running keeps it busy', () => {
  const done = [...launch('a1', 'one'), ...launch('a2', 'two'), queued('a1', 'completed'), attached('a2', 'failed')];
  assert.equal(analyze(done.join('\n')).busy, false);
  const mixed = [...done, ...launch('a3', 'three')];
  assert.deepEqual(analyze(mixed.join('\n')), { busy: true, pending: ['three'] });
});

test('stopped and cancelled count as done, running does not', () => {
  assert.equal(analyze([...launch('a1', 'x'), queued('a1', 'stopped')].join('\n')).busy, false);
  assert.equal(analyze([...launch('a1', 'x'), attached('a1', 'cancelled')].join('\n')).busy, false);
  assert.equal(analyze([...launch('a1', 'x'), queued('a1', 'running')].join('\n')).busy, true);
});

test('a SendMessage re-opens a finished agent until its next completion', () => {
  const resumed = [...launch('a1', 'x'), queued('a1', 'completed'), use('m1', 'SendMessage', { to: 'ag-a1', message: 'go on' })];
  assert.equal(analyze(resumed.join('\n')).busy, true);
  assert.equal(analyze([...resumed, attached('a1', 'completed')].join('\n')).busy, false);
});

test('ignores sidechain entries and unparsable lines', () => {
  const side = line({ isSidechain: true, type: 'assistant', message: { content: [{ type: 'tool_use', id: 'z', name: 'Agent', input: {} }] } });
  assert.equal(analyze(`not json\n${side}`).busy, false);
});
