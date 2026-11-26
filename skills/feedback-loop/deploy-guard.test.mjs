// node --test skills/feedback-loop/deploy-guard.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { decide } from './deploy-guard.mjs';

const SCRIPT = fileURLToPath(new URL('./deploy-guard.mjs', import.meta.url));
const run = (command, tool = 'Bash') => decide({ tool_name: tool, tool_input: { command } });
const denied = (command, tool) => run(command, tool)?.hookSpecificOutput?.permissionDecision === 'deny';

test('direct production deploys are denied', () => {
  for (const command of [
    'wrangler deploy', 'npx wrangler deploy', 'npx --yes wrangler@4 deploy', 'pnpm dlx wrangler deploy --env production',
    'cd D:/repo && npm run deploy', 'npm run deploy:prod', 'yarn deploy', 'wrangler versions deploy', 'wrangler pages deploy site',
    'wrangler rollback', 'firebase deploy --only hosting', 'vercel --prod', 'npx vercel deploy --prod', 'netlify deploy --prod',
    'flyctl deploy', 'gcloud run deploy svc', 'az webapp deploy --name x', 'npx cdk deploy', 'terraform apply -auto-approve',
    'pulumi up --yes', 'echo go; wrangler deploy', 'npm ci && npm run deploy',
  ]) {
    assert.ok(denied(command), command);
  }
  assert.ok(denied('npx wrangler deploy', 'PowerShell'));
});

test('dry runs, reads and mentions pass', () => {
  for (const command of [
    'wrangler deploy --dry-run', 'npx wrangler deploy --dry-run --outdir dist', 'wrangler deployments list --name x',
    'wrangler whoami', 'npm run typecheck', 'npm run deployment-check', 'git commit -m "deploy via wrangler deploy later"',
    'echo "npm run deploy"', 'gh run list --workflow deploy.yml', 'gh workflow run deploy.yml', 'terraform plan',
    'vercel deploy', 'netlify deploy', 'grep -n "wrangler deploy" worker/CLAUDE.md',
  ]) {
    assert.equal(run(command), null, command);
  }
});

test('nested shells, shims, global flags and script names are denied', () => {
  for (const command of [
    'powershell -NoProfile -Command "npx wrangler deploy"', 'pwsh -c "wrangler deploy"', 'bash -c "npm run deploy"',
    "sh -c 'npm run deploy:prod'", 'cmd /c "wrangler deploy"', 'Invoke-Expression "wrangler deploy"', 'iex "npm run deploy"',
    'if ($?) { wrangler deploy }', 'powershell -Command "if ($?) { npm run deploy }"', 'sudo wrangler deploy',
    'wrangler.cmd deploy', 'wrangler.exe deploy', 'npm.cmd run deploy', './node_modules/.bin/wrangler deploy',
    'npm exec wrangler deploy', 'npm exec -- wrangler deploy', 'npx.cmd wrangler deploy', 'npx -- wrangler deploy',
    '& "C:\\Program Files\\nodejs\\npx.cmd" wrangler deploy', 'node node_modules/wrangler/bin/wrangler.js deploy',
    'wrangler -c worker/wrangler.jsonc deploy', 'wrangler --config x deploy', 'wrangler --env prod deploy',
    'npm --prefix worker run deploy', 'npm -w worker run deploy', 'npm run --prefix worker deploy',
    'pnpm -C worker run deploy', 'pnpm --filter w run deploy', 'pnpm --dir w run deploy', 'yarn workspace w deploy',
    'terraform -chdir=infra apply', 'tofu apply', 'terraform apply plan.out', 'npm run deploy:production', 'npm run deploy:eu',
    'wrangler deploy --dry-run=false', 'wrangler deploy --message "--dry-run"', 'wrangler deploy --help-me',
  ]) {
    assert.ok(denied(command), command);
  }
});

test('local scripts, help, quoted text and non-deploy tools pass', () => {
  for (const command of [
    'npm run deploy:dry-run', 'npm run deploy:local', 'npm run deploy:dev', 'npm run deploy:staging', 'npm run deploy:preview',
    'npm run deploy:test', 'pnpm deploy', 'pnpm deploy ../out', 'npm run deploy-docs', 'npm publish',
    'git commit -m "fix; wrangler deploy"', 'echo "a && npm run deploy"', 'git commit -m "x | terraform apply"',
    'powershell -Command "echo hi; wrangler deploy --dry-run"', 'bash -c "wrangler whoami"', 'wrangler deploy --help',
    'terraform apply -help', 'terraform plan', 'terraform -chdir=infra plan', "gh pr create --body 'a; npm run deploy'",
  ]) {
    assert.equal(run(command), null, command);
  }
});

test('multi-line quoted text and here-strings are not scanned as commands', () => {
  for (const command of [
    'git commit -m "fix the guard\n\nwrangler deploy is now blocked\nterraform apply too"',
    "git commit -m 'subject\nwrangler deploy\nbody'",
    "git commit -m @'\nfix\n\nterraform apply is now blocked\nit's done\n'@",
    'git commit -m @"\nwrangler deploy\n"@',
    'gh pr create --title x --body "line one\nnpm run deploy\nline three"',
    "git commit -F - <<'EOF'\nwrangler deploy\nit's text\nEOF\ngit status",
    '# it\'s a comment\ngit status',
  ]) {
    assert.equal(run(command), null, command);
  }
  assert.equal(run("git commit -m @'\nit's wrangler deploy\n'@", 'PowerShell'), null);
});

test('a deploy after or around multi-line quoted text is still denied', () => {
  for (const command of [
    'git commit -m "a\nb"\nwrangler deploy',
    "git commit -m @'\nit's text\n'@\nnpm run deploy",
    "cat <<'EOF'\nit's\nEOF\nwrangler deploy",
    'bash -c "echo hi\nwrangler deploy"',
    'git commit -m "x" && wrangler deploy',
  ]) {
    assert.ok(denied(command), command);
  }
});

test('vercel is denied only for a production deploy', () => {
  for (const command of ['vercel --prod', 'vercel deploy --prod', 'npx vercel --prebuilt --prod', 'vercel ./site --prod', 'vercel deploy --prebuilt --prod --yes']) {
    assert.ok(denied(command), command);
  }
  for (const command of ['vercel ls', 'vercel ls --prod', 'vercel env ls --prod', 'vercel logs --prod', 'vercel inspect --prod', 'vercel deploy --prebuilt']) {
    assert.equal(run(command), null, command);
  }
});

test('a harmless token exempts only after the subcommand and not as another flag value', () => {
  for (const command of [
    'wrangler deploy --env prod -h', 'wrangler deploy --dry-run false', 'wrangler deploy --message --help', 'wrangler deploy --env --dry-run',
    'wrangler --help deploy', 'wrangler deploy --name x -help', 'echo --help; wrangler deploy', 'wrangler deploy --dry-run=false',
  ]) {
    assert.ok(denied(command), command);
  }
  for (const command of ['wrangler deploy --help', 'wrangler deploy -h', 'wrangler deploy --dry-run', 'wrangler deploy --env x --dry-run', 'terraform apply -help']) {
    assert.equal(run(command), null, command);
  }
});

test('the hook prints a deny verdict and fails open on bad input', () => {
  const hit = spawnSync(process.execPath, [SCRIPT], { input: JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'wrangler deploy' } }) });
  assert.match(String(hit.stdout), /"permissionDecision":"deny"/);
  const bad = spawnSync(process.execPath, [SCRIPT], { input: 'not json' });
  assert.equal(String(bad.stdout), '');
  assert.match(String(bad.stderr), /let the call through/);
});
