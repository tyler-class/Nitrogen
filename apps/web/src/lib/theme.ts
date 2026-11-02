export type Theme = 'system' | 'light' | 'dark';

export function getTheme(): Theme {
  try {
    return (localStorage.getItem('n2-theme') as Theme) || 'system';
  } catch {
    return 'system';
  }
}

export function applyTheme(t: Theme): void {
  if (t === 'system') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = t;
  try {
    localStorage.setItem('n2-theme', t);
  } catch {
    /* ignore */
  }
  window.dispatchEvent(new CustomEvent('n2:theme'));
}

export function cycleTheme(): Theme {
  const order: Theme[] = ['system', 'light', 'dark'];
  const next = order[(order.indexOf(getTheme()) + 1) % order.length]!;
  applyTheme(next);
  return next;
}
