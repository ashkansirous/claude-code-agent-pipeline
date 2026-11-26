// node --test skills/feedback-loop/shell-write-guard.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { shellWriteForm, decide, sedFlipsCrlf } from './shell-write-guard.mjs';

const HOOK = fileURLToPath(new URL('./shell-write-guard.mjs', import.meta.url));
const denied = (command, tool) => assert.notEqual(shellWriteForm(command, tool), null, command);
const allowed = (command, tool) => assert.equal(shellWriteForm(command, tool), null, command);

test('refuses an unquoted heredoc with a backslash written to a file', () => {
  denied('cat > f.txt <<EOF\nline\\nnext\nEOF');
  denied('cat <<EOF > f.txt\nC:\\Users\\x\nEOF');
  denied('cat >> f.txt <<EOF\na\\b\nEOF');
  denied('tee f.txt <<EOF\na\\b\nEOF');
  denied('cat <<-EOF > f.txt\n\ta\\b\n\tEOF');
  denied('cat <<EOF | tee f.txt\na\\b\nEOF');
});

test('allows a quoted-tag heredoc: backslashes stay literal', () => {
  allowed("cat > f.txt <<'EOF'\nline\\nnext C:\\Users\\x\nEOF");
  allowed('cat > f.txt <<"EOF"\na\\b\nEOF');
  allowed('cat > f.txt <<\\EOF\na\\b\nEOF');
  allowed("cat <<'EOF' | tee f.txt\na\\b\nEOF");
});

test('refuses a heredoc body with a raw control character written to a file', () => {
  denied("cat > f.txt <<'EOF'\nline\rnext\nEOF");
  denied("cat > f.txt <<'EOF'\nbell\x07\nEOF");
});

test('allows a heredoc body without a backslash, tabs and a CRLF-only command', () => {
  allowed("cat > f.txt <<'EOF'\nplain\ttext\nEOF");
  allowed("cat > f.txt <<'EOF'\r\nplain\r\nEOF\r\n");
});

test('allows heredocs fed to commands that do not write a file', () => {
  allowed("git commit -F - <<'EOF'\nfix a\\b path\nEOF");
  allowed("gh pr create --body-file - <<'EOF'\nsee D:\\x\\y\nEOF");
  allowed("git commit -m \"$(cat <<'EOF'\nmsg with \\n\nEOF\n)\"");
  allowed("node <<'EOF'\nconsole.log('a\\nb')\nEOF");
  allowed("python - <<'EOF'\nprint('a\\nb')\nEOF");
  allowed("cat <<'EOF' > /dev/null\na\\b\nEOF");
  allowed("node - <<'EOF' 2>&1\nconsole.log('a\\nb')\nEOF");
});

test('allows a heredoc that feeds an interpreter whatever its output goes to', () => {
  allowed("python - <<'EOF' > out.json\nprint('a\\nb')\nEOF");
  allowed("python3 - <<EOF > out.json\nprint('a\\nb')\nEOF");
  allowed("node - <<EOF | tee log.txt\nconsole.log('a\\nb')\nEOF");
  allowed("py - <<EOF >> out.txt\nprint('a\\nb')\nEOF");
  allowed("bash <<EOF > out.txt\necho a\\\\b\nEOF");
  allowed("sh <<EOF > out.txt\necho a\\\\b\nEOF");
  allowed("pwsh <<EOF > out.txt\nWrite-Output 'a\\b'\nEOF");
  allowed("git commit -F - <<EOF 2>&1 | tee commit.log\nfix a\\b\nEOF");
});

test('refuses sed -i only when the replacement side holds a backslash', () => {
  denied("sed -i 's/a/b\\n/' file.txt");
  denied("sed -i.bak 's/a/\\t/' file.txt");
  denied("sed -i'' 's/a/\\r/' file.txt");
  denied("sed --in-place 's/a/b\\c/' file.txt");
  denied("sed -ni 's|a|b\\n|p' file.txt");
});

test('allows sed -i with a backslash only in the regex, and other sed forms', () => {
  allowed("sed -i 's/\\.md$/.txt/' *.md");
  allowed("sed -i.bak -e 's/\\r$//' file.txt");
  allowed("sed --in-place 's/a\\/b/c/' file.txt");
  allowed("sed -i 's/a/b\\/c/' file.txt");
  allowed("sed -i 's/a/b/' file.txt");
  allowed("sed -i'' 's/\\d/x/' file.txt");
  allowed("sed -n '/a\\|b/p' file.txt");
  allowed("sed 's/a/\\r/' file.txt");
  allowed("grep -i foo f | sed 's/a/\\r/'");
  allowed("grep -i 'a\\|b' docs/sed-usage.md");
  allowed('grep -rin sed src\\foo');
  allowed('git commit -m "never run sed -i with a \\ in it"');
});

test('refuses perl only with -i', () => {
  allowed("perl -pi -e 's/\\r//' file.txt");
  allowed("perl -pi -e 's/\\s+$//' file.txt");
  denied("perl -pi -e 's/x/\\t/' file.txt");
  denied("perl -i -pe 's/x/\\t/' file.txt");
  denied("perl -i.bak -pe 's/x/\\t/' file.txt");
  allowed("perl -e 'print qq(a\\n)'");
  allowed("perl -Mstrict -e 'print qq(a\\n)'");
  allowed("perl -Mwarnings -MFile::Basename -e 'print qq(a\\n)'");
  allowed("perl -ne 'print if /\\d+/' file.txt");
});

test('cs393-check3-medium: perl switch bundles containing i are in-place, -Mstrict and -e are not', () => {
  denied("perl -wpi -e 's/x/\\t/' file.txt");
  denied("perl -pie 's/x/\\t/' file.txt");
  denied("perl -ie 's/x/\\t/' file.txt");
  denied("perl -lpi.bak -e 's/x/\\t/' file.txt");
  denied("perl -in -e 's/x/\\t/' file.txt");
  denied("perl -il -e 's/x/\\t/' file.txt");
  allowed("perl -vi -e 's/x/\\t/' file.txt");
  allowed("perl -ci -e 's/x/\\t/' file.txt");
  allowed("perl -Mstrict -e 'print qq(a\\n)'");
  allowed("perl -wne 'print qq(a\\n)' file.txt");
});

test('cs393-check3-medium: sed --expression=/--file= supply the script, so the next plain word is a file', async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'swg-sed-'));
  fs.writeFileSync(path.join(dir, 'crlf.txt'), 'a\r\nb\r\n');
  fs.writeFileSync(path.join(dir, 'lf.txt'), 'a\nb\n');
  assert.equal(sedFlipsCrlf("sed -i --expression='s/a/b/' crlf.txt", dir), true);
  assert.equal(sedFlipsCrlf("sed -i --file=script.sed crlf.txt", dir), true);
  assert.equal(sedFlipsCrlf("sed -i 's/a/b/' crlf.txt", dir), true);
  assert.equal(sedFlipsCrlf("sed -i --expression='s/a/b/' lf.txt", dir), false);
});

test('allows back-references and \\& in a sed or perl replacement, still denies other backslashes', () => {
  allowed("sed -i -E 's/(a)b/\\1c/' f");
  allowed("sed -i 's/a/[\\&]/' f");
  allowed("perl -pi -e 's/(a)b/\\1c/' f");
  denied("sed -i -E 's/(a)b/\\1\\n/' f");
});

test('echo text counts only when the echo itself is redirected or piped straight into tee', () => {
  allowed('echo "a\\b" | wc -c > n.txt');
  allowed('echo "x\\y" | sed s/x/z/ > out.txt');
  denied('echo "a\\b" > n.txt | cat');
  denied('echo "a\\b" | tee out.txt | cat');
});

test('stderr, stdout and tty are not files', () => {
  allowed('echo "a\\b" > /dev/stderr');
  allowed('echo "a\\b" >> /dev/stdout');
  allowed('echo "a\\b" | tee /dev/stderr');
  denied('echo "a\\b" > /dev/stderrx');
});

test('refuses echo redirected to a file with a backslash', () => {
  denied('echo "a\\tb" >> f.txt');
  denied("echo 'a\\b' | tee f.txt");
  denied("cd x && echo 'a\\n' > f.txt");
  denied("echo 'a\\n' &> f.txt");
  denied("echo 'a\\n' >| f.txt");
  denied("echo 'a\\n' > nul.txt");
});

test('allows printf, echo to the terminal, /dev/null, nul or without a backslash', () => {
  allowed("printf 'a\\nb\\n' > f.txt");
  allowed("printf '%s\\n' \"$msg\" >> notes.md");
  allowed("printf 'a\\nb\\n'");
  allowed("echo 'a\\b' > /dev/null");
  allowed("echo 'a\\b' &> /dev/null");
  allowed("echo 'a\\b' > nul");
  allowed("echo 'a\\n' 2>&1");
  allowed("echo 'plain' > f.txt");
  allowed('echo hi | tee /dev/null');
  allowed('echo a=>b\\c');
  allowed('echo "a\\nb" > f.txt', 'PowerShell');
});

test('refuses drive paths the shell or the tool rewrites', () => {
  denied('echo C:\\Users\\x > f.txt');
  denied("sed -i 's/a/C:\\Users\\x/' file.txt");
  denied("sed -i 's/a/D:\\x\\y/' f.md");
  denied("python -c \"open('D:\\new.txt','w').write('a')\"");
  denied('echo -e "C:\\new" > f.txt');
  denied('echo "C:\\x\\$HOME" > f.txt');
  denied('echo "C:\\x\\\\y" > f.txt');
  denied("echo $'C:\\tmp' > f.txt");
});

test('allows an echo of a quoted Windows drive path', () => {
  allowed('echo "see C:\\Users\\x\\y" > f.txt');
  allowed("echo 'paths: C:\\a and D:\\b' >> f.txt");
});

test('refuses python -c and node -e one-liners that write a file with a backslash', () => {
  denied("python -c \"open('f.txt','w').write('a\\nb')\"");
  denied("python3 -c \"from pathlib import Path; Path('f').write_text('a\\\\b')\"");
  denied("python3.11 -c \"from pathlib import Path; Path('f').write_text('a\\\\b')\"");
  denied("python -X utf8 -c \"open('f','a').write('a\\nb')\"");
  denied("py -3 -c \"open('f','w').write('a\\nb')\"");
  denied("node -e \"require('fs').writeFileSync('f.txt','a\\nb')\"");
  denied("node -e \"require('fs').appendFileSync('f.txt','a\\\\b')\"");
  denied("node --no-warnings -e \"require('fs').writeFileSync('f.txt','a\\nb')\"");
});

test('allows one-liners that print, write to stdout, read or write plain text', () => {
  allowed("python -c \"print('a\\nb')\"");
  allowed("node -e \"console.log('a\\nb')\"");
  allowed("node -e \"process.stdout.write('a\\n')\"");
  allowed("python -c \"import sys; sys.stdout.write('x\\n')\"");
  allowed("python -c \"import sys; sys.stdout.buffer.write(b'a\\n')\"");
  allowed("node -e \"require('fs').writeFileSync('f.txt','plain')\"");
  allowed("python -c \"open('f.txt','r').read()\"");
});

test('refuses a PowerShell expandable here-string with a backtick written to a file', () => {
  denied('@"\na`nb\n"@ | Set-Content f.txt', 'PowerShell');
  denied('Set-Content -Path f.txt -Value @"\na`tb\n"@', 'PowerShell');
  denied('@"\na`0b\n"@ >> f.txt', 'PowerShell');
  denied('@"\na`rb\n"@ | Add-Content f.txt', 'PowerShell');
});

test('allows single-quoted here-strings and here-strings not written in their own statement', () => {
  allowed("@'\nC:\\x\\y\n'@ | Set-Content f.txt", 'PowerShell');
  allowed("Set-Content -Path notes.md -Value @'\nsee C:\\Users\\x\n'@", 'PowerShell');
  allowed("@'\na\\b\n'@ >> f.txt", 'PowerShell');
  allowed('@"\na\\b\n"@ | Set-Content f.txt', 'PowerShell');
  allowed("git commit -m @'\nfix a\\b\n'@", 'PowerShell');
  allowed('git commit -m @"\nfix a`nb\n"@; dotnet build 2>&1 | Out-File log.txt', 'PowerShell');
  allowed('git commit -m @"\nfix a`nb\n"@\ndotnet build > log.txt', 'PowerShell');
  allowed('@"\na`nb\n"@ > $null', 'PowerShell');
  allowed('Write-Output @"\na`nb\n"@', 'PowerShell');
  allowed('gh pr create --body @"\nfix a`nb\n"@ 2>&1 | Out-File log.txt', 'PowerShell');
  allowed('git commit -m @"\nfix a`nb\n"@ > log.txt', 'PowerShell');
});

test('allows Windows paths in ordinary commands', () => {
  allowed('cd D:\\x');
  allowed('git -C D:\\x status');
  allowed('dotnet build D:\\ReadTheStupidText\\src\\App.csproj > D:\\tmp\\log.txt');
  allowed('echo done > /dev/null');
});

test('decide returns the deny shape for Bash and PowerShell and ignores other tools', () => {
  const bash = decide({ tool_name: 'Bash', tool_input: { command: "echo 'a\\n' > f.txt" } });
  assert.equal(bash.hookSpecificOutput.hookEventName, 'PreToolUse');
  assert.equal(bash.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(bash.hookSpecificOutput.permissionDecisionReason, /Write or Edit tool/);
  assert.match(bash.hookSpecificOutput.permissionDecisionReason, /echo/);
  assert.equal(decide({ tool_name: 'PowerShell', tool_input: { command: '@"\na`nb\n"@ | Set-Content f' } }).hookSpecificOutput.permissionDecision, 'deny');
  assert.equal(decide({ tool_name: 'PowerShell', tool_input: { command: "echo 'a\\n' > f" } }), null);
  assert.equal(decide({ tool_name: 'Write', tool_input: { command: "echo 'a\\n' > f" } }), null);
  assert.equal(decide({ tool_name: 'Bash', tool_input: {} }), null);
});

test('hook entry point prints a deny, stays silent on a pass and fails open on bad input', () => {
  const run = (input) => spawnSync(process.execPath, [HOOK], { input, encoding: 'utf8' });
  const refused = run(JSON.stringify({ tool_name: 'Bash', tool_input: { command: "echo 'a\\n' > f.txt" } }));
  assert.equal(JSON.parse(refused.stdout).hookSpecificOutput.permissionDecision, 'deny');
  assert.equal(run(JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'ls' } })).stdout, '');
  const garbage = run('garbage');
  assert.equal(garbage.status, 0);
  assert.match(garbage.stderr, /shell-write-guard/);
});

test('refuses a heredoc appended to a CRLF file, allows LF files, new files and overwrites', async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'swg-'));
  fs.writeFileSync(path.join(dir, 'crlf.py'), 'a\r\nb\r\n');
  fs.writeFileSync(path.join(dir, 'lf.py'), 'a\nb\n');
  const bash = (command) => decide({ tool_name: 'Bash', cwd: dir, tool_input: { command } });
  const isDenied = (verdict) => verdict?.hookSpecificOutput?.permissionDecision === 'deny';
  assert.ok(isDenied(bash("cat >> crlf.py <<'EOF'\nx\nEOF")));
  assert.ok(isDenied(bash("cd / && cat >> " + JSON.stringify(path.join(dir, 'crlf.py')) + " <<'EOF'\nx\nEOF")));
  assert.ok(isDenied(bash("tee -a crlf.py <<'EOF'\nx\nEOF")));
  assert.match(bash("cat >> crlf.py <<'EOF'\nx\nEOF").hookSpecificOutput.permissionDecisionReason, /CRLF/);
  assert.equal(bash("cat >> lf.py <<'EOF'\nx\nEOF"), null);
  assert.equal(bash("cat >> new.py <<'EOF'\nx\nEOF"), null);
  assert.equal(bash("cat > crlf.py <<'EOF'\nx\nEOF"), null);
  assert.equal(bash("python - >> crlf.py <<'EOF'\nprint(1)\nEOF"), null);
  assert.equal(bash("echo x >> crlf.py; cat <<'EOF' > other.txt\ny\nEOF"), null);
});

test('Slice 307: inline Python writing only under tmp/ or the OS temp dir passes; other or unknown targets are refused', () => {
  for (const command of [
    "python -c \"open('tmp/out.csv','w').write('a')\"",
    "python3 -c \"from pathlib import Path; Path('./tmp/o.txt').write_text('x')\"",
    "python -c \"open('C:/Users/x/AppData/Local/Temp/o.csv','w').write('a')\"",
    "python -c \"import tempfile; open(tempfile.gettempdir()+'x','w').write('a')\"",
    "python3 - <<'EOF'\nopen('tmp/a.csv', 'w').write('x')\nEOF",
  ]) assert.equal(decide({ tool_name: 'Bash', tool_input: { command } }), null, command);
  for (const command of [
    "python -c \"open('tmp/o.csv','w'); open('src/A.cs','w')\"",
    "python -c \"open(sys.argv[1],'w').write('a')\"",
    "python3 - <<'EOF'\nopen('src/A.cs', 'w').write('x')\nEOF",
    // Finding 10: tmp/temp deeper in a repo path is not scratch.
    "python -c \"open('src/tmp/A.cs','w').write('a')\"",
    "python -c \"open('src/temp/A.cs','w').write('a')\"",
  ]) assert.ok(decide({ tool_name: 'Bash', tool_input: { command } }), command);
});

// Verified 2026-11-07 on this host (Git for Windows' msys sed 4.9): `printf 'a\r\nb\r\n' > f; sed -i 's/a/x/' f` leaves `x\nb\n`.
// Plain GNU sed on Linux keeps the CR, so this evidence only holds on Windows.
test('Slice 307: Git for Windows sed -i really flips CRLF to LF (evidence behind the refusal; Windows only)', async (t) => {
  if (process.platform !== 'win32') return t.skip('the CRLF flip is a Git-for-Windows sed behaviour');
  const { spawnSync } = await import('node:child_process');
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const version = spawnSync('sed', ['--version'], { encoding: 'utf8' });
  if (version.status !== 0 || !/GNU sed/.test(version.stdout)) return t.skip('no GNU sed');
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'swg-flip-')), 'f.txt');
  fs.writeFileSync(file, 'a\r\nb\r\n');
  const run = spawnSync('sed', ['-i', 's/a/x/', file.replaceAll('\\', '/')], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(fs.readFileSync(file, 'utf8').startsWith('x'), true);
  assert.equal(fs.readFileSync(file, 'utf8').includes('\r'), false);
});

test('Slice 307: sed -i on an existing CRLF file is refused (GNU sed flips it to LF); LF and new files pass', async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'swg-sed-'));
  fs.writeFileSync(path.join(dir, 'crlf.cs'), 'a one\r\nb two\r\n');
  fs.writeFileSync(path.join(dir, 'lf.cs'), 'a one\nb two\n');
  const bash = (command) => decide({ tool_name: 'Bash', cwd: dir, tool_input: { command } });
  const isDenied = (verdict) => verdict?.hookSpecificOutput?.permissionDecision === 'deny';
  for (const command of ["sed -i 's/one/1/' crlf.cs", "sed -i.bak 's/one/1/' crlf.cs", "sed -i -e 's/one/1/' -e 's/two/2/' crlf.cs", "sed -n -i -E 's/one/1/' lf.cs crlf.cs", "sed -ie 's/one/1/' crlf.cs", "sed -is 's/one/1/' crlf.cs", "sed -ni 's/one/1/' crlf.cs", "cd /&& sed -i 's/one/1/' " + JSON.stringify(path.join(dir, 'crlf.cs'))]) {
    assert.ok(isDenied(bash(command)), command);
  }
  assert.match(bash("sed -i 's/one/1/' crlf.cs").hookSpecificOutput.permissionDecisionReason, /CRLF/);
  for (const command of ["sed -i 's/one/1/' lf.cs", "sed -i 's/one/1/' missing.cs", "sed 's/one/1/' crlf.cs", "sed -n '1p' crlf.cs", "grep -i one crlf.cs", "sed -input 's/one/1/' crlf.cs", "sed -i 's/crlf.cs/x/' lf.cs"]) {
    assert.equal(bash(command), null, command);
  }
});

test('Slice 307: inline Python that writes a file is refused (python -c and a python heredoc); reads and stdout pass', () => {
  for (const command of [
    "python -c \"open('f.txt','w').write('ab')\"",
    "python3 -c \"from pathlib import Path; Path('f').write_text('ab')\"",
    "python3 - <<'EOF'\nfrom pathlib import Path\nPath('f.cs').write_text('x')\nEOF",
    "cd x && py -3 - <<'EOF'\nwith open('f.cs', 'a') as h:\n    h.write('x')\nEOF",
    "python - <<EOF > out.log\nopen('f','wb').write(b'x')\nEOF",
  ]) {
    denied(command);
  }
  for (const command of [
    "python -c \"print(open('f.txt').read())\"",
    "python -c \"open('f.txt','r').read()\"",
    "python3 - <<'EOF'\nprint(open('f.txt').read())\nEOF",
    "python3 - <<'EOF'\nimport sys\nsys.stdout.write('x')\nEOF",
    "python script.py",
    "node -e \"console.log(1)\"",
  ]) {
    allowed(command);
  }
  const verdict = decide({ tool_name: 'Bash', tool_input: { command: "python -c \"open('f','w').write('x')\"" } });
  assert.equal('permissionDecision' in verdict.hookSpecificOutput, false);
  assert.match(verdict.hookSpecificOutput.additionalContext, /Edit or Write/);
  const variable = decide({ tool_name: 'Bash', tool_input: { command: "python -c \"import sys; open(sys.argv[1],'w').write('x')\" tmp/o.txt" } });
  assert.equal('permissionDecision' in variable.hookSpecificOutput, false);
});

test('Slice 315: a python or node heredoc that writes a literal repo path warns (advisory, never a deny); scratch and reads stay quiet', () => {
  const verdict = (command) => decide({ tool_name: 'Bash', cwd: 'D:/x', tool_input: { command } })?.hookSpecificOutput;
  for (const command of [
    "python -I - <<'EOF'\nfrom pathlib import Path\nPath('plan.md').write_text('x')\nEOF",
    "python3 - <<'EOF'\nwith open('src/A.cs', 'w') as h:\n    h.write('x')\nEOF",
    "node - <<'EOF'\nrequire('fs').writeFileSync('docs/a.md', 'x')\nEOF",
    "node <<'EOF'\nconst fs = require('fs'); fs.appendFileSync(\"CLAUDE.md\", 'x');\nEOF",
  ]) {
    const out = verdict(command);
    assert.equal('permissionDecision' in out, false, command);
    assert.match(out.additionalContext, /advisory, the call is allowed/, command);
    assert.match(out.additionalContext, /Edit tool|Write or Edit tool/, command);
  }
  for (const command of [
    "python - <<'EOF'\nopen('tmp/a.csv', 'w').write('x')\nEOF",
    "node - <<'EOF'\nrequire('fs').writeFileSync('tmp/out.json', '{}')\nEOF",
    "node - <<'EOF'\nconsole.log(require('fs').readFileSync('plan.md', 'utf8'))\nEOF",
    "python - <<'EOF'\nprint(open('plan.md').read())\nEOF",
  ]) assert.equal(verdict(command), undefined, command);
});

test('Slice 315: a node heredoc writing to a variable path warns (advisory) and an interpreter heredoc without a file write stays quiet', () => {
  const out = decide({ tool_name: 'Bash', cwd: 'D:/x', tool_input: { command: "node - <<'EOF'\nrequire('fs').writeFileSync(process.argv[2], 'x')\nEOF" } }).hookSpecificOutput;
  assert.equal('permissionDecision' in out, false);
  assert.match(out.additionalContext, /writes a file/);
  assert.equal(decide({ tool_name: 'Bash', cwd: 'D:/x', tool_input: { command: "node - <<'EOF'\nconsole.log(1)\nEOF" } }), null);
});

test('Slice 307 (two strikes): the inline-Python rule is advisory: the hook allows, warns and logs, never denies', async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const log = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'swg-adv-')), 'logs', 'advisory-hooks.log');
  const input = JSON.stringify({ tool_name: 'Bash', cwd: 'D:/x', tool_input: { command: "python -c \"open('f','w').write('x')\"" } });
  const run = spawnSync(process.execPath, [HOOK], { input, encoding: 'utf8', env: { ...process.env, ADVISORY_HOOKS_LOG: log } });
  const out = JSON.parse(run.stdout).hookSpecificOutput;
  assert.equal('permissionDecision' in out, false);
  assert.match(out.additionalContext, /inline Python/);
  const [time, hook, cwd, reason] = fs.readFileSync(log, 'utf8').trim().split('\t');
  assert.ok(!Number.isNaN(Date.parse(time)));
  assert.deepEqual([hook, cwd], ['shell-write-guard', 'D:/x']);
  assert.match(reason, /inline Python/);
});

test('Slice 307: hard denies in the same command as advisory inline Python still deny', async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'swg-mix-'));
  fs.writeFileSync(path.join(dir, 'crlf.cs'), 'a one\r\nb two\r\n');
  const py = "python -c \"open('f','w').write('x')\"";
  const bash = (command) => decide({ tool_name: 'Bash', cwd: dir, tool_input: { command } });
  const decision = (command) => bash(command)?.hookSpecificOutput?.permissionDecision;
  assert.equal(decision(`${py} && sed -i 's/one/1/' crlf.cs`), 'deny');
  assert.equal(decision(`${py} && cat >> crlf.cs <<'EOF'\nx\nEOF`), 'deny');
  assert.equal(decision(`${py} && echo "a\\b" > f.txt`), 'deny');
  assert.equal(decision(py), undefined);
  assert.ok(bash(py));
});

// Slice 315 round 2: one scratch rule, by construction: absolute path under <worktree root>/tmp|temp or the OS temp dir.
test('scratch rule: absolute worktree tmp, relative tmp and OS temp pass; src/tmp does not', async () => {
  const { dirname, join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const root = spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd: dirname(HOOK), encoding: 'utf8' }).stdout.trim();
  const verdict = (code, cwd = root) => decide({ tool_name: 'Bash', cwd, tool_input: { command: `python -c "${code}"` } });
  const slashed = (p) => p.replaceAll('\\', '/');
  assert.equal(verdict(`open('${slashed(join(root, 'tmp', 'out.json'))}','w').write('a')`), null, 'absolute worktree tmp');
  assert.equal(verdict(`open('tmp/out.json','w').write('a')`), null, 'relative tmp');
  assert.equal(verdict(`open('${slashed(join(tmpdir(), 'o.txt'))}','w').write('a')`), null, 'OS temp');
  assert.ok(verdict(`open('src/tmp/A.cs','w').write('a')`), 'src/tmp is repo code');
  assert.ok(verdict(`open('${slashed(join(root, 'src', 'tmp', 'A.cs'))}','w').write('a')`), 'absolute src/tmp');
  assert.ok(verdict(`open('tmp/../src/A.cs','w').write('a')`), 'dot-dot escape');
});

// Slice 315 check 3: a slow or failing git falls back to the cwd as the root (no hang, no throw).
test('worktreeRoot: git timeout or error falls back to null (cwd is then the root)', async () => {
  const { worktreeRoot } = await import('./shell-write-guard.mjs');
  const timedOut = () => ({ error: Object.assign(new Error('spawnSync git ETIMEDOUT'), { code: 'ETIMEDOUT' }), status: null, stdout: '' });
  assert.equal(worktreeRoot('/fake/slow-git-cwd', timedOut), null);
  assert.equal(worktreeRoot('/fake/failing-git-cwd', () => ({ status: 128, stdout: '' })), null);
  let seen;
  worktreeRoot('/fake/opts-cwd', (cmd, args, opts) => { seen = opts; return { status: 0, stdout: '/r\n' }; });
  assert.equal(seen.timeout, 3000);
});

// Slice 377 item 15: an inline script that rewrites a TRACKED file at a literal path is denied; the same write to scratch, an untracked file or a variable path is not.
test('Slice 377 item 15: inline Python/Node rewriting a tracked file is denied, including a scratch .mjs helper run by name', async (t) => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const { join } = await import('node:path');
  const { execFileSync } = await import('node:child_process');
  // Not under os.tmpdir(): everything there counts as scratch, so every target would pass. The fixture repo lives in the gitignored <repo>/tmp/,
  // under a unique name, and is removed first (a killed earlier run) and in the finally.
  const base = fileURLToPath(new URL(`../../tmp/swg-377-${process.pid}/`, import.meta.url));
  fs.rmSync(base, { recursive: true, force: true });
  fs.mkdirSync(base, { recursive: true });
  try {
  const root = fs.realpathSync(base);
  const git = (...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', env: { ...process.env, GIT_DIR: undefined, GIT_WORK_TREE: undefined, GIT_INDEX_FILE: undefined } });
  git('init', '-q');
  fs.mkdirSync(join(root, 'tools'), { recursive: true });
  fs.mkdirSync(join(root, 'tmp'), { recursive: true });
  fs.writeFileSync(join(root, 'plan.md'), 'x');
  fs.writeFileSync(join(root, 'tools', 'gen.mjs'), "require('fs').writeFileSync('plan.md', 'x')");
  git('add', 'plan.md', 'tools/gen.mjs');
  fs.writeFileSync(join(root, 'tmp', 'fix.mjs'), "import { writeFileSync } from 'node:fs';\nwriteFileSync('plan.md', 'y');\n");
  fs.writeFileSync(join(root, 'tmp', 'note.mjs'), "import { writeFileSync } from 'node:fs';\nwriteFileSync('tmp/out.json', 'y');\n");
  fs.writeFileSync(join(root, 'new.md'), 'untracked');
  const verdict = (command) => decide({ tool_name: 'Bash', cwd: root, tool_input: { command } });
  const isDeny = (command) => verdict(command)?.hookSpecificOutput?.permissionDecision === 'deny';
  assert.ok(isDeny("node - <<'EOF'\nrequire('fs').writeFileSync('plan.md', 'x')\nEOF"), 'node heredoc');
  assert.ok(isDeny("python - <<'EOF'\nopen('plan.md', 'w').write('x')\nEOF"), 'python heredoc');
  assert.ok(isDeny('python -c "open(\'plan.md\',\'w\').write(\'x\')"'), 'python -c');
  assert.ok(isDeny('node -e "require(\'fs\').writeFileSync(\'plan.md\',\'x\')"'), 'node -e');
  assert.ok(isDeny('node tmp/fix.mjs'), 'a .mjs helper that rewrites a tracked file');
  assert.match(verdict('node tmp/fix.mjs').hookSpecificOutput.permissionDecisionReason, /tracked file plan\.md/);
  assert.equal(isDeny('node tmp/note.mjs'), false, 'a helper that writes only scratch');
  assert.equal(isDeny('node tools/gen.mjs'), false, 'a tracked generator is not a helper');
  // Slice 21: the same write through a variable assigned once to a literal path.
  assert.ok(isDeny("python - <<'EOF'\np = 'plan.md'\ns = open(p).read()\nopen(p, 'w').write(s + 'x')\nEOF"), 'python variable path');
  assert.ok(isDeny("python - <<'EOF'\nfrom pathlib import Path\nf = Path('plan.md')\nf.write_text('x')\nEOF"), 'python Path variable');
  assert.ok(isDeny("node - <<'EOF'\nconst f = 'plan.md';\nrequire('fs').writeFileSync(f, 'x')\nEOF"), 'node variable path');
  assert.ok(isDeny('node -e "const f=\'plan.md\'; require(\'fs\').writeFileSync(f,\'x\')"'), 'node -e variable path');
  assert.equal(isDeny("node - <<'EOF'\nconst f = 'new.md';\nrequire('fs').writeFileSync(f, 'x')\nEOF"), false, 'a variable naming an untracked file');
  assert.equal(isDeny("node - <<'EOF'\nlet f = 'plan.md'; f = process.argv[2];\nrequire('fs').writeFileSync(f, 'x')\nEOF"), false, 'a variable assigned twice is not followed');
  assert.equal(isDeny("node - <<'EOF'\nrequire('fs').writeFileSync('new.md', 'x')\nEOF"), false, 'an untracked file');
  assert.equal(isDeny("node - <<'EOF'\nrequire('fs').writeFileSync('tmp/out.json', 'x')\nEOF"), false, 'scratch');
  assert.equal(isDeny("node - <<'EOF'\nrequire('fs').writeFileSync(process.argv[2], 'x')\nEOF"), false, 'a variable path');
  assert.equal(isDeny("node - <<'EOF'\nconsole.log(require('fs').readFileSync('plan.md', 'utf8'))\nEOF"), false, 'a read');
  fs.mkdirSync(join(root, 'docs'), { recursive: true });
  fs.writeFileSync(join(root, 'docs', 'a.md'), 'x');
  git('add', 'docs/a.md');
  assert.ok(isDeny('cd docs && python -c "open(\'a.md\',\'w\').write(\'x\')"'), 'a target resolved against a leading cd');
  assert.equal(isDeny('cd docs && python -c "open(\'plan.md\',\'w\').write(\'x\')"'), false, 'plan.md is not under docs/');
  // Slice 393 item 8: sed -i / perl -i on a tracked file is denied like an inline script; scratch and untracked files pass, and so does sed without -i.
  assert.ok(isDeny("sed -i 's/x/y/' plan.md"), 'sed -i on a tracked file');
  assert.match(verdict("sed -i 's/x/y/' plan.md").hookSpecificOutput.permissionDecisionReason, /tracked file .*plan\.md/);
  assert.ok(isDeny("perl -pi -e 's/x/y/' plan.md"), 'perl -pi on a tracked file');
  assert.ok(isDeny("cd docs && sed -i 's/x/y/' a.md"), 'sed -i resolved against a leading cd');
  assert.equal(isDeny("sed -i 's/x/y/' new.md"), false, 'sed -i on an untracked file');
  assert.equal(isDeny("sed -i 's/x/y/' tmp/out.json"), false, 'sed -i on scratch');
  assert.equal(isDeny("sed -n 's/x/y/p' plan.md"), false, 'sed without -i');
  // Review of Slice 393, finding 8: only a real -i flag counts, never a word such as -input.
  assert.equal(isDeny('perl tools/report.pl -input plan.md'), false, 'perl script option -input is not -i');
  assert.equal(isDeny("sed -n --input-file 's/x/y/p' plan.md"), false, 'a long option is not -i');
  assert.ok(isDeny("perl -i.bak -pe 's/x/y/' plan.md"), 'perl -i.bak still counts');
  assert.ok(isDeny("sed --in-place 's/x/y/' plan.md"), 'sed --in-place still counts');
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});
