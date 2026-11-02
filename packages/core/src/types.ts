/** Shared types for the Nitrogen format engine. */

export type Severity = 'error' | 'warning';

export type LintCode =
  | 'E001' | 'E002' | 'E003' | 'E004' | 'E005' | 'E006' | 'E007' | 'E008' | 'E009' | 'E010'
  | 'W101' | 'W102' | 'W103' | 'W104' | 'W105' | 'W106' | 'W107' | 'W108' | 'W109' | 'W110';

export interface Diagnostic {
  code: LintCode;
  severity: Severity;
  message: string;
  /** 1-based line, 0 when the diagnostic is about the whole file. */
  line: number;
  /** 1-based column, 0 when unknown. */
  col: number;
  /** Human-readable fix suggestion. */
  fix?: string;
}

export interface PageMeta {
  title: string;
  icon?: string;
  order?: number;
  tags: string[];
  status?: string;
  aliases: string[];
  pinned: boolean;
  locked: boolean;
  updated?: string;
  /** Where the title came from. */
  titleSource: 'frontmatter' | 'h1' | 'filename';
}

export type FrontmatterValue = string | number | boolean | null | string[];

export interface Frontmatter {
  /** Raw frontmatter block including the `---` fences, or '' when absent. */
  raw: string;
  /** Number of lines the block spans (0 when absent). */
  lineCount: number;
  data: Record<string, FrontmatterValue>;
  errors: { line: number; message: string }[];
}

export interface HeadingInfo {
  level: number;
  text: string;
  slug: string;
  line: number;
}

export interface LinkInfo {
  /** Raw href as written (without the title). */
  href: string;
  text: string;
  title?: string;
  /** Relation parsed from a `rel:` title, defaults to related. */
  rel: string;
  /** True when rel came from an explicit `rel:` title. */
  relExplicit: boolean;
  line: number;
  col: number;
  external: boolean;
}

export interface ImageInfo {
  src: string;
  alt: string;
  title?: string;
  line: number;
  col: number;
  /** True when the image is the only content of its paragraph. */
  standalone: boolean;
}

export interface WikilinkInfo {
  raw: string;
  target: string;
  anchor?: string;
  label?: string;
  line: number;
  col: number;
}

export interface CalloutInfo {
  type: string;
  fold: '' | '+' | '-';
  title: string;
  line: number;
}

export interface DrawerInfo {
  attrs: Record<string, string>;
  line: number;
  /** Container the drawer sits in. */
  parent: 'root' | 'callout' | 'blockquote' | 'toggle' | 'drawer' | 'list' | 'other';
}

export interface TableDirectiveInfo {
  attrs: Record<string, string>;
  line: number;
  /** Number of columns of the table directly below, or null if none. */
  columns: number | null;
}

export interface HtmlInfo {
  /** Lowercase tag name, '!--' for comments. */
  tag: string;
  closing: boolean;
  line: number;
  col: number;
  /** Attribute names found on the tag. */
  attrs: string[];
}

export interface ToggleInfo {
  line: number;
  /** True when the body is not separated by blank lines. */
  missingBlankLines: boolean;
  summary: string;
}

/** Structural scan of a page shared by the full parser and the light scanner. */
export interface PageScan {
  frontmatter: Frontmatter;
  headings: HeadingInfo[];
  links: LinkInfo[];
  images: ImageInfo[];
  wikilinks: WikilinkInfo[];
  callouts: CalloutInfo[];
  drawers: DrawerInfo[];
  tableDirectives: TableDirectiveInfo[];
  html: HtmlInfo[];
  toggles: ToggleInfo[];
}

export interface NitrogenConfig {
  version: 1;
  default_branch: string;
  assets_dir: string;
  ignore: string[];
  link_relations: string[];
  default_profile: 'gfm' | 'commonmark';
  page_size_warn_kb: number;
  image_max_px: number;
  image_formats: string[];
  actors: { human_label: string; claude_label: string };
}

export interface VaultPage {
  path: string;
  title: string;
  aliases: string[];
  /** Heading slugs, used for anchor checks. Optional: anchors are not checked when absent. */
  slugs?: string[];
}

/** Everything core needs to know about the vault. Core never touches the network. */
export interface VaultContext {
  config: NitrogenConfig;
  pages: VaultPage[];
  images: string[];
}

export interface Fix {
  kind: 'wikilink' | 'image-fragment' | 'trailing-newline' | 'line-endings' | 'rename-suggestion';
  line: number;
  before: string;
  after: string;
}

export interface LedgerEntry {
  construct: string;
  action: string;
  line: number;
  lost?: string;
}
