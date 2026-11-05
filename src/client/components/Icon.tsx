const PATHS: Record<string, string> = {
  chevron: 'M6 4l4 4-4 4',
  menu: 'M3 5h14M3 10h14M3 15h14',
  search: 'M9 15A6 6 0 1 0 9 3a6 6 0 0 0 0 12zm4.5-1.5L17 17',
  edit: 'M4 14.5V17h2.5L15 8.5 12.5 6 4 14.5zM14 4.5 15.5 3 18 5.5 16.5 7',
  more: 'M5 10h.01M10 10h.01M15 10h.01',
  close: 'M5 5l10 10M15 5L5 15',
  folder: 'M3 6.5V15a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8a1 1 0 0 0-1-1H9.5L8 5H4a1 1 0 0 0-1 1.5z',
  page: 'M6 3h6l4 4v10H6zM12 3v4h4',
  link: 'M8.5 11.5l3-3M7 9l-1.5 1.5a2.5 2.5 0 0 0 3.5 3.5L10.5 12.5M13 11l1.5-1.5a2.5 2.5 0 0 0-3.5-3.5L9.5 7.5',
  copy: 'M7 7h9v9H7zM4 13V4h9',
  expand: 'M4 8V4h4M16 12v4h-4M4 4l5 5M16 16l-5-5',
  download: 'M10 3v10M6 9l4 4 4-4M4 16h12',
  panel: 'M3 4h14v12H3zM12 4v12',
  graph: 'M5 5h.01M15 5h.01M10 15h.01M5 5l5 10 5-10',
  history: 'M3 10a7 7 0 1 0 2-4.9M3 4v3h3M10 6v4l3 2',
  sun: 'M10 14a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM10 1v2M10 17v2M1 10h2M17 10h2',
  table: 'M3 4h14v12H3zM3 8h14M3 12h14M8 4v12',
  plus: 'M10 4v12M4 10h12',
  trash: 'M4 6h12M8 6V4h4v2M6 6l1 11h6l1-11',
  image: 'M3 4h14v12H3zM3 13l4-4 3 3 2-2 5 5M13 8h.01',
  settings:
    'M10 13a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM10 2v2M10 16v2M2 10h2M16 10h2M4.3 4.3l1.4 1.4M14.3 14.3l1.4 1.4M4.3 15.7l1.4-1.4M14.3 5.7l1.4-1.4',
  logout: 'M8 4H4v12h4M13 6l4 4-4 4M17 10H8',
  home: 'M3 9l7-6 7 6v8H3zM8 17v-5h4v5',
  check: 'M4 10l4 4 8-8',
  sparkle: 'M10 3l1.8 4.2L16 9l-4.2 1.8L10 15l-1.8-4.2L4 9l4.2-1.8z',
  bolt: 'M11 2L4 11h5l-1 7 7-9h-5z',
  coffee:
    'M3.5 7.5h11v4a4 4 0 0 1-4 4h-3a4 4 0 0 1-4-4zM14.5 8.5h1a2 2 0 0 1 0 4h-1M7 3v2M10.5 3v2',
};

export function Icon({ name, size = 16, label }: { name: string; size?: number; label?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden={label ? undefined : true}
      role={label ? 'img' : undefined}
      aria-label={label}
    >
      <path d={PATHS[name] ?? PATHS.page} />
    </svg>
  );
}

/** A page's emoji icon, or a page/folder outline when it has none. */
export function PageGlyph({ icon, folder }: { icon: string | null; folder: boolean }) {
  if (icon)
    return (
      <span className="glyph" aria-hidden>
        {icon}
      </span>
    );
  return (
    <span className="glyph">
      <Icon name={folder ? 'folder' : 'page'} size={15} />
    </span>
  );
}
