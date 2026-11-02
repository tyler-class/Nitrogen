export type Actor = 'human' | 'claude';

export interface CommitMeta {
  actor: Actor;
  client: 'web' | 'mcp' | 'api' | 'cli';
  tool?: string;
  user?: { id: number; login: string };
}

/** Build a commit message with Nitrogen trailers (the authorship mechanism). */
export function commitMessage(subject: string, meta: CommitMeta, body?: string): string {
  const trailers = [`Nitrogen-Actor: ${meta.actor}`, `Nitrogen-Client: ${meta.client}`];
  if (meta.tool) trailers.push(`Nitrogen-Tool: ${meta.tool}`);
  return `${subject}${body ? `\n\n${body}` : ''}\n\n${trailers.join('\n')}\n`;
}

export function defaultSubject(op: string, paths: string[], meta: CommitMeta): string {
  const first = paths[0] ?? 'files';
  const more = paths.length > 1 ? ` (+${paths.length - 1} more)` : '';
  const scope = meta.actor === 'claude' ? 'nitrogen(claude)' : 'nitrogen';
  return `${scope}: ${op} ${first}${more}`;
}

export interface ParsedTrailers {
  actor: Actor | 'external';
  client?: string;
  tool?: string;
}

export function parseTrailers(message: string): ParsedTrailers {
  const get = (k: string) => new RegExp(`^${k}:\\s*(.+)$`, 'mi').exec(message)?.[1]?.trim();
  const actor = get('Nitrogen-Actor');
  const out: ParsedTrailers = { actor: actor === 'claude' || actor === 'human' ? actor : 'external' };
  const client = get('Nitrogen-Client');
  const tool = get('Nitrogen-Tool');
  if (client) out.client = client;
  if (tool) out.tool = tool;
  return out;
}

export function subjectOf(message: string): string {
  return message.split('\n')[0] ?? '';
}
