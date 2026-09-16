// The machine roster: which models exist and how they are reached. Facts only — no status, no dated
// owner notes (those are status records, see status.js).
import fs from 'node:fs';
import { writeJsonAtomic } from './jsonl.js';

const ID_PATTERN = /^[a-z0-9-]{1,48}$/;
const LANE_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;
export const BILLING = Object.freeze(['subscription', 'plan', 'payg', 'free']);

function fail(message) {
  throw new Error(`roster: ${message}`);
}

const ENV_NAME = /^[A-Z][A-Z0-9_]{0,63}$/;
// Obvious key shapes. This cannot catch every secret, which is exactly why the rule is "no secrets here":
// the roster is a plain file that travels between projects.
const LOOKS_LIKE_A_SECRET = /^(sk-|sk_|ghp_|gho_|github_pat_|xox[baprs]-|AIza|AKIA|glpat-)/;
const MAX_ENV = 10;

// A card may carry non-secret environment values (a base URL, an account id) so one generic lane can serve
// several providers. Keys belong in the machine environment, which the lane command already inherits.
export function validateCardEnv(entry, at) {
  if (entry.env === undefined) return;
  if (!entry.env || typeof entry.env !== 'object' || Array.isArray(entry.env)) fail(`${at}.env must be an object of NAME: value`);
  const names = Object.keys(entry.env);
  if (names.length > MAX_ENV) fail(`${at}.env may set at most ${MAX_ENV} variables`);
  for (const [name, value] of Object.entries(entry.env)) {
    if (!ENV_NAME.test(name)) fail(`${at}.env name "${name}" must be UPPER_SNAKE_CASE (letters, digits, underscore)`);
    if (typeof value !== 'string' || value.length > 200) fail(`${at}.env.${name} must be a string of at most 200 characters`);
    if (LOOKS_LIKE_A_SECRET.test(value)) fail(`${at}.env.${name} looks like a key. Put keys in the machine environment (the lane command inherits it); the roster is shared between projects and is not the place for secrets`);
  }
}

export function validateAdventurer(entry, where = 'adventurer') {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) fail(`${where} must be an object`);
  if (!ID_PATTERN.test(entry.id || '')) fail(`${where}.id must match ${ID_PATTERN}`);
  const at = `${where} (${entry.id})`;
  for (const field of ['name', 'provider', 'model', 'family']) {
    if (typeof entry[field] !== 'string' || !entry[field].trim()) fail(`${at}.${field} is required`);
  }
  if (!LANE_PATTERN.test(entry.lane || '')) fail(`${at}.lane must match ${LANE_PATTERN}`);
  if (entry.status !== undefined || entry.statusChangedAt !== undefined) {
    fail(`${at} has a status field; statuses are records in the status log (questboard status set ${entry.id} ...), not roster data`);
  }
  if (entry.billing !== undefined && !BILLING.includes(entry.billing)) fail(`${at}.billing must be one of ${BILLING.join('|')}`);
  if (entry.maxParallel !== undefined && (!Number.isInteger(entry.maxParallel) || entry.maxParallel < 1)) fail(`${at}.maxParallel must be a positive integer`);
  if (entry.strengths !== undefined && (!Array.isArray(entry.strengths) || entry.strengths.some((s) => typeof s !== 'string'))) fail(`${at}.strengths must be an array of strings`);
  if (entry.notes !== undefined && (typeof entry.notes !== 'string' || entry.notes.length > 300)) fail(`${at}.notes must be a string of at most 300 characters`);
  if (entry.variant !== undefined && typeof entry.variant !== 'string') fail(`${at}.variant must be a string`);
  if (entry.variants !== undefined) {
    if (!Array.isArray(entry.variants) || entry.variants.some((variant) => typeof variant !== 'string' || !variant.trim())) {
      fail(`${at}.variants must be an array of non-empty strings`);
    }
    if (new Set(entry.variants).size !== entry.variants.length) fail(`${at}.variants must not contain duplicate values`);
  }
  if (entry.agent !== undefined && typeof entry.agent !== 'string') fail(`${at}.agent must be a string`);
  validateCardEnv(entry, at);
  return entry;
}

export function validateRoster(value) {
  if (!value || typeof value !== 'object' || !Array.isArray(value.adventurers)) fail('adventurers array is required');
  value.adventurers.forEach((entry, index) => validateAdventurer(entry, `adventurers[${index}]`));
  const ids = value.adventurers.map((a) => a.id);
  const duplicate = ids.find((id, index) => ids.indexOf(id) !== index);
  if (duplicate) fail(`duplicate adventurer id ${duplicate}`);
  return value;
}

// A roster file that does not exist yet is a new machine, not missing data: the board opens with no cards so
// the owner can add the first one. A roster that exists but is malformed still fails loudly.
export function loadRosterOrEmpty(file) {
  return fs.existsSync(file) ? loadRoster(file) : { adventurers: [] };
}

export function loadRoster(file) {
  if (!fs.existsSync(file)) fail(`no roster at ${file}; create one with "questboard roster import <old roster.json>" or write it by hand`);
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    return fail(`cannot read ${file}: ${error.message}`);
  }
  return validateRoster(parsed);
}

export function saveRoster(file, roster) {
  writeJsonAtomic(file, validateRoster(roster));
  return roster;
}

export function upsertAdventurer(roster, entry) {
  validateAdventurer(entry);
  const exists = roster.adventurers.some((a) => a.id === entry.id);
  return validateRoster({
    ...roster,
    adventurers: exists ? roster.adventurers.map((a) => (a.id === entry.id ? { ...entry } : a)) : [...roster.adventurers, { ...entry }],
  });
}
