export {
  parseMdast,
  calloutLabel,
  parseCalloutMarker,
  parseImageFragment,
  parseRel,
  parseTableDirective,
  resolveLink,
  resolveWikilink,
  splitImageSrc,
  stripQuote,
  createSlugger,
  isExternal,
  WIKILINK_RE,
  CALLOUT_TYPES,
  parseFrontmatter,
  findTags,
  type VaultContext,
} from '@nitrogen/core';
import { parseFrontmatter } from '@nitrogen/core';

export function frontmatterOf(src: string): Record<string, unknown> {
  return parseFrontmatter(src).data;
}
