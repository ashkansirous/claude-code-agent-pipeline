#!/usr/bin/env node
// Helper of the media-review agent: when does a screen recording really change, and a small contact sheet of it.
//   node media-review.mjs frames  <mp4>                       frame count and time range (ffprobe)
//   node media-review.mjs changes <mp4> [--top 0.08] [--threshold 0.004] [--gap 1.5] [--from s --seconds s]
//                                                             times the picture changes, status bar cropped off;
//                                                             with --from/--seconds each is marked inside/outside the kept window
// Options go after the file name. Needs ffmpeg and ffprobe on PATH.
//   node media-review.mjs sheet   <mp4> --out <jpg> [--from s] [--seconds s] [--tiles 12] [--width 220]
//                                                             one contact sheet (small copies only)
// simctl recordings are variable frame rate: a new frame means the screen changed, but a lone frame is often only the
// status-bar clock, so changes are measured on a crop without the top bar.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { realpathSync } from 'node:fs';

const DEFAULT_TOP = 0.08;
const DEFAULT_THRESHOLD = 0.004;
const DEFAULT_GAP = 1.5;
const DEFAULT_TILES = 12;
const DEFAULT_WIDTH = 220;
const MAX_TILE_COLUMNS = 6;

// ffprobe -select_streams v -show_entries frame=pts_time -of csv=p=0 prints one time per line.
export function parseFrameTimes(csv) {
  return csv.split('\n').map((l) => Number.parseFloat(l.split(',')[0])).filter(Number.isFinite).sort((a, b) => a - b);
}

// ffmpeg showinfo lines on stderr: "... pts_time:12.345 ...".
export function parseShowinfoTimes(stderr) {
  return [...stderr.matchAll(/\bpts_time:\s*(-?\d+(?:\.\d+)?)/g)].map((m) => Number.parseFloat(m[1]));
}

// Frames closer together than `gap` seconds are one movement (a page turn is many frames); returns {start, end, frames}.
export function groupChanges(times, gap = DEFAULT_GAP) {
  const groups = [];
  for (const time of [...times].sort((a, b) => a - b)) {
    const last = groups[groups.length - 1];
    if (last && time - last.end <= gap) { last.end = time; last.frames += 1; } else groups.push({ start: time, end: time, frames: 1 });
  }
  return groups;
}

export function overlapsWindow(group, from, seconds) {
  return group.end >= from && group.start <= from + seconds;
}

// n evenly spaced sample times across [from, from + seconds): ffmpeg's fps filter takes the frame at the START of each slot.
export function sampleTimes(from, seconds, n) {
  return Array.from({ length: n }, (_, i) => Number((from + (seconds * i) / n).toFixed(2)));
}

export function tileLayout(n) {
  const columns = Math.min(n, MAX_TILE_COLUMNS);
  return { columns, rows: Math.ceil(n / columns) };
}

export function formatGroup(group) {
  const span = group.end === group.start ? `${group.start.toFixed(1)}s` : `${group.start.toFixed(1)}-${group.end.toFixed(1)}s`;
  return `${span} (${group.frames} changed frames)`;
}

function run(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (result.error) throw new Error(`${command} failed to start: ${result.error.message}`);
  return result;
}

function option(args, name, fallback) {
  const at = args.indexOf(`--${name}`);
  return at >= 0 && args[at + 1] !== undefined ? args[at + 1] : fallback;
}

function frames(file) {
  const out = run('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'frame=pts_time', '-of', 'csv=p=0', file]);
  const times = parseFrameTimes(out.stdout);
  if (!times.length) throw new Error(`no frames read from ${file}: ${out.stderr.trim().slice(0, 200)}`);
  console.log(`frames: ${times.length}, first ${times[0].toFixed(2)}s, last ${times[times.length - 1].toFixed(2)}s`);
}

function changes(file, args) {
  const top = Number(option(args, 'top', DEFAULT_TOP));
  const threshold = Number(option(args, 'threshold', DEFAULT_THRESHOLD));
  const gap = Number(option(args, 'gap', DEFAULT_GAP));
  const filter = `crop=iw:ih*${1 - top}:0:ih*${top},select='gt(scene,${threshold})',showinfo`;
  const out = run('ffmpeg', ['-hide_banner', '-nostats', '-i', file, '-vf', filter, '-an', '-f', 'null', '-']);
  if (out.status !== 0) throw new Error(`ffmpeg failed on ${file}: ${out.stderr.trim().slice(-300)}`);
  const groups = groupChanges(parseShowinfoTimes(out.stderr), gap);
  const from = option(args, 'from');
  const seconds = Number(option(args, 'seconds', 0));
  const mark = (g) => (from === undefined || !seconds ? '' : overlapsWindow(g, Number(from), seconds) ? ' [inside kept window]' : ' [outside kept window]');
  console.log(groups.length ? groups.map((g) => formatGroup(g) + mark(g)).join('\n') : 'no picture change found (ffmpeg ran cleanly)');
}

function sheet(file, args) {
  const out = option(args, 'out');
  if (!out) throw new Error('sheet needs --out <jpg>');
  const from = Number(option(args, 'from', 0));
  const tiles = Number(option(args, 'tiles', DEFAULT_TILES));
  const width = Number(option(args, 'width', DEFAULT_WIDTH));
  const duration = probeDuration(file);
  const seconds = Number(option(args, 'seconds', 0)) || duration - from;
  if (from + seconds > duration + 0.5) throw new Error(`window ${from}s-${from + seconds}s runs past the end of the recording (${duration.toFixed(1)}s): check the cut file`);
  const { columns, rows } = tileLayout(tiles);
  const filter = `fps=${tiles}/${seconds},scale=${width}:-2,tile=${columns}x${rows}`;
  const result = run('ffmpeg', ['-hide_banner', '-y', '-ss', String(from), '-t', String(seconds), '-i', file, '-vf', filter, '-frames:v', '1', '-q:v', '5', out]);
  if (result.status !== 0) throw new Error(`ffmpeg sheet failed: ${result.stderr.trim().slice(-300)}`);
  console.log(`${out}: ${tiles} tiles over ${from}s-${(from + seconds).toFixed(1)}s, sample times ${sampleTimes(from, seconds, tiles).join(' ')}`);
}

function probeDuration(file) {
  const out = run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file]);
  const duration = Number.parseFloat(out.stdout);
  if (!Number.isFinite(duration)) throw new Error(`cannot read the duration of ${file}`);
  return duration;
}

function isEntryPoint(argvPath, moduleUrl) {
  try { return realpathSync.native(argvPath) === realpathSync.native(fileURLToPath(moduleUrl)); } catch { return false; }
}

if (isEntryPoint(process.argv[1], import.meta.url)) {
  const [command, file, ...rest] = process.argv.slice(2);
  const commands = { frames: () => frames(file), changes: () => changes(file, rest), sheet: () => sheet(file, rest) };
  try {
    if (!commands[command] || !file) throw new Error('usage: media-review.mjs frames|changes|sheet <mp4> [options]');
    commands[command]();
  } catch (error) {
    process.stderr.write(`media-review: ${error.message}\n`);
    process.exitCode = 1;
  }
}
