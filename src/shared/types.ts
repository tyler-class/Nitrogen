/** A page as listed in the tree: everything except the body. */
export interface PageSummary {
  id: string;
  parent_id: string | null;
  position: number;
  title: string;
  icon: string | null;
  updated_at: string;
  /** Encoded actor ('you' | 'agent:<name>'), null if unknown. See shared/actor.ts. */
  updated_by: string | null;
  pinned_at: string | null;
}

export interface Page extends PageSummary {
  body: string;
  version: number;
  created_at: string;
  created_by: string | null;
  /** Tags set on the page itself. #tags in the body are in PageDetail.tags too. */
  tags: string[];
  words: number;
}

export interface PageDetail {
  page: Page;
  /** Root first, ending with the page's parent. */
  ancestors: PageSummary[];
  children: PageSummary[];
  backlinks: PageSummary[];
  /** Every tag: the page's own plus #tags in the body, sorted. */
  all_tags: string[];
}

export interface TreeResponse {
  pages: PageSummary[];
  home_id: string | null;
}

export interface Revision {
  id: number;
  version: number;
  title: string;
  created_at: string;
  /** Who wrote this version (encoded actor), null if unknown. */
  actor: string | null;
}

export interface RevisionDetail extends Revision {
  body: string;
}

export interface SearchHit {
  id: string;
  title: string;
  icon: string | null;
  /** Plain text around the match. Keyword hits mark matches with \u0001…\u0002. */
  snippet: string;
  /** Titles from the top of the tree down to the page's parent. */
  path: string[];
  score: number;
  source: 'keyword' | 'semantic';
}

export interface SearchResponse {
  query: string;
  mode: 'keyword' | 'semantic' | 'hybrid';
  hits: SearchHit[];
  /** Set when semantic search was asked for but could not run (local dev, quota, not yet indexed). */
  semantic_unavailable?: string;
}

export interface UploadedFile {
  key: string;
  url: string;
  name: string;
  content_type: string;
  size: number;
  /** Ready to paste into a page body. */
  markdown: string;
}

export interface SearchStatus {
  available: boolean;
  instance: string;
  pending: number;
  message?: string;
}

export interface Backup {
  format: 'nitrogen-backup';
  version: 1;
  exported_at: string;
  pages: Page[];
  /** Images are not inlined; they stay in R2 and are listed so a restore can check them. */
  files: {
    key: string;
    page_id: string | null;
    name: string;
    content_type: string;
    size: number;
  }[];
}

export type EventAction = 'create' | 'edit' | 'move' | 'delete' | 'restore';

export interface PageEvent {
  id: number;
  page_id: string;
  title: string;
  action: EventAction;
  actor: string | null;
  started_at: string;
  created_at: string;
  /** False once the page has been deleted. */
  exists: boolean;
}

/** Consecutive events by one actor with gaps under an hour. */
export interface Session {
  actor: string | null;
  start: string;
  end: string;
  events: PageEvent[];
}

export interface RevertResult {
  restored: string[];
  deleted: string[];
  skipped: { title: string; reason: string }[];
}

export interface InboxItem extends PageSummary {
  /** True if the page is new since you last looked, false if it was only changed. */
  is_new: boolean;
}

export type DashboardSectionId = 'stats' | 'inbox' | 'pinned' | 'activity';
export interface DashboardSection {
  id: DashboardSectionId;
  on: boolean;
}

export interface Dashboard {
  sections: DashboardSection[];
  stats: {
    pages: number;
    words: number;
    edits_week: number;
    agent_edits_week: number;
    tags: number;
  };
  inbox: InboxItem[];
  pinned: PageSummary[];
  activity: PageEvent[];
}

export interface TagCount {
  tag: string;
  count: number;
}

export interface Mention {
  id: string;
  title: string;
  icon: string | null;
  snippet: string;
}

export interface RelatedPage {
  id: string;
  title: string;
  icon: string | null;
  path: string[];
  snippet: string;
}

export interface GraphNode {
  id: string;
  title: string;
  icon: string | null;
  /** Hops from the centre page. */
  depth: number;
}
export interface GraphEdge {
  source: string;
  target: string;
  kind: 'link' | 'tree';
}
export interface Graph {
  center: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
  truncated: boolean;
}

export interface Insights {
  /** One entry per day with activity, oldest first (last 365 days). */
  days: { day: string; you: number; agents: number }[];
  authors: { actor: string | null; edits: number; created: number }[];
  most_edited: { id: string; title: string; icon: string | null; edits: number }[];
  most_linked: { id: string; title: string; icon: string | null; backlinks: number }[];
  neglected: { id: string; title: string; icon: string | null; updated_at: string }[];
  orphans: { count: number; pages: { id: string; title: string; icon: string | null }[] };
  /** Pages and words that exist now, by month they were created. */
  growth: { month: string; pages: number; words: number }[];
  totals: { pages: number; words: number; links: number; tags: number; empty: number };
  biggest: { id: string; title: string; icon: string | null; words: number }[];
  /** Assistant searches that found nothing (last 90 days). */
  misses: { query: string; count: number; last: string }[];
}
