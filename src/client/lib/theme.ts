// Light / Dark / System, remembered per device. index.html applies the saved choice
// before first paint; this keeps it in sync when changed in Settings.
import { useState } from 'react';

export type Theme = 'system' | 'light' | 'dark';
const KEY = 'nitrogen-theme';
/** The --paper token in each theme (tokens.css), used for the phone status bar. */
const COLORS = { light: '#ffffff', dark: '#15171a' } as const;

export function getTheme(): Theme {
  try {
    const t = localStorage.getItem(KEY);
    return t === 'light' || t === 'dark' ? t : 'system';
  } catch {
    return 'system';
  }
}

export function applyTheme(t: Theme) {
  const root = document.documentElement;
  if (t === 'system') delete root.dataset.theme;
  else root.dataset.theme = t;
  document.querySelectorAll('meta[name=theme-color]').forEach((m) => {
    const media = m.getAttribute('media') ?? '';
    const sys = media.includes('dark') ? COLORS.dark : COLORS.light;
    m.setAttribute('content', t === 'system' ? sys : COLORS[t]);
  });
}

export function useTheme() {
  const [theme, setThemeState] = useState<Theme>(getTheme);
  const setTheme = (t: Theme) => {
    try {
      if (t === 'system') localStorage.removeItem(KEY);
      else localStorage.setItem(KEY, t);
    } catch {
      /* private mode: still applies for this visit */
    }
    applyTheme(t);
    setThemeState(t);
  };
  return [theme, setTheme] as const;
}
