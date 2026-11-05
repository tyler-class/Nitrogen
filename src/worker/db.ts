export type Row = Record<string, unknown>;

export const nowIso = () => new Date().toISOString();

const ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz';
/** 12 random base32 characters (60 bits): short enough for URLs, plenty for one wiki. */
export function newId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  return Array.from(bytes, (b) => ALPHABET[b & 31]).join('');
}

export async function all<T = Row>(db: D1Database, sql: string, ...binds: unknown[]): Promise<T[]> {
  const res = await db
    .prepare(sql)
    .bind(...binds)
    .all<T>();
  return res.results;
}

export async function first<T = Row>(
  db: D1Database,
  sql: string,
  ...binds: unknown[]
): Promise<T | null> {
  return db
    .prepare(sql)
    .bind(...binds)
    .first<T>();
}

export async function getSetting(db: D1Database, key: string): Promise<string | null> {
  const row = await first<{ value: string }>(db, 'SELECT value FROM settings WHERE key = ?', key);
  return row?.value ?? null;
}

export function setSettingStmt(db: D1Database, key: string, value: string | null) {
  return value === null
    ? db.prepare('DELETE FROM settings WHERE key = ?').bind(key)
    : db
        .prepare(
          'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value',
        )
        .bind(key, value);
}

/** `?, ?, ?` for an IN list. D1 allows 100 bound parameters per statement. */
export const marks = (n: number) => Array.from({ length: n }, () => '?').join(', ');

export function chunks<T>(list: T[], size = 90): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}
