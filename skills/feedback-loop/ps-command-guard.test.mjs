// node --test skills/feedback-loop/ps-command-guard.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { decide, lex } from './ps-command-guard.mjs';

const SCRIPT = fileURLToPath(new URL('./ps-command-guard.mjs', import.meta.url));
const run = (command, tool = 'Bash') => decide({ tool_name: tool, tool_input: { command } });
const denied = (command, tool) => run(command, tool)?.hookSpecificOutput?.permissionDecision === 'deny';
const allowAll = (commands, tool) => {
  for (const command of commands) assert.equal(run(command, tool), null, command);
};
const denyAll = (commands, tool) => {
  for (const command of commands) assert.ok(denied(command, tool), command);
};

test('-Command text followed by a .ps1 argument is denied, with every flag spelling', () => {
  denyAll([
    'pwsh -Command "[Parser]::ParseFile($args[0])" skills/run-all-waves/run-all-waves.ps1',
    'pwsh -NoProfile -Command "x" a.ps1', 'pwsh -c "x" a.ps1', 'pwsh -co "x" a.ps1', 'pwsh -COMMAND "x" a.ps1',
    'powershell -command "x" a.ps1', 'powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "x" .\\a.ps1',
    "pwsh -Command 'x' 'my dir/a.ps1'", 'pwsh.exe -c "x" B.PS1', '/usr/bin/pwsh -c "x" a.ps1',
    'cd x && pwsh -c "x" a.ps1', 'pwsh -c "x" a.ps1 b.ps1',
  ]);
  denyAll(['& pwsh -Command "x" a.ps1', 'pwsh -c "x" a.ps1', 'pwsh -c "x" `\n  a.ps1'], 'PowerShell');
});

test('the form nested inside bash -c or powershell -Command is denied', () => {
  denyAll([
    'bash -c "pwsh -c \\"x\\" a.ps1"', "bash -c 'pwsh -Command \"x\" a.ps1'", 'sh -c \'powershell -c "x" a.ps1\'',
    'powershell -Command "pwsh -c \'x\' a.ps1"',
  ]);
});

const PARSE_SCRIPT = '$e = $null\n[System.Management.Automation.Language.Parser]::ParseFile($args[0], [ref]$null, [ref]$e)\n$e';

test('the incident command (multi-line -Command text, then the driver script) is denied', () => {
  const driver = 'skills/run-all-waves/run-all-waves.ps1';
  assert.ok(denied(`pwsh -NoProfile -Command "${PARSE_SCRIPT}" ${driver}`));
  assert.ok(denied(`pwsh -NoProfile -Command "${PARSE_SCRIPT}" ${driver}`, 'PowerShell'));
  assert.ok(denied(`powershell -Command '${PARSE_SCRIPT}' a.ps1`));
  assert.ok(denied("pwsh -Command @'\n$x = 1\nWrite-Host $x\n'@ a.ps1", 'PowerShell'));
  assert.ok(denied('pwsh -Command @"\n$x = 1\n"@ a.ps1', 'PowerShell'));
  assert.ok(denied('cd x\npwsh -c "x" \\\n  a.ps1'));
});

test('a # inside the command text is not a comment', () => {
  assert.ok(denied('pwsh -Command "Write-Host # hi" a.ps1'));
  assert.ok(denied("pwsh -c 'a # b' a.ps1"));
  assert.equal(run('pwsh -c "x" # a.ps1'), null);
});

test('escaped quotes with spaces inside bash -c are followed', () => {
  denyAll(['bash -c "cd x && pwsh -c \\"y z\\" a.ps1"', 'bash -c "pwsh -c \\"a b\\" a.ps1; echo"']);
  assert.ok(denied('powershell -Command "pwsh -c `"y z`" a.ps1"', 'PowerShell'));
  assert.equal(run('bash -c "pwsh -File a.ps1 -c \\"a b\\""'), null);
});

test('a <<< here-string is not a heredoc, so a later pwsh segment is still scanned', () => {
  assert.ok(denied('cat <<< x\npwsh -c "x" a.ps1'));
  assert.ok(denied('cat <<<x\npwsh -c "x" a.ps1'));
  assert.equal(run('cat <<< x\npwsh -File a.ps1'), null);
});

test('Start-Process -ArgumentList: bare command text in one string passes, quoted items are denied', () => {
  allowAll(['Start-Process pwsh -ArgumentList "-c Get-Date a.ps1"', 'Start-Process -FilePath pwsh -ArgumentList "-c x a.ps1" -Wait'], 'PowerShell');
  assert.ok(denied("Start-Process pwsh -ArgumentList '-c','x','a.ps1'", 'PowerShell'));
});

test('wrappers and substitutions are unwrapped', () => {
  denyAll([
    'cmd.exe /c "pwsh -c \\"x\\" a.ps1"', 'cmd /c pwsh -c "x" a.ps1', 'echo $(pwsh -c "x" a.ps1)', 'echo `pwsh -c "x" a.ps1`',
    'echo "$(pwsh -c \'x\' a.ps1)"', 'nohup pwsh -c "x" a.ps1', 'sudo pwsh -c "x" a.ps1', 'sudo -E nohup pwsh -c "x" a.ps1',
    'powershell -Command "& { pwsh -c \'x\' a.ps1 }"', '& { pwsh -c "x" a.ps1 }', 'FOO=1 pwsh -c "x" a.ps1', 'time pwsh -c "x" a.ps1',
    'wsl pwsh -c "x" a.ps1', 'start pwsh -c "x" a.ps1', "iex \"pwsh -c 'x' a.ps1\"", "Invoke-Expression 'pwsh -c \"x\" a.ps1'",
    "Start-Process pwsh -ArgumentList '-c','x','a.ps1'",
    'xargs pwsh -c "x" a.ps1', 'bash -lc "pwsh -c \'x\' a.ps1"',
  ]);
  allowAll(['cmd /c echo a.ps1', 'echo $(pwsh -File a.ps1)', "Start-Process pwsh -ArgumentList '-File','a.ps1'"]);
});

test('review 8: wrapper flags with values are skipped', () => {
  denyAll(['sudo -u deploy pwsh -c "x" a.ps1', 'sudo --user deploy pwsh -c "x" a.ps1', 'env -u HOME pwsh -c "x" a.ps1', 'nice -n 5 pwsh -c "x" a.ps1', 'sudo -u deploy -E nohup pwsh -c "x" a.ps1']);
  allowAll(['sudo -u deploy pwsh -File a.ps1', 'sudo -u deploy echo a.ps1']);
});

test('a redirect target named .ps1 is not an argument', () => {
  allowAll([
    'pwsh -Command "x" > out.ps1', 'pwsh -Command "x" >a.ps1', 'pwsh -c "echo hi" 2> a.ps1', 'pwsh -c "x" >> a.ps1',
    'pwsh -c "x" < a.ps1', 'pwsh -c "x" 2>&1 > a.ps1', 'pwsh -c "x" &> a.ps1',
  ]);
  denyAll(['pwsh -c "x" > out.txt a.ps1', 'pwsh -c "x" 2>&1 a.ps1']);
});

test('rule 3: bare command text passes, quoted command text is denied (review 2)', () => {
  allowAll(['pwsh -NoProfile -Command Get-Content a.ps1', 'powershell -c Test-Path x.ps1', 'pwsh -c x a.ps1', 'sudo pwsh -c x a.ps1']);
  allowAll(['pwsh -NoProfile -Command Get-Content a.ps1', 'powershell -c Test-Path x.ps1'], 'PowerShell');
  denyAll(['pwsh -Command "Get-Content" a.ps1', "pwsh -c 'Test-Path' x.ps1"]);
});

test('review 1: a backtick or $( in quoted text scans only the substitution span', () => {
  allowAll([
    'git commit -m "docs: guard blocks `pwsh -Command "x" a.ps1` calls"',
    'git commit -m "title with `code`\n\npwsh -c "x" a.ps1"',
    'git commit -m "uses `bash` here\npwsh -c \'x\' a.ps1 in prose"',
    'echo "a $(date) b pwsh -c \\"x\\" a.ps1"',
  ]);
  denyAll(['echo "now $(pwsh -c \'x\' a.ps1) done"', 'echo "now `pwsh -c \'x\' a.ps1` done"']);
  allowAll(['echo "docs: `pwsh -c \'x\' a.ps1` here"'], 'PowerShell');
  denyAll(['echo "now $(pwsh -c \'x\' a.ps1) done"'], 'PowerShell');
});

test('review 3: an odd quote or an open quote allows, no fallback over the raw text', () => {
  allowAll([
    "git commit -m \"$(cat <<'EOF'\nfix: a 5\" gap\npwsh -c foo a.ps1\nEOF\n)\"",
    'echo "oops\npwsh -c "x" a.ps1',
    'git commit -m "5" odd" quotes\npwsh -c foo a.ps1',
    'echo "oops; pwsh -c "x" a.ps1',
    'pwsh -c "x" a.ps1; echo "open',
  ]);
});

test('review 4: backslash is a plain character in PowerShell, an escape in Bash', () => {
  denyAll(['Get-ChildItem "D:\\AgentPipeline\\"; pwsh -c "x" a.ps1', 'ls "D:\\x\\" ; pwsh -c "x" a.ps1'], 'PowerShell');
  allowAll(['Get-ChildItem "D:\\AgentPipeline\\" -Filter a.ps1', 'Set-Location "D:\\x\\"; Get-Content a.ps1'], 'PowerShell');
  allowAll(['echo "say \\"pwsh -c x a.ps1\\""']);
  const ps = lex('ls "D:\\x\\" ; echo hi', 'PowerShell');
  assert.equal(ps.open, false);
  assert.equal(ps.segments.length, 2);
  assert.equal(lex('ls "D:\\x\\" ; echo hi', 'Bash').open, true);
});

test('review 5: << is a heredoc only in Bash and not inside $(( ))', () => {
  denyAll(['echo $((1<<3)); pwsh -c "x" a.ps1\necho hi', 'x=$((1 << 3))\npwsh -c "x" a.ps1']);
  denyAll(['$a = 1 -shl 2; $b = "<<EOF"\npwsh -c "x" a.ps1', '[int]$x = 1<<3\npwsh -c "x" a.ps1'], 'PowerShell');
  allowAll(["cat <<'EOF'\npwsh -c \"x\" a.ps1\nEOF\necho done"]);
  assert.equal(lex('cat <<EOF\nbody\nEOF\necho', 'Bash').segments.length, 2);
  assert.equal(lex('cat <<EOF\nbody\nEOF\necho', 'PowerShell').segments.length, 4);
});

test('review 6: a backtick continuation in PowerShell joins lines, in Bash it separates', () => {
  assert.ok(denied('pwsh -c "x" `\n a.ps1', 'PowerShell'));
  assert.ok(denied('pwsh `\n  -c "x" `\n  a.ps1', 'PowerShell'));
  assert.equal(lex('pwsh -c "x" `\n a.ps1', 'PowerShell').segments.length, 1);
  assert.equal(lex('echo `date`', 'Bash').segments.length, 2);
  assert.equal(run('Write-Host a`;b; Get-Content a.ps1', 'PowerShell'), null);
});

test('review 7: an apostrophe always opens a quote, even after a letter', () => {
  const lexed = lex("git commit -m'msg ; pwsh -c x a.ps1'", 'Bash');
  assert.equal(lexed.open, false);
  assert.equal(lexed.segments.length, 1);
  allowAll(["git commit -m'msg ; pwsh -c \"x\" a.ps1'", 'echo it\'s done; pwsh -c "x" a.ps1', 'echo don\'t && pwsh -c "x" a.ps1']);
  allowAll(['git commit -m "it\'s about pwsh -c x a.ps1"', "echo it's pwsh -c \"x\" a.ps1"]);
  denyAll(["echo 'it'; pwsh -c \"x\" a.ps1", "echo it''s; pwsh -c \"x\" a.ps1"]);
});

test('mentions in multi-line commands, heredoc bodies and comments pass', () => {
  allowAll([
    'git commit -m "line one\npwsh -c \'x\' a.ps1\nline three"', "cat <<'EOF' > notes.md\nit's pwsh -c \"x\" a.ps1\nEOF\necho done",
    'cat <<-EOF\n\tpwsh -c "x" a.ps1\n\tEOF', '# pwsh -c "x" a.ps1\necho hi', 'grep -rn "pwsh -c" . | grep a.ps1',
  ]);
});

test('the deny reason says the check is conservative and names the alternatives', () => {
  assert.ok(denied('pwsh -c "Get-Content" a.ps1'));
  const reason = run('pwsh -c "Get-Content" a.ps1').hookSpecificOutput.permissionDecisionReason;
  assert.match(reason, /deliberately conservative/);
  assert.match(reason, /-Command "Get-Content a\.ps1"/);
  assert.match(reason, /-File <script>\.ps1/);
  assert.match(reason, /node ~\/\.claude\/skills\/feedback-loop\/ps-parse\.mjs <files>/);
});

test('safe forms pass', () => {
  allowAll([
    'pwsh -File a.ps1', 'pwsh -NoProfile -File a.ps1 -Param x', 'powershell -f a.ps1',
    'node ~/.claude/skills/feedback-loop/ps-parse.mjs a.ps1 b.ps1',
    'pwsh -Command "& ./a.ps1"', 'pwsh -Command "./a.ps1 -x 1"', "pwsh -c './a.ps1'", 'pwsh -c ./a.ps1',
    'pwsh -Command "Get-Date"', 'pwsh -c "x" a.txt', 'pwsh -NoProfile a.ps1', 'bash -c "echo hi" a.ps1',
    'pwsh -File a.ps1 -Command x',
  ]);
});

test('text that merely mentions the pattern passes', () => {
  allowAll([
    'git commit -m "deny pwsh -Command x a.ps1"', 'grep -n "pwsh -Command .* a.ps1" skills/x.md',
    'echo pwsh -c "x" a.ps1', 'cat <<EOF\npwsh -c "x" a.ps1\nEOF', 'git commit -m "x" -- a.ps1', '',
  ]);
});

test('nesting is capped and a deep command does not hang or throw', () => {
  const deep = 'pwsh -c "x" a.ps1';
  let nested = deep;
  for (let i = 0; i < 6; i++) nested = `bash -c '${nested.replace(/'/g, "'\\''")}'`;
  assert.doesNotThrow(() => run(nested));
  assert.equal(run('echo ' + '$('.repeat(50) + 'x' + ')'.repeat(50)), null);
});

test('as a hook process: denies on stdin JSON, silent for a safe call, fails open on bad input', () => {
  const call = (stdin) => spawnSync(process.execPath, [SCRIPT], { input: stdin, encoding: 'utf8' });
  const bad = call(JSON.stringify({ tool_input: { command: 'pwsh -c "x" a.ps1' } }));
  assert.equal(JSON.parse(bad.stdout).hookSpecificOutput.permissionDecision, 'deny');
  assert.equal(call(JSON.stringify({ tool_input: { command: 'pwsh -File a.ps1' } })).stdout, '');
  const broken = call('not json');
  assert.equal(broken.status, 0);
  assert.equal(broken.stdout, '');
});
