#!/usr/bin/env node
// Selfhost Kit: synced from tyler-class/selfhost-kit (kit/scripts/merge-wrangler.mjs).
//
// An update brings in the app's latest wrangler.jsonc (new crons, bindings, settings) but
// keeps what the Deploy button wrote into this copy's: the Worker's name, its own database,
// KV namespace and bucket names and ids, and its own values for settings in `vars` (such as
// Nitrogen's SEARCH_INSTANCE). Comments and layout stay as upstream has them. Used by .github/workflows/update.yml:
//   node scripts/kit/merge-wrangler.mjs <this copy's old wrangler.jsonc> wrangler.jsonc
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

/** JSONC → object (comments and trailing commas removed). */
export function parseJsonc(text) {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      const start = i;
      for (i++; i < text.length && text[i] !== '"'; i++) if (text[i] === '\\') i++;
      out += text.slice(start, i + 1);
    } else if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      out += '\n';
    } else if (c === '/' && text[i + 1] === '*') {
      i = text.indexOf('*/', i + 2) + 1;
    } else out += c;
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1'));
}

/** Positions of code (not strings or comments), with their brace depth. */
function scan(text, visit) {
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      const start = i;
      for (i++; i < text.length && text[i] !== '"'; i++) if (text[i] === '\\') i++;
      if (visit(start, depth, i) === false) return;
    } else if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
    } else if (c === '/' && text[i + 1] === '*') {
      i = text.indexOf('*/', i + 2) + 1;
    } else if (c === '{' || c === '[') depth++;
    else if (c === '}' || c === ']') depth--;
  }
}

const quote = (v) => JSON.stringify(v);

/** Sets "key": value inside the object spanning [from, to), adding it after `after` if missing. */
function setIn(text, from, to, key, value, after) {
  let found = null;
  scan(text.slice(from, to), (s, depth, e) => {
    if (depth === 1 && text.slice(from + s, from + e + 1) === quote(key)) {
      found = from + e + 1;
      return false;
    }
  });
  if (found !== null) {
    const m = /^(\s*:\s*)("(?:[^"\\]|\\.)*")/.exec(text.slice(found));
    if (m) return text.slice(0, found) + m[1] + quote(value) + text.slice(found + m[0].length);
  }
  const at = after;
  return `${text.slice(0, at)} ${quote(key)}: ${quote(value)},${text.slice(at)}`;
}

/** [start, end) of the object holding "binding": "<name>" inside the named top-level array. */
function bindingObject(text, section, name) {
  let arrayAt = -1;
  scan(text, (s, depth, e) => {
    if (depth === 1 && text.slice(s, e + 1) === quote(section)) {
      arrayAt = e;
      return false;
    }
  });
  if (arrayAt < 0) return null;
  const re = new RegExp(
    `"binding"\\s*:\\s*${quote(name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*,?`,
    'g',
  );
  re.lastIndex = arrayAt;
  const m = re.exec(text);
  if (!m) return null;
  // The enclosing { … }.
  let start = m.index;
  for (let d = 0; start > arrayAt; start--) {
    if (text[start] === '}') d++;
    if (text[start] === '{' && d-- === 0) break;
  }
  let end = m.index;
  for (let d = 0; end < text.length; end++) {
    if (text[end] === '{') d++;
    if (text[end] === '}' && d-- === 0) break;
  }
  // Inserting right after `"binding": "X",` keeps the object valid.
  const after = m[0].trimEnd().endsWith(',') ? m.index + m[0].trimEnd().length : -1;
  return { start, end: end + 1, after };
}

/** [start, end) of the object that is the value of a top-level key, e.g. "vars". */
function topObject(text, key) {
  let keyEnd = -1;
  scan(text, (s, depth, e) => {
    if (depth === 1 && text.slice(s, e + 1) === quote(key)) {
      keyEnd = e;
      return false;
    }
  });
  if (keyEnd < 0) return null;
  const open = text.indexOf('{', keyEnd);
  if (open < 0 || text.slice(keyEnd + 1, open).trim() !== ':') return null;
  let end = -1;
  for (let d = 0, i = open; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      for (i++; i < text.length && text[i] !== '"'; i++) if (text[i] === '\\') i++;
    } else if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
    } else if (c === '/' && text[i + 1] === '*') {
      i = text.indexOf('*/', i + 2) + 1;
    } else if (c === '{') d++;
    else if (c === '}' && --d === 0) {
      end = i;
      break;
    }
  }
  return end < 0 ? null : { start: open, end: end + 1 };
}

const KEEP = {
  d1_databases: ['database_name', 'database_id'],
  kv_namespaces: ['id'],
  r2_buckets: ['bucket_name'],
};

/** The upstream config text, with this copy's name, ids and resource names put back in. */
export function mergeWrangler(copyText, upstreamText) {
  const copy = parseJsonc(copyText);
  let text = upstreamText;
  if (typeof copy.name === 'string') {
    let done = false;
    scan(text, (s, depth, e) => {
      if (done || depth !== 1 || text.slice(s, e + 1) !== '"name"') return;
      const m = /^(\s*:\s*)("(?:[^"\\]|\\.)*")/.exec(text.slice(e + 1));
      if (m) {
        text = text.slice(0, e + 1) + m[1] + quote(copy.name) + text.slice(e + 1 + m[0].length);
        done = true;
        return false;
      }
    });
  }
  for (const [section, keys] of Object.entries(KEEP)) {
    for (const entry of copy[section] ?? []) {
      if (!entry?.binding) continue;
      for (const key of keys) {
        if (typeof entry[key] !== 'string') continue;
        const obj = bindingObject(text, section, entry.binding);
        if (!obj) continue; // upstream dropped this binding
        if (obj.after < 0) continue; // unusual layout: leave it to Wrangler
        text = setIn(text, obj.start, obj.end, key, entry[key], obj.after);
      }
    }
  }
  // Settings in `vars`: the copy's value wins for every key upstream still has (a copy may
  // have set its own on the Deploy form, like Nitrogen's SEARCH_INSTANCE). New upstream keys
  // come in with upstream's value; keys upstream dropped stay dropped.
  const upstreamVars = parseJsonc(text).vars ?? {};
  for (const [key, value] of Object.entries(copy.vars ?? {})) {
    if (typeof value !== 'string' || typeof upstreamVars[key] !== 'string') continue;
    if (upstreamVars[key] === value) continue;
    const obj = topObject(text, 'vars');
    if (!obj) break;
    text = setIn(text, obj.start, obj.end, key, value, -1);
  }
  parseJsonc(text); // still valid
  return text;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [copyPath, upstreamPath] = process.argv.slice(2);
  if (!copyPath || !upstreamPath) {
    console.error('Usage: merge-wrangler.mjs <copy wrangler.jsonc> <upstream wrangler.jsonc>');
    process.exit(2);
  }
  writeFileSync(
    upstreamPath,
    mergeWrangler(readFileSync(copyPath, 'utf8'), readFileSync(upstreamPath, 'utf8')),
  );
  console.log('Kept this copy’s name, ids and resource names in the new wrangler.jsonc.');
}
