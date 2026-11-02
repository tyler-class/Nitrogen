/**
 * `nitrogen setup`: idempotent, resumable deployment. Every step checks current state first.
 * Secrets live only in memory and reach wrangler/gh over stdin.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { Masker, type Shell } from './shell.ts';
import { loadState, saveState, type SetupState } from './state.ts';
import { findInstallation, runManifestFlow, type ConversionResult } from './github-app.ts';
import { parseD1Id, parseKvId, parseWorkerUrl, renderWranglerConfig } from './wrangler-config.ts';
import { formatChecks, runDoctor } from './doctor.ts';
import { initFiles } from './notes-init.ts';

export interface UI {
  info(msg: string): void;
  step(msg: string): void;
  needsYou(lines: string[]): void;
  confirm(msg: string): Promise<boolean>;
  text(msg: string, initial?: string): Promise<string>;
}

export interface SetupDeps {
  shell: Shell;
  ui: UI;
  fetchImpl: typeof fetch;
  open: (url: string) => void;
  appDir: string;
  statePath?: string;
  /** Overridable for tests. */
  manifestFlow?: typeof runManifestFlow;
  sleep?: (ms: number) => Promise<void>;
  isRoot?: () => boolean;
}

export interface SetupOptions {
  repo?: string;
  workerName?: string;
  allowGithubId?: number;
  yes?: boolean;
  branch?: string;
  demo?: boolean;
}

export const SECRET_NAMES = ['GITHUB_APP_ID', 'GITHUB_APP_PRIVATE_KEY', 'GITHUB_INSTALLATION_ID', 'GITHUB_OAUTH_CLIENT_ID', 'GITHUB_OAUTH_CLIENT_SECRET', 'GITHUB_WEBHOOK_SECRET', 'SESSION_SECRET', 'INGEST_HMAC_SECRET', 'COOKIE_ENCRYPTION_KEY'] as const;

const rand = () => randomBytes(32).toString('base64url');

export class Setup {
  state: SetupState;
  masker = new Masker();
  /** In-memory only. */
  private secrets = new Map<string, string>();
  private app: ConversionResult | null = null;
  constructor(
    private d: SetupDeps,
    private o: SetupOptions,
  ) {
    this.state = loadState(d.statePath);
  }

  private save(): void {
    saveState(this.state, this.d.statePath);
  }

  private done(id: string): boolean {
    return this.state.completed.includes(id);
  }

  private mark(id: string): void {
    if (!this.done(id)) this.state.completed.push(id);
    this.save();
  }

  private async sh(cmd: string, args: string[], opts: { input?: string; cwd?: string; interactive?: boolean; allowFail?: boolean } = {}) {
    if (opts.input) this.masker.add(opts.input);
    const r = await this.d.shell.run(cmd, args, opts);
    if (r.code !== 0 && !opts.allowFail) throw new Error(this.masker.mask(`${cmd} ${args.join(' ')} failed (${r.code}): ${r.stderr || r.stdout}`));
    return r;
  }

  private wrangler(args: string[], opts: { input?: string; interactive?: boolean; allowFail?: boolean } = {}) {
    return this.sh('npx', ['--yes', 'wrangler', ...args], { ...opts, cwd: join(this.d.appDir, 'apps/worker') });
  }

  private get configPath(): string {
    return join(this.d.appDir, 'apps/worker/wrangler.generated.jsonc');
  }

  async preflight(): Promise<void> {
    this.d.ui.step('Checking tools');
    if ((this.d.isRoot ?? (() => typeof process.getuid === 'function' && process.getuid() === 0))()) throw new Error('Do not run setup as root.');
    const major = Number(process.versions.node.split('.')[0]);
    if (major < 22) throw new Error(`Node 22+ is required (found ${process.versions.node}).`);
    for (const [cmd, args, hint] of [
      ['git', ['--version'], 'Install git.'],
      ['gh', ['--version'], 'Install the GitHub CLI: https://cli.github.com'],
    ] as const) {
      const r = await this.d.shell.run(cmd, [...args]);
      if (r.code !== 0) throw new Error(`${cmd} not found. ${hint}`);
    }
    const auth = await this.d.shell.run('gh', ['auth', 'status']);
    if (auth.code !== 0) {
      this.d.ui.needsYou(['Sign in to GitHub in the browser window that opens (gh auth login).']);
      await this.sh('gh', ['auth', 'login', '--web', '--scopes', 'repo,workflow'], { interactive: true });
    }
    const me = JSON.parse((await this.sh('gh', ['api', 'user'])).stdout) as { id: number; login: string };
    this.state.githubId = me.id;
    this.state.githubLogin = me.login;
    this.save();
  }

  async cloudflareLogin(): Promise<void> {
    this.d.ui.step('Cloudflare account');
    const who = await this.wrangler(['whoami'], { allowFail: true });
    if (who.code !== 0 || /not authenticated|You are not/i.test(who.stdout + who.stderr)) {
      this.d.ui.needsYou(['1. Approve the Cloudflare login in the browser window that opens.']);
      await this.wrangler(['login'], { interactive: true });
    }
  }

  async notesRepo(): Promise<void> {
    this.d.ui.step('Notes repo');
    if (!this.state.repo) {
      const name = this.o.repo ?? (this.o.yes ? 'notes' : await this.d.ui.text('Name of the private notes repo', 'notes'));
      this.state.repo = name.includes('/') ? name : `${this.state.githubLogin}/${name}`;
      this.save();
    }
    const view = await this.sh('gh', ['repo', 'view', this.state.repo, '--json', 'name,isPrivate'], { allowFail: true });
    if (view.code !== 0) {
      await this.sh('gh', ['repo', 'create', this.state.repo, '--private', '--add-readme', '--description', 'Nitrogen wiki']);
      this.d.ui.info(`Created ${this.state.repo} (private).`);
    } else if (!(JSON.parse(view.stdout) as { isPrivate: boolean }).isPrivate) {
      this.d.ui.info(`Warning: ${this.state.repo} is public.`);
    }
    this.mark('repo');
  }

  async provision(): Promise<void> {
    this.d.ui.step('Cloudflare D1 and KV');
    const base = this.o.workerName ?? this.state.workerName ?? `nitrogen-${(this.state.repo ?? 'notes').split('/')[1]}`.toLowerCase().replace(/[^a-z0-9-]/g, '-');
    this.state.workerName = base;
    this.state.d1Name ??= base;
    if (this.done('provision') && this.state.d1Id && this.state.kvId) {
      this.writeConfig();
      return;
    }
    if (!this.state.d1Id) {
      const list = await this.wrangler(['d1', 'list', '--json'], { allowFail: true });
      const existing = list.code === 0 ? (JSON.parse(list.stdout || '[]') as { name: string; uuid: string }[]).find((d) => d.name === this.state.d1Name) : undefined;
      this.state.d1Id = existing?.uuid ?? parseD1Id((await this.wrangler(['d1', 'create', this.state.d1Name])).stdout) ?? undefined;
      if (!this.state.d1Id) throw new Error('Could not read the D1 database id from wrangler output.');
    }
    if (!this.state.kvId) {
      const title = `${base}-oauth`;
      const list = await this.wrangler(['kv', 'namespace', 'list'], { allowFail: true });
      const existing = list.code === 0 ? (JSON.parse(list.stdout || '[]') as { id: string; title: string }[]).find((n) => n.title === title || n.title.endsWith(title)) : undefined;
      this.state.kvId = existing?.id ?? parseKvId((await this.wrangler(['kv', 'namespace', 'create', title])).stdout) ?? undefined;
      if (!this.state.kvId) throw new Error('Could not read the KV namespace id from wrangler output.');
    }
    this.save();
    this.writeConfig();
    await this.wrangler(['d1', 'migrations', 'apply', 'DB', '--remote', '-c', 'wrangler.generated.jsonc'], { input: 'y\n' });
    this.mark('provision');
  }

  writeConfig(): void {
    const [owner, repo] = (this.state.repo ?? '/').split('/');
    const ids = [this.state.githubId, this.o.allowGithubId].filter((x): x is number => !!x);
    writeFileSync(
      this.configPath,
      renderWranglerConfig({
        workerName: this.state.workerName!,
        d1Name: this.state.d1Name!,
        d1Id: this.state.d1Id!,
        kvId: this.state.kvId!,
        owner: owner!,
        repo: repo!,
        branch: this.o.branch ?? 'main',
        allowIds: [...new Set(ids)],
        assetsDir: '../web/dist',
        main: 'src/index.ts',
        migrationsDir: 'migrations',
        compatibilityDate: '2026-08-15',
      }),
    );
  }

  async buildWeb(): Promise<void> {
    if (existsSync(join(this.d.appDir, 'apps/web/dist/index.html'))) return;
    this.d.ui.step('Building the web app');
    await this.sh('pnpm', ['--filter', '@nitrogen/web', 'build'], { cwd: this.d.appDir });
  }

  async deploy(): Promise<void> {
    this.d.ui.step('Deploying the Worker');
    const out = await this.wrangler(['deploy', '-c', 'wrangler.generated.jsonc']);
    const url = parseWorkerUrl(out.stdout + out.stderr);
    if (url) this.state.workerUrl = url;
    if (!this.state.workerUrl) throw new Error('Deployed, but could not find the workers.dev URL. Register a workers.dev subdomain in the Cloudflare dashboard (Workers > Settings) and re-run.');
    this.save();
  }

  /** Secrets present on the Worker (names only). */
  async presentSecrets(): Promise<Set<string>> {
    const r = await this.wrangler(['secret', 'list', '-c', 'wrangler.generated.jsonc', '--format', 'json'], { allowFail: true });
    if (r.code !== 0) return new Set();
    try {
      return new Set((JSON.parse(r.stdout) as { name: string }[]).map((s) => s.name));
    } catch {
      return new Set();
    }
  }

  async putSecret(name: string, value: string): Promise<void> {
    this.masker.add(value);
    await this.wrangler(['secret', 'put', name, '-c', 'wrangler.generated.jsonc'], { input: value });
  }

  async githubApp(): Promise<void> {
    if (this.state.appId && this.done('app')) return;
    this.d.ui.step('GitHub App');
    this.d.ui.needsYou(['2. Click "Create GitHub App" on the GitHub page that opens.']);
    const flow = this.d.manifestFlow ?? runManifestFlow;
    const name = `nitrogen-${this.state.githubLogin}-${randomBytes(2).toString('hex')}`.slice(0, 34);
    this.app = await flow({ name, workerUrl: this.state.workerUrl!, open: this.d.open, fetchImpl: this.d.fetchImpl });
    for (const v of [this.app.client_secret, this.app.webhook_secret, this.app.pem]) this.masker.add(v);
    this.state.appId = this.app.id;
    this.state.appSlug = this.app.slug;
    // Store the app secrets on the Worker right away so a later failure does not lose them.
    await this.putSecret('GITHUB_APP_ID', String(this.app.id));
    await this.putSecret('GITHUB_APP_PRIVATE_KEY', this.app.pem);
    await this.putSecret('GITHUB_OAUTH_CLIENT_ID', this.app.client_id);
    await this.putSecret('GITHUB_OAUTH_CLIENT_SECRET', this.app.client_secret);
    await this.putSecret('GITHUB_WEBHOOK_SECRET', this.app.webhook_secret);
    this.mark('app');
  }

  async install(): Promise<void> {
    if (this.state.installationId && this.done('install')) return;
    this.d.ui.step('Install the app on the notes repo');
    if (!this.app) {
      // The private key only exists in memory during the run that created the app.
      this.d.open(`https://github.com/apps/${this.state.appSlug}/installations/new`);
      const id = Number(await this.d.ui.text('Paste the installation id (the number at the end of the app installation URL)'));
      if (!Number.isInteger(id) || id <= 0) throw new Error('Not an installation id.');
      this.state.installationId = id;
      await this.putSecret('GITHUB_INSTALLATION_ID', String(id));
      this.mark('install');
      return;
    }
    this.d.ui.needsYou([`3. Install the app on ${this.state.repo} only ("Only select repositories").`]);
    this.d.open(`https://github.com/apps/${this.state.appSlug}/installations/new`);
    const owner = this.state.repo!.split('/')[0]!;
    const sleep = this.d.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
    for (let i = 0; i < 180; i++) {
      const id = await findInstallation(this.app.id, this.app.pem, owner, this.d.fetchImpl);
      if (id) {
        this.state.installationId = id;
        await this.putSecret('GITHUB_INSTALLATION_ID', String(id));
        this.mark('install');
        return;
      }
      await sleep(5000);
    }
    throw new Error('Timed out waiting for the app installation.');
  }

  async secretsAndRedeploy(): Promise<void> {
    this.d.ui.step('Worker secrets');
    const present = await this.presentSecrets();
    if (this.done('secrets') && SECRET_NAMES.every((n) => present.has(n))) return;
    for (const name of ['SESSION_SECRET', 'COOKIE_ENCRYPTION_KEY'] as const) if (!present.has(name)) await this.putSecret(name, rand());
    if (!present.has('INGEST_HMAC_SECRET')) {
      const ingest = rand();
      this.secrets.set('INGEST_HMAC_SECRET', ingest);
      await this.putSecret('INGEST_HMAC_SECRET', ingest);
    }
    this.writeConfig();
    await this.wrangler(['deploy', '-c', 'wrangler.generated.jsonc']);
    this.mark('secrets');
  }

  async initRepo(): Promise<void> {
    if (this.done('init')) return;
    this.d.ui.step('Initializing the notes repo');
    const dir = mkdtempSync(join(tmpdir(), 'n2-notes-'));
    try {
      await this.sh('gh', ['repo', 'clone', this.state.repo!, dir, '--', '--depth', '1']);
      const files = initFiles({ branch: this.o.branch ?? 'main', demo: this.o.demo !== false });
      const added: string[] = [];
      for (const [p, c] of Object.entries(files)) {
        const full = join(dir, p);
        if (existsSync(full)) continue;
        mkdirSync(join(full, '..'), { recursive: true });
        writeFileSync(full, c);
        added.push(p);
      }
      if (added.length) {
        await this.sh('git', ['-C', dir, 'add', ...added]);
        await this.sh('git', ['-C', dir, '-c', 'user.name=nitrogen-setup', '-c', `user.email=${this.state.githubId}+${this.state.githubLogin}@users.noreply.github.com`, 'commit', '-m', 'nitrogen: initialize wiki', '-m', 'Nitrogen-Actor: human\nNitrogen-Client: cli']);
        await this.sh('git', ['-C', dir, 'push', 'origin', 'HEAD']);
      }
      this.d.ui.info(added.length ? `Committed ${added.length} file(s).` : 'Repo already initialized.');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    this.mark('init');
  }

  async actionsConfig(): Promise<void> {
    if (this.done('actions')) return;
    this.d.ui.step('GitHub Actions settings');
    const ingest = this.secrets.get('INGEST_HMAC_SECRET');
    const list = await this.sh('gh', ['secret', 'list', '-R', this.state.repo!, '--json', 'name'], { allowFail: true });
    const has = list.code === 0 && (JSON.parse(list.stdout || '[]') as { name: string }[]).some((s) => s.name === 'NITROGEN_INGEST_SECRET');
    if (ingest) await this.sh('gh', ['secret', 'set', 'NITROGEN_INGEST_SECRET', '-R', this.state.repo!], { input: ingest });
    else if (!has) this.d.ui.info('NITROGEN_INGEST_SECRET is missing in the repo but the Worker already has one. Run `nitrogen rotate-keys` to set both.');
    await this.sh('gh', ['variable', 'set', 'NITROGEN_URL', '-R', this.state.repo!, '--body', this.state.workerUrl!]);
    await this.sh('gh', ['workflow', 'run', 'nitrogen-index.yml', '-R', this.state.repo!], { allowFail: true });
    this.mark('actions');
  }

  async run(): Promise<void> {
    await this.preflight();
    await this.cloudflareLogin();
    await this.notesRepo();
    await this.provision();
    await this.buildWeb();
    if (!this.state.workerUrl || !this.done('deployed')) {
      await this.deploy();
      this.mark('deployed');
    }
    await this.githubApp();
    await this.install();
    await this.secretsAndRedeploy();
    await this.initRepo();
    await this.actionsConfig();
    const checks = await runDoctor({ url: this.state.workerUrl!, fetchImpl: this.d.fetchImpl });
    this.d.ui.info(formatChecks(checks));
    this.d.ui.info(
      [
        '',
        `Wiki:      ${this.state.workerUrl}`,
        `MCP URL:   ${this.state.workerUrl}/mcp`,
        '',
        'Still yours to do:',
        '  - claude.ai > Settings > Connectors > Add custom connector > paste the MCP URL.',
        '  - On your iPhone, open the wiki in Safari > Share > Add to Home Screen.',
      ].join('\n'),
    );
  }
}

export function readJsonFile<T>(p: string): T {
  return JSON.parse(readFileSync(p, 'utf8')) as T;
}
