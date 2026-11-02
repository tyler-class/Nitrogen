export interface TreePage {
  path: string;
  title: string;
  icon: string | null;
  ord: number | null;
  status: string | null;
  pinned: boolean;
  locked: boolean;
  tags: string[];
  aliases: string[];
}

export interface TreeResponse {
  head: string | null;
  pages: TreePage[];
  config: { assets_dir: string; link_relations: string[]; default_profile: 'gfm' | 'commonmark'; image_max_px: number; image_formats: string[]; page_size_warn_kb: number; actors: { human_label: string; claude_label: string } };
}

export interface LinkCtx {
  rel: string;
  text: string;
  ctx: string;
  frag: string | null;
  line: number;
  broken?: boolean;
}

export interface LinkGroup {
  path: string;
  title: string | null;
  count: number;
  links: LinkCtx[];
}

export interface PageResponse {
  path: string;
  sha: string;
  content: string;
  meta: TreePage & { excerpt: string | null; size: number | null; updated_at: string | null; last_actor: string | null };
  backlinks: LinkGroup[];
  outline: { slug: string; text: string; level: number }[];
}

export interface ActivityRow {
  id: number;
  sha: string;
  actor: 'human' | 'claude' | 'external';
  client: string | null;
  tool: string | null;
  op: string;
  path: string | null;
  message: string;
  files: number;
  at: string;
}

export interface Me {
  user: { id: number; login: string; name?: string; avatar?: string };
  mcpUrl: string;
  repo: string;
  branch: string;
  version: string;
}
