import { parse as parseYaml } from 'yaml';
import type { NitrogenConfig } from './types.ts';

export const DEFAULT_CONFIG: NitrogenConfig = {
  version: 1,
  default_branch: 'main',
  assets_dir: 'images',
  ignore: ['.github', '.nitrogen', 'images', 'node_modules'],
  link_relations: ['related', 'supersedes', 'depends-on', 'contradicts', 'implements', 'cites'],
  default_profile: 'gfm',
  page_size_warn_kb: 200,
  image_max_px: 2000,
  image_formats: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'svg'],
  actors: { human_label: 'You', claude_label: 'Claude' },
};

const KNOWN = new Set(Object.keys(DEFAULT_CONFIG));

export interface ConfigResult {
  config: NitrogenConfig;
  warnings: string[];
  errors: string[];
}

/** Parse `.nitrogen/config.yml`. Invalid values fall back to defaults with an error message. */
export function parseConfig(text: string | null | undefined): ConfigResult {
  const warnings: string[] = [];
  const errors: string[] = [];
  const config: NitrogenConfig = structuredClone(DEFAULT_CONFIG);
  if (!text || !text.trim()) return { config, warnings, errors };
  let raw: unknown;
  try {
    raw = parseYaml(text);
  } catch (e) {
    errors.push(`config.yml is not valid YAML: ${(e as Error).message}`);
    return { config, warnings, errors };
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    errors.push('config.yml must be a mapping.');
    return { config, warnings, errors };
  }
  const r = raw as Record<string, unknown>;
  for (const k of Object.keys(r)) if (!KNOWN.has(k)) warnings.push(`Unknown config key "${k}" is ignored.`);
  if (r.version !== undefined && r.version !== 1) errors.push('config version must be 1.');
  const str = (k: keyof NitrogenConfig) => {
    if (r[k] === undefined) return;
    if (typeof r[k] === 'string' && r[k]) (config as unknown as Record<string, unknown>)[k] = r[k];
    else errors.push(`"${k}" must be a non-empty string.`);
  };
  const strList = (k: keyof NitrogenConfig) => {
    if (r[k] === undefined) return;
    if (Array.isArray(r[k]) && (r[k] as unknown[]).every((x) => typeof x === 'string'))
      (config as unknown as Record<string, unknown>)[k] = r[k];
    else errors.push(`"${k}" must be a list of strings.`);
  };
  const int = (k: keyof NitrogenConfig) => {
    if (r[k] === undefined) return;
    if (Number.isInteger(r[k]) && (r[k] as number) > 0) (config as unknown as Record<string, unknown>)[k] = r[k];
    else errors.push(`"${k}" must be a positive integer.`);
  };
  str('default_branch');
  str('assets_dir');
  config.assets_dir = config.assets_dir.replace(/^\/+|\/+$/g, '');
  strList('ignore');
  strList('link_relations');
  strList('image_formats');
  int('page_size_warn_kb');
  int('image_max_px');
  if (r.default_profile !== undefined) {
    if (r.default_profile === 'gfm' || r.default_profile === 'commonmark') config.default_profile = r.default_profile;
    else errors.push('"default_profile" must be gfm or commonmark.');
  }
  if (!config.link_relations.includes('related')) config.link_relations = ['related', ...config.link_relations];
  if (r.actors && typeof r.actors === 'object') {
    const a = r.actors as Record<string, unknown>;
    if (typeof a.human_label === 'string') config.actors.human_label = a.human_label;
    if (typeof a.claude_label === 'string') config.actors.claude_label = a.claude_label;
  }
  return { config, warnings, errors };
}

/** Serialize a config back to YAML (used by `nitrogen init`). */
export function formatConfig(c: NitrogenConfig): string {
  const list = (xs: string[]) => `[${xs.map((x) => (/^[a-z0-9_-]+$/i.test(x) ? x : JSON.stringify(x))).join(', ')}]`;
  return [
    `version: ${c.version}`,
    `default_branch: ${c.default_branch}`,
    `assets_dir: ${c.assets_dir}`,
    `ignore: ${list(c.ignore)}`,
    `link_relations: ${list(c.link_relations)}`,
    `default_profile: ${c.default_profile}`,
    `page_size_warn_kb: ${c.page_size_warn_kb}`,
    `image_max_px: ${c.image_max_px}`,
    `image_formats: ${list(c.image_formats)}`,
    'actors:',
    `  human_label: ${JSON.stringify(c.actors.human_label)}`,
    `  claude_label: ${JSON.stringify(c.actors.claude_label)}`,
    '',
  ].join('\n');
}
