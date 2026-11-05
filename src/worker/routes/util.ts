import type { Context } from 'hono';
import type { z } from 'zod';

export type AppEnv = { Bindings: Cloudflare.Env };
export type Ctx = Context<AppEnv>;

export class ApiError extends Error {
  constructor(
    public status: 400 | 401 | 403 | 404 | 409 | 413 | 415 | 429 | 503,
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

export const notFound = (what: string) => new ApiError(404, 'not_found', `${what} not found.`);

export async function body<S extends z.ZodType>(c: Ctx, schema: S): Promise<z.output<S>> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    throw new ApiError(400, 'invalid', 'The request body must be JSON.');
  }
  const r = schema.safeParse(raw);
  if (!r.success) {
    const issue = r.error.issues[0];
    const where = issue?.path.length ? `${issue.path.join('.')}: ` : '';
    throw new ApiError(
      400,
      'invalid',
      `${where}${issue?.message ?? 'Invalid input.'}`,
      r.error.issues,
    );
  }
  return r.data;
}

/** Keeps only keys that were actually sent (so PATCH doesn't clear omitted fields). */
export function defined<T extends Record<string, unknown>>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}
