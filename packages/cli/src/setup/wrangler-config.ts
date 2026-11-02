export interface DeployConfig {
  workerName: string;
  d1Name: string;
  d1Id: string;
  kvId: string;
  owner: string;
  repo: string;
  branch: string;
  allowIds: number[];
  assetsDir: string;
  main: string;
  migrationsDir: string;
  compatibilityDate: string;
}

/** wrangler.jsonc for a concrete deployment (written next to the app, gitignored). */
export function renderWranglerConfig(c: DeployConfig): string {
  return `${JSON.stringify(
    {
      name: c.workerName,
      main: c.main,
      compatibility_date: c.compatibilityDate,
      compatibility_flags: ['nodejs_compat'],
      assets: {
        directory: c.assetsDir,
        binding: 'ASSETS',
        not_found_handling: 'single-page-application',
        run_worker_first: ['/api/*', '/mcp', '/mcp/*', '/auth/*', '/oauth/*', '/authorize', '/token', '/register', '/hooks/*', '/admin/*', '/.well-known/*'],
      },
      d1_databases: [{ binding: 'DB', database_name: c.d1Name, database_id: c.d1Id, migrations_dir: c.migrationsDir }],
      kv_namespaces: [{ binding: 'OAUTH_KV', id: c.kvId }],
      vars: { GITHUB_OWNER: c.owner, GITHUB_REPO: c.repo, DEFAULT_BRANCH: c.branch, ALLOWED_GITHUB_IDS: c.allowIds.join(','), GITHUB_API: 'https://api.github.com' },
      observability: { enabled: true },
    },
    null,
    2,
  )}\n`;
}

/** Parse ids out of wrangler output (it prints JSON or TOML-ish snippets depending on version). */
export function parseD1Id(out: string): string | null {
  return /"?database_id"?\s*[:=]\s*"([0-9a-f-]{36})"/.exec(out)?.[1] ?? /\b([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/.exec(out)?.[1] ?? null;
}

export function parseKvId(out: string): string | null {
  return /"?id"?\s*[:=]\s*"([0-9a-f]{32})"/.exec(out)?.[1] ?? null;
}

export function parseWorkerUrl(out: string): string | null {
  return /(https:\/\/[a-z0-9.-]+\.workers\.dev)/i.exec(out)?.[1] ?? null;
}
