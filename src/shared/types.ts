/** A page as listed in the tree: everything except the body. */
export interface PageSummary {
  id: string;
  parent_id: string | null;
  position: number;
  title: string;
  icon: string | null;
  updated_at: string;
}

export interface Page extends PageSummary {
  body: string;
  version: number;
  created_at: string;
}

export interface PageDetail {
  page: Page;
  /** Root first, ending with the page's parent. */
  ancestors: PageSummary[];
  children: PageSummary[];
  backlinks: PageSummary[];
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
