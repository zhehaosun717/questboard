// oh-my-openagent (OMO) model assignments for OpenCode: which model and reasoning level each agent and task
// category uses. The file is JSONC; saving rewrites it as JSON (comments are not kept) after a timestamped
// backup, keeping the newest eight backups.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { writeJsonAtomic } from '../core/jsonl.js';

export const SECTIONS = Object.freeze(['agents', 'categories']);
export const REASONING = Object.freeze(['max', 'xhigh', 'high', 'medium', 'low', 'minimal', 'off', 'auto']);
const NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const MODEL_PATTERN = /^[\w.@:+-]+\/[\w./@:+-]{1,200}$/;
const KEEP_BACKUPS = 8;

export function omoConfigFile({ env = process.env, homedir = os.homedir() } = {}) {
  return env.OMO_CONFIG ? path.resolve(env.OMO_CONFIG) : path.join(homedir, '.omo', 'omo.jsonc');
}

// Removes // and /* */ comments outside strings, then trailing commas.
export function stripJsonc(source) {
  let out = '';
  let inString = false;
  let escaped = false;
  let line = false;
  let block = false;
  for (let i = 0; i < source.length; i += 1) {
    const c = source[i];
    const next = source[i + 1];
    if (line) { if (c === '\n') { line = false; out += c; } continue; }
    if (block) { if (c === '*' && next === '/') { block = false; i += 1; } continue; }
    if (inString) {
      out += c;
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') { inString = true; out += c; continue; }
    if (c === '/' && next === '/') { line = true; i += 1; continue; }
    if (c === '/' && next === '*') { block = true; i += 1; continue; }
    out += c;
  }
  return out.replace(/,(\s*[}\]])/g, '$1');
}

function readRaw(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  try {
    const value = JSON.parse(stripJsonc(text));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('not an object');
    return value;
  } catch (error) {
    throw new Error(`OMO 配置 ${file} 读不懂：${error.message}`);
  }
}

export function readOmo(file) {
  const raw = readRaw(file);
  if (!raw) return { available: false, file, agents: [], categories: [] };
  const opencode = raw['[opencode]'] && typeof raw['[opencode]'] === 'object' ? raw['[opencode]'] : {};
  const list = (section) => Object.entries(opencode[section] && typeof opencode[section] === 'object' ? opencode[section] : {})
    .map(([name, entry]) => ({ name, model: entry && typeof entry.model === 'string' ? entry.model : '', reasoning: entry && typeof entry.reasoning === 'string' ? entry.reasoning : '' }))
    .sort((a, b) => a.name.localeCompare(b.name));
  return { available: true, file, agents: list('agents'), categories: list('categories') };
}

export function validateOmoItems(items) {
  if (!Array.isArray(items) || !items.length || items.length > 200) return 'items must be a non-empty array of at most 200 entries';
  for (const [index, item] of items.entries()) {
    const at = `items[${index}]`;
    if (!item || typeof item !== 'object') return `${at} must be an object`;
    if (!SECTIONS.includes(item.section)) return `${at}.section must be one of ${SECTIONS.join('|')}`;
    if (!NAME_PATTERN.test(item.name || '')) return `${at}.name must match ${NAME_PATTERN}`;
    if (typeof item.model !== 'string' || (item.model && !MODEL_PATTERN.test(item.model))) return `${at}.model must be empty or provider/model`;
    if (typeof item.reasoning !== 'string' || (item.reasoning && !REASONING.includes(item.reasoning))) return `${at}.reasoning must be empty or one of ${REASONING.join('|')}`;
  }
  return null;
}

function backup(file, now) {
  const stamp = new Date(now).toISOString().replace(/[:.]/g, '-');
  fs.copyFileSync(file, `${file}.bak-${stamp}`);
  const dir = path.dirname(file);
  const prefix = `${path.basename(file)}.bak-`;
  const old = fs.readdirSync(dir).filter((name) => name.startsWith(prefix)).sort().reverse().slice(KEEP_BACKUPS);
  for (const name of old) fs.rmSync(path.join(dir, name), { force: true });
}

// Applies model/reasoning changes to existing or new entries; an entry left with neither is removed. Other
// keys in the file (and in each entry) are kept.
export function saveOmo(file, items, { now = Date.now() } = {}) {
  const problem = validateOmoItems(items);
  if (problem) throw new Error(problem);
  const raw = readRaw(file);
  if (!raw) throw new Error(`没有 OMO 配置文件 ${file}`);
  const opencode = { ...(raw['[opencode]'] || {}) };
  for (const item of items) {
    const section = { ...(opencode[item.section] || {}) };
    const entry = { ...(section[item.name] || {}) };
    if (item.model) entry.model = item.model; else delete entry.model;
    if (item.reasoning) entry.reasoning = item.reasoning; else delete entry.reasoning;
    if (Object.keys(entry).length) section[item.name] = entry; else delete section[item.name];
    opencode[item.section] = section;
  }
  backup(file, now);
  writeJsonAtomic(file, { ...raw, '[opencode]': opencode });
  return readOmo(file);
}

// `opencode models` prints one provider/model per line.
export function parseModelList(text) {
  const seen = new Set();
  for (const line of String(text).split(/\r?\n/)) {
    const match = line.trim().match(/^([^\s/]+\/\S+)$/);
    if (match) seen.add(match[1]);
  }
  return [...seen];
}
