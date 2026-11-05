// Who made a change: the owner in the app, or a connected assistant.
// Stored as text: 'you', or 'agent:<client name>'. NULL/unknown = before Nitrogen recorded it.

export type Actor = { kind: 'you'; name: 'You' } | { kind: 'agent'; name: string };

export const YOU: Actor = { kind: 'you', name: 'You' };

export function agent(name: string | null | undefined): Actor {
  const n = (name ?? '').trim().slice(0, 80);
  return { kind: 'agent', name: n || 'An assistant' };
}

export function encodeActor(a: Actor): string {
  return a.kind === 'you' ? 'you' : `agent:${a.name}`;
}

export function decodeActor(s: string | null | undefined): Actor | null {
  if (!s) return null;
  if (s === 'you') return YOU;
  if (s.startsWith('agent:')) return agent(s.slice(6));
  return null;
}

/** "You", "Claude", or "Someone" for changes from before attribution. */
export function actorLabel(s: string | null | undefined): string {
  return decodeActor(s)?.name ?? 'Someone';
}

export const isAgent = (s: string | null | undefined) => !!s && s.startsWith('agent:');
