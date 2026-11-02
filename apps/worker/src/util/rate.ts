/** Fixed-window rate limiting in D1 (KV's 1k writes/day is too small for counters). */
export async function rateLimit(db: D1Database, key: string, max: number, windowSec: number): Promise<{ ok: boolean; remaining: number; resetAt: number }> {
  const now = Math.floor(Date.now() / 1000);
  const window = Math.floor(now / windowSec);
  const r = await db
    .prepare(
      `INSERT INTO rate (k, window, n) VALUES (?, ?, 1)
       ON CONFLICT(k) DO UPDATE SET n = CASE WHEN rate.window = excluded.window THEN rate.n + 1 ELSE 1 END, window = excluded.window
       RETURNING n`,
    )
    .bind(key, window)
    .first<{ n: number }>();
  const n = r?.n ?? 1;
  return { ok: n <= max, remaining: Math.max(0, max - n), resetAt: (window + 1) * windowSec };
}
