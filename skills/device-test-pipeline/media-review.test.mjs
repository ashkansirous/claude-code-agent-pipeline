// node --test skills/device-test-pipeline/media-review.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseFrameTimes, parseShowinfoTimes, groupChanges, overlapsWindow, sampleTimes, tileLayout, formatGroup } from './media-review.mjs';

test('parseFrameTimes reads ffprobe csv, sorted, ignoring junk', () => {
  assert.deepEqual(parseFrameTimes('0.000000\n2.5,\nN/A\n1.25\n'), [0, 1.25, 2.5]);
});

test('parseShowinfoTimes reads pts_time from ffmpeg stderr', () => {
  const err = '[Parsed_showinfo_2] n: 0 pts: 100 pts_time:194.2 pos: 1\nnoise\n[Parsed_showinfo_2] n: 1 pts_time:195 fmt:yuv';
  assert.deepEqual(parseShowinfoTimes(err), [194.2, 195]);
});

test('groupChanges joins frames within the gap into one movement', () => {
  const groups = groupChanges([194.0, 194.1, 194.3, 200, 60], 1.5);
  assert.deepEqual(groups.map((g) => [g.start, g.end, g.frames]), [[60, 60, 1], [194, 194.3, 3], [200, 200, 1]]);
  assert.deepEqual(groupChanges([]), []);
});

test('overlapsWindow tells whether a movement touches the kept window', () => {
  const g = { start: 194, end: 195, frames: 4 };
  assert.ok(overlapsWindow(g, 190, 10));
  assert.ok(!overlapsWindow(g, 0, 20));
  assert.ok(overlapsWindow(g, 195, 5));
});

test('sampleTimes spreads n times across the window, tileLayout caps columns', () => {
  assert.deepEqual(sampleTimes(0, 12, 4), [0, 3, 6, 9]);
  assert.deepEqual(tileLayout(12), { columns: 6, rows: 2 });
  assert.deepEqual(tileLayout(3), { columns: 3, rows: 1 });
});

test('formatGroup prints a point or a span', () => {
  assert.equal(formatGroup({ start: 5, end: 5, frames: 1 }), '5.0s (1 changed frames)');
  assert.equal(formatGroup({ start: 194, end: 195.5, frames: 6 }), '194.0-195.5s (6 changed frames)');
});
