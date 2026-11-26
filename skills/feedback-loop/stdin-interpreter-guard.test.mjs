// node --test skills/feedback-loop/stdin-interpreter-guard.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { decide } from './stdin-interpreter-guard.mjs';

const run = (command) => decide({ tool_name: 'Bash', tool_input: { command } });
const denied = (command) => run(command)?.hookSpecificOutput?.permissionDecision === 'deny';

test('a bare interpreter waiting on stdin is denied', () => {
  for (const command of ['python3', 'python', 'py', 'node', 'python3 -', 'cd x && python3', 'python3; echo done', 'node.exe', 'python3  # try']) {
    assert.ok(denied(command), command);
  }
});

test('interpreters with a script, -c/-e or fed stdin pass', () => {
  for (const command of [
    'python3 script.py', 'python3 -c "print(1)"', "python3 - <<'EOF'\nprint(1)\nEOF", 'echo x | python3',
    'python3 < in.txt', 'node -e "1"', 'node --test a.test.mjs', 'python3 -I -m unittest', 'pythonx', 'npx node',
  ]) {
    assert.equal(run(command), null, command);
  }
  assert.equal(decide({}), null);
});

test('a lone interpreter name inside a heredoc body passes', () => {
  for (const command of [
    "cat > notes.md <<'EOF'\nnode\nEOF",
    'echo to do node',
  ]) {
    assert.equal(run(command), null, command);
  }
});

test('a bare interpreter with only output redirection or a pipe out is denied', () => {
  for (const command of ['python3 2>&1', 'python3 > out.txt', 'python3 >> out.txt', 'python3 2> err', 'python3 &', 'node | cat']) {
    assert.ok(denied(command), command);
  }
});

test('Slice 266: an interpreter with empty stdin (empty heredoc, /dev/null, NUL) is denied', () => {
  for (const command of [
    "python3 - <<'EOF' 2>/dev/null || echo nopy\nEOF",
    "python3 - <<'EOF'\nEOF",
    "python - <<'EOF' 2>/dev/null && echo yes\nEOF",
    "py - <<'EOF'\n\nEOF",
    'cd x && python3 <<EOF\nEOF',
    'python3 - < /dev/null',
    'python - < /dev/null',
    'py - < /dev/null',
    'python3 < NUL',
    'python3 -u - < /dev/null',
    'py -3 < /dev/null',
    'python3 - arg < /dev/null',
    "py -3 - <<'EOF'\nEOF",
    "python -u - <<'EOF'\nEOF",
    'python3.11 < /dev/null',
    '/usr/bin/python3 < /dev/null',
    'X=1 python3 < /dev/null',
    "timeout 5 python3 - <<'EOF'\nEOF",
    'cmd /c python - < NUL',
    "echo hi # don't\npython3 - <<'EOF'\nEOF",
    '(python3 < /dev/null)',
    'echo x | python3 < /dev/null',
    'if true; then python3 < /dev/null; fi',
    'python3 -X dev - < /dev/null',
    "timeout -s KILL 5 python3 - <<'EOF'\nEOF",
    'timeout -k 5 10 python3 < /dev/null',
    'timeout --signal=KILL 5 python3 < /dev/null',
    'timeout --foreground 5 python3 < /dev/null',
    'x=$(python3 < /dev/null)',
    'echo $((1<<x))\npython3 < /dev/null',
    "echo it's here\npython3 < /dev/null",
    'python3 \\\n< /dev/null',
    "python3 \\\n- <<'EOF'\nEOF",
  ]) {
    assert.ok(denied(command), command);
  }
});

test('Slice 266: the forms that return still pass', () => {
  for (const command of [
    "printf '' | python3 -",
    "python3 - <<'EOF'\nprint(1)\nEOF",
    'python3 -c "print(1)"',
    'python3 script.py < /dev/null',
    'python3 -c "1" < /dev/null',
    'python3 < in.txt',
    'python3 < nul.txt',
    'python3 < /dev/null.txt',
    'python3 < /dev/null-x',
    'node < /dev/null',
    "node - <<'EOF'\nEOF",
    "python3 <<< ''",
    'python3 -X dev script.py < /dev/null',
    'echo $((1<<2)) # python3 x',
    'py -3 script.py < /dev/null',
    'python3 -u script.py < /dev/null',
  ]) {
    assert.equal(run(command), null, command);
  }
});

test('Slice 266: the idiom inside another heredoc or a non-terminated body passes', () => {
  for (const command of [
    "cat > doc.md <<'EOF'\npython3 - <<'X'\nX\nEOF",
    "python3 - <<'EOF'\nprint(\"python3 - <<'X'\\nX\")\nEOF",
    'python3 <<EOF\n  EOF\nrest\nEOF',
    "python3 - <<'EOF'\r\nprint(1)\r\nEOF\r\n",
  ]) {
    assert.equal(run(command), null, command);
  }
});

test('Slice 266: no quote parsing - a whole hang form on its own line inside a quote is denied (accepted trade-off)', () => {
  assert.ok(denied("git commit -m 'x\npython3 - <<EOF\nEOF\n'"));
});

test('Slice 266: a CRLF terminator, a tab-indented <<- terminator and a blank-line body still count as empty', () => {
  for (const command of ["python3 - <<'EOF'\r\nEOF\r\n", "python3 <<-EOF\n\tEOF", "python3 - <<'EOF'\n\n  \nEOF"]) {
    assert.ok(denied(command), command);
  }
});

test('Slice 307: Python with startup options but no script waits on stdin and is denied', () => {
  for (const command of ['python3 -u', 'py -3', 'python -i -q', 'python3 -X dev', 'python3 -u -', 'cd x && py -3.11', 'python3 -B 2>&1', 'timeout 5 python3 -u', 'python3.11 -I -u; echo done']) {
    assert.ok(denied(command), command);
  }
});

test('Slice 307: Python with options plus a script, -c, -m, --version or -h still passes', () => {
  for (const command of ['python3 -u script.py', 'py -3 script.py', 'python3 -I -m unittest', 'python3 -c "1"', 'python3 --version', 'python3 -V', 'python3 -h', 'py -0', 'py -3 -c "1"', 'echo x | python3 -u', 'python3 -u < in.txt', "python3 -u - <<'EOF'\nprint(1)\nEOF"]) {
    assert.equal(run(command), null, command);
  }
});

test('Slice 307: a bare interpreter behind the PowerShell call operator or a quoted path is denied', () => {
  for (const command of ['& python', "& 'C:\\Python\\python.exe'", '& "python3"', "& py -3", 'cd x; & python -u']) {
    assert.ok(denied(command), command);
  }
  for (const command of ["& 'C:\\Python\\python.exe' script.py", '& python -c "1"', '& node script.mjs']) {
    assert.equal(run(command), null, command);
  }
});
