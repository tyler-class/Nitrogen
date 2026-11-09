// Selfhost Kit: synced from tyler-class/selfhost-kit (kit/scripts/release.ts).
// Migrates the remote database, then deploys the Worker, so new code never runs against
// missing columns. On a first install the database doesn't exist until `wrangler deploy`
// provisions it, so migrations run once more after the deploy.
// Usage: npm run release (after npm run build). Workers Builds runs it as the deploy command.
import { spawn } from 'node:child_process';

/** Runs wrangler, streaming its output while keeping a copy to inspect. */
function wrangler(args: string[]): Promise<{ ok: boolean; output: string }> {
  return new Promise((resolve) => {
    let output = '';
    const p = spawn('npx', ['wrangler', ...args], { stdio: ['inherit', 'pipe', 'pipe'] });
    p.stdout.on('data', (d: Buffer) => ((output += d), process.stdout.write(d)));
    p.stderr.on('data', (d: Buffer) => ((output += d), process.stderr.write(d)));
    p.on('close', (code) => resolve({ ok: code === 0, output }));
  });
}

const migrate = ['d1', 'migrations', 'apply', 'DB', '--remote'];

const before = await wrangler(migrate);
const firstInstall =
  !before.ok && /couldn'?t find|not found|no database|database_id/i.test(before.output);
if (!before.ok && !firstInstall) process.exit(1);
if (firstInstall) console.log('No database yet: deploying first, then migrating.');

if (!(await wrangler(['deploy'])).ok) process.exit(1);

if (firstInstall && !(await wrangler(migrate)).ok) process.exit(1);
