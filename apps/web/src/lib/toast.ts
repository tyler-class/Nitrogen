type Listener = (msgs: { id: number; text: string }[]) => void;
let msgs: { id: number; text: string }[] = [];
let n = 0;
const listeners = new Set<Listener>();

export function toast(text: string, ms = 3500): void {
  const id = ++n;
  msgs = [...msgs, { id, text }];
  listeners.forEach((l) => l(msgs));
  setTimeout(() => {
    msgs = msgs.filter((m) => m.id !== id);
    listeners.forEach((l) => l(msgs));
  }, ms);
}

export function subscribeToasts(l: Listener): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}
