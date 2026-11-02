import { spawn } from 'node:child_process';

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface RunOptions {
  /** Written to stdin then closed. Use for secrets: never put them in argv. */
  input?: string;
  cwd?: string;
  /** Inherit stdio (interactive commands like `wrangler login`). */
  interactive?: boolean;
  env?: Record<string, string>;
}

export interface Shell {
  run(cmd: string, args: string[], opts?: RunOptions): Promise<RunResult>;
}

export const realShell: Shell = {
  run(cmd, args, opts = {}) {
    return new Promise((resolve) => {
      const child = spawn(cmd, args, {
        cwd: opts.cwd,
        env: { ...process.env, ...opts.env },
        stdio: opts.interactive ? 'inherit' : ['pipe', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      child.stdout?.on('data', (d) => (stdout += d));
      child.stderr?.on('data', (d) => (stderr += d));
      if (!opts.interactive) {
        if (opts.input !== undefined) child.stdin?.end(opts.input);
        else child.stdin?.end();
      }
      child.on('error', (e) => resolve({ code: 127, stdout, stderr: String(e) }));
      child.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }));
    });
  },
};

/** Masks registered secret values in any text before it is printed. */
export class Masker {
  private secrets = new Set<string>();
  add(v: string | undefined | null): void {
    if (v && v.length >= 6) this.secrets.add(v);
  }
  mask(s: string): string {
    let out = s;
    for (const v of this.secrets) out = out.split(v).join('********');
    return out;
  }
}
