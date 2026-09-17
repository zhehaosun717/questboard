import { parseCardEnv } from './rosterForm';

export interface LaneDraft {
  id: string;
  /** Stable identity for this lane's UI, independent of the editable `id` field. Never written to the saved
   * config; only used as a React list key so delete/rename/reset cannot swap one card's local state (e.g. the
   * health checkbox's open/closed flag) onto a different lane. */
  formKey: string;
  /** The key this lane was loaded under. Used to find the lane's own original data in `toRaw`, so renaming
   * `id` mid-edit does not orphan its unknown fields (health included) onto whatever the old key now
   * resolves to. `null` for a lane added this session — it has no original data to inherit, so `toRaw` must
   * not look one up by key: a freshly generated id could otherwise collide with a since-deleted lane's own
   * original key and silently pick up that lane's unknown fields once renamed. */
  originalId: string | null;
  run: string[];
  outputDir: string;
  api: string;
  /** lanes.<id>.protocol (src/core/config.js): which server contract `api` speaks. Empty or absent means
   * "not set" — the default (`opencode-session`, the only accepted value today) applies. Only meaningful
   * with `api`. Optional (rather than required like the other string fields) so existing call sites that
   * build a `LaneDraft` literal without it — added before this field existed — still type-check. */
  protocol?: string;
  /** The command that starts this lane's server; only for lanes with api. */
  serve: string[];
  deliveryDir: string;
  defaultModel: string;
  editCounter: string;
  serialize: boolean;
  spacingMs: string;
  env: string;
  sessionRun: string[];
  sessionSaveTo: string;
  /** Relative to `api`, e.g. /global/health. Empty means no health contract (legacy: any HTTP reply counts). */
  healthPath: string;
  /** JSON text for the fields the health reply must match, e.g. {"healthy":true}. Empty means no field check. */
  healthJson: string;
  /** The raw `health` value from the file when it does not have a usable string `path` (not an object, an
   * array, null, `{}`, `{path:""}`, or an object with only unrelated keys). Kept so a hand-edited mistake is
   * shown and preserved byte-for-byte in `toRaw` instead of silently vanishing, until the owner either types a
   * working path (repair) or unchecks the box (explicit disable, which clears this alongside the two fields
   * above). `undefined` means the file's `health` (if any) already parsed into `healthPath`/`healthJson`. */
  healthMalformed?: unknown;
  /** Optional argument groups spliced into run when variant/agent conditions match. */
  optionalArgs?: OptionalArgGroupDraft[];
  /** A non-array optionalArgs value from a hand-edited file, retained until it is explicitly removed. */
  optionalArgsMalformed?: unknown;
}

export interface OptionalArgGroupDraft {
  when: string;
  args: string[];
  omitWhen: string[];
  insertAt?: number;
  /** Present only when the group could not be mapped to editable fields. */
  parseError?: string;
  rawOptionalArg?: unknown;
  [key: string]: unknown;
}

export interface ProjectDraft {
  name: string;
  port: string;
  dataDir: string;
  events: string;
  registry: string;
  lockFile: string;
  bash: string;
}

export interface BriefsDraft {
  dispatchDirs: string;
  ownerDirs: string;
  packagePattern: string;
  fileListHeading: string;
  recentDays: string;
}

export interface ReviewDraft {
  dir: string;
}

export interface LaneConcurrencyDraft {
  lane: string;
  limit: string;
}

export interface BouncePatternDraft {
  code: string;
  pattern: string;
  label: string;
}

export interface PolicyDraft {
  bannedModelPatterns: string[];
  bannedAgents: string[];
  stallAfterMinutes: string;
  laneConcurrency: LaneConcurrencyDraft[];
  defaultLane: string;
  defaultCard: string;
  bouncePatterns: BouncePatternDraft[];
}

export interface UsageDraft {
  manualProviders: string[];
  alibabaEdition: string;
  alibabaRegion: string;
}

export interface VerificationHookDraft {
  id: string;
  command: string[];
  timeoutSeconds: string;
  cwd: string;
  envKeys: string[];
  kinds: string[];
  trigger: string;
  enabled: boolean;
  unknownFields: Record<string, unknown>;
}

export interface VerificationDraft {
  hooks: VerificationHookDraft[];
}

export interface SettingsDrafts {
  project: ProjectDraft;
  briefs: BriefsDraft;
  lanes: LaneDraft[];
  policy: PolicyDraft;
  review: ReviewDraft;
  usage: UsageDraft;
  verification: VerificationDraft;
}

const LANE_ID_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;
// Roster card ids (src/core/roster.js ID_PATTERN); the form only checks the shape — the roster itself is machine-level.
const CARD_ID_PATTERN = /^[a-z0-9-]{1,48}$/;
// Structured bounce codes (src/core/config.js BOUNCE_CODE).
const BOUNCE_CODE_PATTERN = /^[a-z][a-z0-9_]*$/;
// Matches the service contract in config.js: a single leading slash, never a second slash, no backslash and
// no whitespace. The path is joined onto the lane's own `api` by plain concatenation (`${api}${path}`), so a
// path that cannot start a new host (no `//`) or hide one behind an escape (no `\`) can never redirect the
// health check elsewhere — a query string containing "://" is still just a local path.
const HEALTH_PATH_PATTERN = /^\/(?!\/)[^\s\\]*$/;
// Matches src/core/config.js's LANE_PROTOCOLS: the only server contract the board knows how to speak today.
export const LANE_PROTOCOLS = ['opencode-session'] as const;
export const DEFAULT_LANE_PROTOCOL = 'opencode-session';
// protocol only exists alongside api (LaneDraft.protocol), so every edit to the api field goes through this
// instead of a bare `{ api }` patch: clearing api must clear protocol too, or Save is left refusing a field
// the api-less card no longer even shows.
export function apiFieldPatch(api: string): Partial<LaneDraft> {
  return api.trim() ? { api } : { api, protocol: '' };
}
const str = (v: unknown): string => (typeof v === 'string' ? v : v !== undefined && v !== null ? String(v) : '');
const strList = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : []);
const isPlainObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const OPTIONAL_ARG_WHEN = new Set(['variant', 'agent']);
const OPTIONAL_ARG_KEYS = new Set(['when', 'args', 'omitWhen', 'insertAt']);
const VERIFICATION_HOOK_KEYS = new Set(['id', 'command', 'timeoutSeconds', 'cwd', 'envKeys', 'kinds', 'trigger', 'enabled']);

export function parseLaneEnv(text: string): { env: Record<string, string>; error: string | null } {
  return parseCardEnv(text);
}

function malformedOptionalArg(raw: unknown, reason: string): OptionalArgGroupDraft {
  const value = isPlainObject(raw) ? raw : {};
  const args = Array.isArray(value.args) && value.args.every((arg) => typeof arg === 'string') ? [...value.args] : [];
  const omitWhen = Array.isArray(value.omitWhen) && value.omitWhen.every((item) => typeof item === 'string') ? [...value.omitWhen] : [];
  const draft: OptionalArgGroupDraft = {
    when: typeof value.when === 'string' ? value.when : '',
    args,
    omitWhen,
    ...(typeof value.insertAt === 'number' && Number.isInteger(value.insertAt) ? { insertAt: value.insertAt } : {}),
    parseError: `可选参数组无法解析，已原样保留：${reason}`,
    rawOptionalArg: raw,
  };
  for (const [key, entry] of Object.entries(value)) {
    if (!OPTIONAL_ARG_KEYS.has(key) && key !== 'parseError' && key !== 'rawOptionalArg') draft[key] = entry;
  }
  return draft;
}

function parseOptionalArg(raw: unknown): OptionalArgGroupDraft {
  if (!isPlainObject(raw)) return malformedOptionalArg(raw, '必须是对象');
  if (typeof raw.when !== 'string' || !OPTIONAL_ARG_WHEN.has(raw.when)) return malformedOptionalArg(raw, 'when 必须是 variant 或 agent');
  if (!Array.isArray(raw.args) || raw.args.length === 0 || raw.args.some((arg) => typeof arg !== 'string')) {
    return malformedOptionalArg(raw, 'args 必须是非空字符串列表');
  }
  if (raw.omitWhen !== undefined && (!Array.isArray(raw.omitWhen) || raw.omitWhen.some((item) => typeof item !== 'string'))) {
    return malformedOptionalArg(raw, 'omitWhen 必须是字符串列表');
  }
  if (raw.insertAt !== undefined && (typeof raw.insertAt !== 'number' || !Number.isInteger(raw.insertAt))) {
    return malformedOptionalArg(raw, 'insertAt 必须是整数');
  }
  const { args, omitWhen, insertAt, ...unknownFields } = raw;
  return {
    ...unknownFields,
    when: raw.when,
    args: [...args],
    omitWhen: omitWhen === undefined ? [] : [...omitWhen],
    ...(insertAt === undefined ? {} : { insertAt }),
  };
}

// Names what is wrong with a hand-edited `health` value that has no usable string `path`, for the message
// shown next to the checkbox — matches config.js's own order of complaints (must be an object, then path).
export function describeMalformedHealth(value: unknown): string {
  if (Array.isArray(value)) return '必须是一个对象，现在是数组';
  if (value === null) return '必须是一个对象，现在是 null';
  if (typeof value !== 'object') return `必须是一个对象，现在是 ${JSON.stringify(value)}`;
  const obj = value as Record<string, unknown>;
  if (!('path' in obj)) {
    return Object.keys(obj).length > 0 ? '对象里没有可用的 path 字段（其他字段会保留）' : '是空对象，没有 path 字段';
  }
  if (typeof obj.path !== 'string') return 'path 必须是字符串';
  return 'path 不能是空字符串';
}

let formKeySeq = 0;
// Not derived from the editable `id` field (which can be blank or duplicated mid-edit) and never persisted.
export function createLaneFormKey(): string {
  formKeySeq += 1;
  return `form-${formKeySeq}`;
}

export function isLocalHealthPath(healthPath: string): boolean {
  return HEALTH_PATH_PATTERN.test(healthPath);
}

// Matches config.js's health-api check: with a health path set, the api origin it gets concatenated with
// must not end in a way that makes the join ambiguous.
export function healthApiError(api: string): string | null {
  if (/\/$/.test(api)) return '开启健康检查时，接口服务 (api) 不能以 / 结尾（会和健康检查路径拼接）';
  if (/[?#]/.test(api)) return '开启健康检查时，接口服务 (api) 不能带 ? 或 #（会和健康检查路径拼接）';
  return null;
}

// The one contract this codebase knows by name; still an explicit button click per lane, never applied for the
// owner — a lane pointed at a different vendor's server must not inherit OpenCode's health shape by default.
export const OPENCODE_HEALTH_PRESET = { path: '/global/health', json: '{"healthy":true}' };

export function parseHealthJson(text: string): { json: Record<string, unknown>; error: string | null } {
  const trimmed = text.trim();
  if (!trimmed) return { json: {}, error: null };
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (err) {
    return { json: {}, error: `期望字段必须是合法 JSON：${err instanceof Error ? err.message : String(err)}` };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { json: {}, error: '期望字段必须是一个 JSON 对象，比如 {"healthy":true}' };
  }
  // The service compares expected values with `!==`, so an object or array here could never match (reference
  // equality) and would silently make the lane permanently unhealthy. Primitives only.
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (value !== null && !['string', 'number', 'boolean'].includes(typeof value)) {
      return { json: {}, error: `期望字段 ${key} 只能是文字、数字、true/false 或 null` };
    }
  }
  return { json: parsed as Record<string, unknown>, error: null };
}

function setOrDelete(obj: Record<string, unknown>, key: string, val: string) {
  const trimmed = val.trim();
  if (trimmed) obj[key] = trimmed;
  else delete obj[key];
}

function setIntOrDelete(obj: Record<string, unknown>, key: string, val: string) {
  const trimmed = val.trim();
  if (!trimmed) {
    delete obj[key];
    return;
  }
  const num = Number(trimmed);
  if (Number.isInteger(num)) obj[key] = num;
}

export function toDrafts(raw: Record<string, unknown> | null | undefined): SettingsDrafts {
  const r = raw && typeof raw === 'object' ? raw : {};
  const briefs = typeof r.briefs === 'object' && r.briefs !== null ? (r.briefs as Record<string, unknown>) : undefined;
  const review = typeof r.reviewPages === 'object' && r.reviewPages !== null ? (r.reviewPages as Record<string, unknown>) : undefined;
  const policy = typeof r.policy === 'object' && r.policy !== null ? (r.policy as Record<string, unknown>) : undefined;
  const rawLanes = typeof r.lanes === 'object' && r.lanes !== null ? (r.lanes as Record<string, unknown>) : undefined;
  const rawUsage = typeof r.usage === 'object' && r.usage !== null ? (r.usage as Record<string, unknown>) : undefined;
  const verification = typeof r.verification === 'object' && r.verification !== null ? (r.verification as Record<string, unknown>) : undefined;
  const rawAlibaba =
    rawUsage && typeof rawUsage.alibaba === 'object' && rawUsage.alibaba !== null
      ? (rawUsage.alibaba as Record<string, unknown>)
      : undefined;

  const lanes: LaneDraft[] = [];
  if (rawLanes) {
    for (const [id, laneVal] of Object.entries(rawLanes)) {
      const lane = typeof laneVal === 'object' && laneVal !== null ? (laneVal as Record<string, unknown>) : {};
      const session = typeof lane.session === 'object' && lane.session !== null ? (lane.session as Record<string, unknown>) : undefined;
      const envStr = lane.env && typeof lane.env === 'object'
        ? Object.entries(lane.env as Record<string, unknown>).map(([k, v]) => `${k}=${String(v)}`).join('\n')
        : '';
      // An object with a `path` key (any defined value, even a non-string like 42 — the text field can show it
      // and validation can name the format problem) is the only shape read as "recognized" path/json fields.
      // Anything else with a `health` key present at all (a string, an array, null, `{}`, `{path:""}`, or an
      // object with only unrelated keys) is kept verbatim in `healthMalformed` instead of being read as "no
      // health" and lost on the next save.
      const rawHealth = lane.health;
      let healthPath = '';
      let healthJsonText = '';
      let healthMalformed: unknown;
      if (rawHealth !== undefined) {
        if (isPlainObject(rawHealth)) {
          const hasPath = 'path' in rawHealth;
          const pathVal = rawHealth.path;
          // Matches the service contract: health.path must actually be a string, not merely something
          // String() can render. Every non-string path — null, an array, a number, an object, a boolean, a
          // blank or whitespace-only string — takes this one branch, so no shape gets coerced into a "usable"
          // draft value by accident; there is no per-shape list to keep in sync with the backend.
          const pathUsable = typeof pathVal === 'string' && pathVal.trim() !== '';
          // A usable path, or a `json` key with no `path` key at all (a hand-edited file mid-way through
          // adding a contract, still missing its path — C2), is something the two fields can already
          // represent and let the owner finish editing. A `path` key that is present but not a usable string
          // has nowhere to land, so it goes to healthMalformed even when `json` is also present — never
          // silently dropped in favor of the json half.
          if (pathUsable || (!hasPath && 'json' in rawHealth)) {
            healthPath = pathUsable ? str(pathVal) : '';
            healthJsonText = 'json' in rawHealth ? JSON.stringify(rawHealth.json) : '';
          } else {
            healthMalformed = rawHealth;
            // The path is unusable, but a sibling `json` is still something the owner should see and a repair
            // should still carry forward — an invalid path must not hide an independent, editable `json`.
            if ('json' in rawHealth) healthJsonText = JSON.stringify(rawHealth.json);
          }
        } else {
          healthMalformed = rawHealth;
        }
      }
      const optionalArgsMalformed = 'optionalArgs' in lane && !Array.isArray(lane.optionalArgs) ? lane.optionalArgs : undefined;
      const rawOptionalArgs = Array.isArray(lane.optionalArgs) ? lane.optionalArgs : [];
      const optionalArgs = rawOptionalArgs.map(parseOptionalArg);
      lanes.push({
        id,
        formKey: createLaneFormKey(),
        originalId: id,
        run: strList(lane.run),
        outputDir: str(lane.outputDir),
        api: str(lane.api),
        protocol: str(lane.protocol),
        serve: strList(lane.serve),
        deliveryDir: str(lane.deliveryDir),
        defaultModel: str(lane.defaultModel),
        editCounter: str(lane.editCounter),
        serialize: Boolean(lane.serialize),
        spacingMs: lane.spacingMs !== undefined && lane.spacingMs !== null ? String(lane.spacingMs) : '',
        env: envStr,
        sessionRun: strList(session?.run),
        sessionSaveTo: str(session?.saveTo),
        healthPath,
        healthJson: healthJsonText,
        healthMalformed,
        optionalArgs,
        optionalArgsMalformed,
      });
    }
  }

  return {
    project: {
      name: str(r.name),
      port: r.port !== undefined && r.port !== null ? String(r.port) : '',
      dataDir: str(r.dataDir),
      events: str(r.events),
      registry: str(r.registry),
      lockFile: str(r.lockFile),
      bash: str(r.bash),
    },
    briefs: {
      dispatchDirs: strList(briefs?.dispatchDirs).join(', '),
      ownerDirs: strList(briefs?.ownerDirs).join(', '),
      packagePattern: str(briefs?.packagePattern),
      fileListHeading: str(briefs?.fileListHeading),
      recentDays: briefs?.recentDays !== undefined && briefs.recentDays !== null ? String(briefs.recentDays) : '',
    },
    lanes,
    policy: {
      bannedModelPatterns: strList(policy?.bannedModelPatterns),
      bannedAgents: strList(policy?.bannedAgents),
      stallAfterMinutes: str(policy?.stallAfterMinutes),
      laneConcurrency: isPlainObject(policy?.laneConcurrency)
        ? Object.entries(policy.laneConcurrency).map(([lane, limit]) => ({ lane, limit: str(limit) }))
        : [],
      defaultLane: str(policy?.defaultLane),
      defaultCard: str(policy?.defaultCard),
      bouncePatterns: Array.isArray(policy?.bouncePatterns)
        ? policy.bouncePatterns.map((entry) => (isPlainObject(entry) ? { code: str(entry.code), pattern: str(entry.pattern), label: str(entry.label) } : { code: '', pattern: '', label: '' }))
        : [],
    },
    review: { dir: str(review?.dir) },
    usage: {
      // Trimmed like the service does before it validates: a hand-written `" nvidia "` must show as the
      // checked NVIDIA row (and toggle off from it), not as an unchecked stray that grows a second,
      // trimmed copy beside it on the next click.
      manualProviders: strList(rawUsage?.manualProviders).map((id) => id.trim()),
      alibabaEdition: str(rawAlibaba?.edition),
      alibabaRegion: str(rawAlibaba?.region),
    },
    verification: {
      hooks: Array.isArray(verification?.hooks)
        ? verification.hooks.map((rawHook) => {
          const hook = isPlainObject(rawHook) ? rawHook : {};
          const unknownFields = Object.fromEntries(Object.entries(hook).filter(([key]) => !VERIFICATION_HOOK_KEYS.has(key)));
          return {
            id: str(hook.id),
            command: strList(hook.command),
            timeoutSeconds: hook.timeoutSeconds !== undefined && hook.timeoutSeconds !== null ? String(hook.timeoutSeconds) : '',
            cwd: str(hook.cwd),
            envKeys: strList(hook.envKeys),
            kinds: strList(hook.kinds),
            trigger: str(hook.trigger),
            enabled: hook.enabled === true,
            unknownFields,
          };
        })
        : [],
    },
  };
}

export function toRaw(raw: Record<string, unknown> | null | undefined, drafts: SettingsDrafts): Record<string, unknown> {
  const next: Record<string, unknown> = raw && typeof raw === 'object' ? { ...raw } : {};

  next.name = drafts.project.name.trim();
  setIntOrDelete(next, 'port', drafts.project.port);
  setOrDelete(next, 'dataDir', drafts.project.dataDir);
  setOrDelete(next, 'events', drafts.project.events);
  setOrDelete(next, 'registry', drafts.project.registry);
  setOrDelete(next, 'lockFile', drafts.project.lockFile);
  setOrDelete(next, 'bash', drafts.project.bash);

  const origBriefs = typeof raw?.briefs === 'object' && raw.briefs !== null ? (raw.briefs as Record<string, unknown>) : {};
  const briefsObj: Record<string, unknown> = { ...origBriefs };
  const dDirs = drafts.briefs.dispatchDirs.split(',').map((s) => s.trim()).filter(Boolean);
  if (dDirs.length > 0) briefsObj.dispatchDirs = dDirs;
  else delete briefsObj.dispatchDirs;
  const oDirs = drafts.briefs.ownerDirs.split(',').map((s) => s.trim()).filter(Boolean);
  if (oDirs.length > 0) briefsObj.ownerDirs = oDirs;
  else delete briefsObj.ownerDirs;
  setOrDelete(briefsObj, 'packagePattern', drafts.briefs.packagePattern);
  setOrDelete(briefsObj, 'fileListHeading', drafts.briefs.fileListHeading);
  setIntOrDelete(briefsObj, 'recentDays', drafts.briefs.recentDays);
  if (Object.keys(briefsObj).length > 0) next.briefs = briefsObj;
  else delete next.briefs;

  if (drafts.review.dir.trim()) {
    const origReview = typeof raw?.reviewPages === 'object' && raw.reviewPages !== null ? (raw.reviewPages as Record<string, unknown>) : {};
    next.reviewPages = { ...origReview, dir: drafts.review.dir.trim() };
  } else {
    delete next.reviewPages;
  }

  const origLanes = typeof raw?.lanes === 'object' && raw.lanes !== null ? (raw.lanes as Record<string, unknown>) : {};
  const newLanes: Record<string, unknown> = {};
  for (const lane of drafts.lanes) {
    // Looked up by originalId, not the (possibly just-edited) id: a rename must still find this lane's own
    // unknown fields instead of picking up whatever the new id used to name, or nothing at all. `null` (a
    // lane added this session) skips the lookup entirely rather than risk its generated id colliding with a
    // since-deleted lane's original key.
    const origLaneRaw = lane.originalId !== null ? origLanes[lane.originalId] : undefined;
    const origLane = isPlainObject(origLaneRaw) ? { ...origLaneRaw } : {};
    const laneObj: Record<string, unknown> = { ...origLane };
    laneObj.run = [...lane.run];
    setOrDelete(laneObj, 'outputDir', lane.outputDir);
    setOrDelete(laneObj, 'api', lane.api);
    // Omitted whenever it equals the default (today that is every legal value, since only one protocol is
    // accepted) so a config nobody touched this field on stays byte-identical after a save. Also omitted
    // with no api: the field only means anything alongside a server, and a stray value left over from a
    // just-cleared api (M1) must never reach the file even if some caller forgot apiFieldPatch.
    const protocol = (lane.protocol || '').trim();
    if (lane.api.trim() && protocol && protocol !== DEFAULT_LANE_PROTOCOL) laneObj.protocol = protocol;
    else delete laneObj.protocol;
    if (lane.serve.length > 0) laneObj.serve = [...lane.serve];
    else delete laneObj.serve;
    setOrDelete(laneObj, 'deliveryDir', lane.deliveryDir);
    setOrDelete(laneObj, 'defaultModel', lane.defaultModel);
    setOrDelete(laneObj, 'editCounter', lane.editCounter);
    if (lane.serialize) laneObj.serialize = true;
    else delete laneObj.serialize;
    setIntOrDelete(laneObj, 'spacingMs', lane.spacingMs);

    if (lane.env.trim()) {
      const parsedEnv = parseCardEnv(lane.env);
      if (Object.keys(parsedEnv.env).length > 0) laneObj.env = parsedEnv.env;
      else delete laneObj.env;
    } else delete laneObj.env;

    if (lane.sessionRun.length > 0 || lane.sessionSaveTo.trim()) {
      const origSession = typeof origLane.session === 'object' && origLane.session !== null ? { ...(origLane.session as Record<string, unknown>) } : {};
      const sessionObj: Record<string, unknown> = { ...origSession };
      sessionObj.run = [...lane.sessionRun];
      if (lane.sessionSaveTo.trim()) sessionObj.saveTo = lane.sessionSaveTo.trim();
      else delete sessionObj.saveTo;
      laneObj.session = sessionObj;
    } else delete laneObj.session;

    const healthPath = lane.healthPath.trim();
    if (healthPath) {
      // Spread the original health object first, same as the lane itself above, so unknown keys (e.g. a
      // future `timeout`) survive a save that only touches path/json. Only a plain object is spreadable this
      // way; a malformed original (array, string, ...) contributes nothing here — it was never usable as a
      // base, and repairing it (typing a working path) is what retires it.
      const origHealth = isPlainObject(origLane.health) ? { ...origLane.health } : {};
      const healthObj: Record<string, unknown> = { ...origHealth, path: healthPath };
      if (lane.healthJson.trim()) {
        const parsedHealth = parseHealthJson(lane.healthJson);
        if (Object.keys(parsedHealth.json).length > 0) healthObj.json = parsedHealth.json;
        else delete healthObj.json;
      } else delete healthObj.json;
      laneObj.health = healthObj;
    } else if (lane.healthMalformed !== undefined) {
      // Not repaired (no path typed) and not explicitly disabled (unchecking clears healthMalformed along with
      // the two fields above) — keep the hand-edited mistake exactly as read, so a save elsewhere in the form
      // never turns "health is broken" into "health is gone" behind the owner's back.
      laneObj.health = lane.healthMalformed;
    } else delete laneObj.health;

    if (lane.optionalArgsMalformed !== undefined) {
      laneObj.optionalArgs = lane.optionalArgsMalformed;
    } else if (lane.optionalArgs && lane.optionalArgs.length > 0) {
      laneObj.optionalArgs = lane.optionalArgs.map((group) => {
        if (group.parseError && Object.prototype.hasOwnProperty.call(group, 'rawOptionalArg')) return group.rawOptionalArg;
        const { when, args, omitWhen, insertAt, ...unknownFields } = group;
        const g: Record<string, unknown> = {
          ...unknownFields,
          when,
          args: [...args],
        };
        if (omitWhen && omitWhen.length > 0) {
          g.omitWhen = [...omitWhen];
        }
        if (typeof insertAt === 'number') {
          g.insertAt = insertAt;
        }
        return g;
      });
    } else {
      delete laneObj.optionalArgs;
    }

    newLanes[lane.id] = laneObj;
  }
  next.lanes = newLanes;

  const origPolicy = typeof raw?.policy === 'object' && raw.policy !== null ? (raw.policy as Record<string, unknown>) : {};
  const nextPolicy: Record<string, unknown> = { ...origPolicy, bannedModelPatterns: [...drafts.policy.bannedModelPatterns], bannedAgents: [...drafts.policy.bannedAgents] };
  setIntOrDelete(nextPolicy, 'stallAfterMinutes', drafts.policy.stallAfterMinutes);
  const laneConcurrencyRaw: Record<string, number> = {};
  for (const row of drafts.policy.laneConcurrency) {
    const lane = row.lane.trim();
    const limit = Number(row.limit.trim());
    if (lane && Number.isInteger(limit)) laneConcurrencyRaw[lane] = limit;
  }
  if (Object.keys(laneConcurrencyRaw).length > 0) nextPolicy.laneConcurrency = laneConcurrencyRaw;
  else delete nextPolicy.laneConcurrency;
  setOrDelete(nextPolicy, 'defaultLane', drafts.policy.defaultLane);
  setOrDelete(nextPolicy, 'defaultCard', drafts.policy.defaultCard);
  const bouncePatternsRaw = drafts.policy.bouncePatterns
    .map((row) => ({ code: row.code.trim(), pattern: row.pattern.trim(), label: row.label.trim() }))
    .filter((row) => row.code || row.pattern || row.label);
  if (bouncePatternsRaw.length > 0) nextPolicy.bouncePatterns = bouncePatternsRaw;
  else delete nextPolicy.bouncePatterns;
  next.policy = nextPolicy;

  // Verification hooks are configured by the project owner, never by a quest payload. The form only changes
  // `enabled`; every command, path, kind, trigger and unknown future key is round-tripped from the raw file.
  const origVerification = isPlainObject(raw?.verification) ? { ...raw.verification } : {};
  const origHooks = Array.isArray(origVerification.hooks) ? origVerification.hooks : [];
  const verificationHooks = drafts.verification.hooks.map((draft, index) => {
    const original = isPlainObject(origHooks[index]) ? { ...origHooks[index] } : {};
    const hookObj: Record<string, unknown> = { ...original, ...draft.unknownFields };
    hookObj.id = draft.id;
    hookObj.command = [...draft.command];
    const timeout = Number(draft.timeoutSeconds);
    if (Number.isInteger(timeout)) hookObj.timeoutSeconds = timeout;
    hookObj.cwd = draft.cwd;
    hookObj.envKeys = [...draft.envKeys];
    hookObj.kinds = [...draft.kinds];
    hookObj.trigger = draft.trigger;
    if (draft.enabled || Object.prototype.hasOwnProperty.call(original, 'enabled')) hookObj.enabled = draft.enabled;
    else delete hookObj.enabled;
    return hookObj;
  });
  if (Object.keys(origVerification).length > 0 || verificationHooks.length > 0) {
    next.verification = { ...origVerification, ...(verificationHooks.length > 0 || Array.isArray(origVerification.hooks) ? { hooks: verificationHooks } : {}) };
  } else {
    delete next.verification;
  }

  // usage: spread the original section first, like every other section, so keys this form does not know
  // about survive a save. The Alibaba pair is written together or not at all (validateDrafts refuses a
  // half-set pair). An empty manualProviders list is written on purpose when the project already has usage
  // settings: "all cards disabled" is a real choice, not the same as the key never having existed — but a
  // project that never had usage.* keeps not having it.
  const origUsage = typeof raw?.usage === 'object' && raw.usage !== null ? (raw.usage as Record<string, unknown>) : {};
  const usageObj: Record<string, unknown> = { ...origUsage };
  const edition = drafts.usage.alibabaEdition.trim();
  const region = drafts.usage.alibabaRegion.trim();
  if (edition && region) {
    const origAlibaba =
      typeof origUsage.alibaba === 'object' && origUsage.alibaba !== null
        ? (origUsage.alibaba as Record<string, unknown>)
        : {};
    usageObj.alibaba = { ...origAlibaba, edition, region };
  } else {
    delete usageObj.alibaba;
  }
  const hadUsage = Object.keys(origUsage).length > 0;
  const hasChoice = drafts.usage.manualProviders.length > 0 || (edition !== '' && region !== '');
  if (hadUsage || hasChoice) {
    usageObj.manualProviders = [...drafts.usage.manualProviders];
    next.usage = usageObj;
  } else {
    delete next.usage;
  }
  return next;
}

export function validateDrafts(drafts: SettingsDrafts): Record<string, string> {
  const errors: Record<string, string> = {};

  const name = drafts.project.name.trim();
  if (!name) { errors['project.name'] = '项目名称不能为空'; errors.name = '项目名称不能为空'; }

  const portStr = drafts.project.port.trim();
  const portNum = Number(portStr);
  if (!portStr || !Number.isInteger(portNum) || portNum < 1 || portNum > 65535) {
    errors['project.port'] = '服务端口必须是 1 到 65535 之间的整数'; errors.port = '服务端口必须是 1 到 65535 之间的整数';
  }

  const recentDaysStr = drafts.briefs.recentDays.trim();
  const recentDaysNum = Number(recentDaysStr);
  if (!recentDaysStr || !Number.isInteger(recentDaysNum) || recentDaysNum <= 0) {
    errors['briefs.recentDays'] = '简报天数必须是正整数'; errors.recentDays = '简报天数必须是正整数';
  }

  // The Alibaba pair is one choice in two halves: the service rejects a lone edition or a lone region, so
  // the form refuses it here and says which fields are involved, before a save can round-trip a refusal.
  const usageEdition = drafts.usage.alibabaEdition.trim();
  const usageRegion = drafts.usage.alibabaRegion.trim();
  if ((usageEdition === '') !== (usageRegion === '')) {
    const msg = '阿里云版本和区域要么都选，要么都不选';
    errors['usage.alibaba'] = msg; errors.usage = msg;
  }

  if (!drafts.lanes || drafts.lanes.length === 0) {
    errors.lanes = '至少需要配置一种接入方式';
    return errors;
  }

  const seenIds = new Set<string>();
  // entries() carries the index without an array lookup, which under noUncheckedIndexedAccess would be
  // `LaneDraft | undefined` at every use below.
  for (const [i, lane] of drafts.lanes.entries()) {
    const laneId = lane.id.trim();

    if (!laneId) {
      errors[`lanes.${i}.id`] = '接入方式 ID 不能为空';
    } else if (!LANE_ID_PATTERN.test(laneId)) {
      const msg = '接入方式 ID 必须以小写字母开头，只能包含小写字母、数字和连字符，最多 32 个字符';
      errors[`lanes.${i}.id`] = msg; errors[`lanes.${laneId}.id`] = msg; errors[`lanes.${laneId}`] = msg;
    } else if (seenIds.has(laneId)) {
      const msg = `接入方式 ID「${laneId}」重复`;
      errors[`lanes.${i}.id`] = msg; errors[`lanes.${laneId}.id`] = msg;
    } else {
      seenIds.add(laneId);
    }

    if (!lane.run || lane.run.length === 0) {
      errors[`lanes.${i}.run`] = '执行命令不能为空'; if (laneId) errors[`lanes.${laneId}.run`] = '执行命令不能为空';
    } else if (lane.run.some((arg) => typeof arg !== 'string' || !arg.trim())) {
      errors[`lanes.${i}.run`] = '执行命令参数不能为空白'; if (laneId) errors[`lanes.${laneId}.run`] = '执行命令参数不能为空白';
    }

    const addOptionalArgError = (groupIndex: number, field: string, message: string) => {
      const indexBase = `lanes.${i}.optionalArgs[${groupIndex}]`;
      errors[`${indexBase}.${field}`] = message;
      if (laneId) errors[`lanes.${laneId}.optionalArgs[${groupIndex}].${field}`] = message;
    };
    if (lane.optionalArgsMalformed !== undefined) {
      const message = '可选参数组无法解析，已原样保留；请删除或修复后再保存';
      errors[`lanes.${i}.optionalArgs`] = message;
      if (laneId) errors[`lanes.${laneId}.optionalArgs`] = message;
    }
    for (const [groupIndex, group] of (lane.optionalArgs || []).entries()) {
      if (group.parseError) {
        addOptionalArgError(groupIndex, 'parse', group.parseError);
        continue;
      }
      if (!OPTIONAL_ARG_WHEN.has(group.when)) addOptionalArgError(groupIndex, 'when', 'when 只能是 variant 或 agent');
      if (!Array.isArray(group.args) || group.args.length === 0) {
        addOptionalArgError(groupIndex, 'args', 'args 不能为空');
      } else {
        if (group.args.some((arg) => typeof arg !== 'string' || !arg.trim())) {
          addOptionalArgError(groupIndex, 'args', '参数不能为空或仅为空白字符');
        }
        if (!group.args.some((arg) => typeof arg === 'string' && arg.includes(`{${group.when}}`))) {
          addOptionalArgError(groupIndex, 'args', `args 中需要包含 {${group.when}} 占位符`);
        }
      }
      if (group.omitWhen?.some((value) => typeof value !== 'string' || !value.trim())) {
        addOptionalArgError(groupIndex, 'omitWhen', '省略值不能为空或仅为空白字符');
      }
      if (group.omitWhen && new Set(group.omitWhen).size !== group.omitWhen.length) {
        addOptionalArgError(groupIndex, 'omitWhen', '省略值不能重复');
      }
      if (group.insertAt !== undefined) {
        const minInsertAt = lane.run[0] === 'node' ? 2 : 1;
        if (!Number.isInteger(group.insertAt) || group.insertAt < minInsertAt || group.insertAt > lane.run.length) {
          addOptionalArgError(groupIndex, 'insertAt', `插入位置必须在 ${minInsertAt} 到 ${lane.run.length} 之间`);
        }
      }
    }

    if (lane.serve.length > 0) {
      const serveErr = !lane.api.trim()
        ? '只有填了接口服务 (api) 的接入方式才需要启动命令'
        : lane.serve.some((arg) => !arg.trim())
          ? '启动命令参数不能为空白'
          : lane.serve.some((arg) => /\{[a-z]+\}/.test(arg))
            ? '启动命令对整个接入方式只跑一次，不能用占位符'
            : '';
      if (serveErr) {
        errors[`lanes.${i}.serve`] = serveErr; if (laneId) errors[`lanes.${laneId}.serve`] = serveErr;
      }
    }

    const spacingStr = lane.spacingMs.trim();
    if (spacingStr) {
      const spacingNum = Number(spacingStr);
      if (!Number.isInteger(spacingNum) || spacingNum < 0) {
        errors[`lanes.${i}.spacingMs`] = '间隔时间必须是非负整数'; if (laneId) errors[`lanes.${laneId}.spacingMs`] = '间隔时间必须是非负整数';
      }
    }

    const editCounterStr = lane.editCounter.trim();
    if (editCounterStr && !['patch', 'stream-json'].includes(editCounterStr)) {
      errors[`lanes.${i}.editCounter`] = '编辑计数器只能是 patch 或 stream-json'; if (laneId) errors[`lanes.${laneId}.editCounter`] = '编辑计数器只能是 patch 或 stream-json';
    }

    if (lane.env.trim()) {
      const parsed = parseCardEnv(lane.env);
      if (parsed.error) {
        errors[`lanes.${i}.env`] = parsed.error; if (laneId) errors[`lanes.${laneId}.env`] = parsed.error;
      }
    }

    // No "needs api" refusal here (M1): the select that sets protocol is hidden once api is cleared, so a
    // page-driven edit can never produce this combination, and refusing it anyway would block Save on an
    // error the owner cannot see or clear. apiFieldPatch clears protocol the moment api is cleared, and
    // toRaw drops a stray protocol with no api regardless, so this stays a pure format check.
    const protocolStr = (lane.protocol || '').trim();
    if (protocolStr && !(LANE_PROTOCOLS as readonly string[]).includes(protocolStr)) {
      const msg = `协议只能是：${LANE_PROTOCOLS.join('、')}`;
      errors[`lanes.${i}.protocol`] = msg; if (laneId) errors[`lanes.${laneId}.protocol`] = msg;
    }

    const healthPathStr = lane.healthPath.trim();
    const apiStr = lane.api.trim();
    if (healthPathStr) {
      let healthPathErr = '';
      if (!apiStr) {
        healthPathErr = '健康检查需要先填接口服务 (api)；不需要健康检查就把它关掉';
      } else if (!isLocalHealthPath(healthPathStr)) {
        healthPathErr = '健康检查路径必须是以 / 开头的相对路径，不能是 //、带反斜杠或空白（比如 /global/health）';
      }
      if (healthPathErr) {
        errors[`lanes.${i}.healthPath`] = healthPathErr; if (laneId) errors[`lanes.${laneId}.healthPath`] = healthPathErr;
      }

      if (apiStr) {
        const apiErr = healthApiError(apiStr);
        if (apiErr) {
          errors[`lanes.${i}.api`] = apiErr; if (laneId) errors[`lanes.${laneId}.api`] = apiErr;
        }
      }
    } else if (lane.healthMalformed !== undefined) {
      // Checked before the json-without-path message below: a malformed shape read from the file can itself
      // carry a `json` sibling (prefilled into `healthJson` on load, see toDrafts), and that json is not
      // something the owner typed without a path — it is part of the same mistake the banner already names.
      const msg = `健康检查写法不对：${describeMalformedHealth(lane.healthMalformed)}。填一个有效路径可以修复，或者取消勾选来关闭健康检查`;
      errors[`lanes.${i}.healthPath`] = msg; if (laneId) errors[`lanes.${laneId}.healthPath`] = msg;
    } else if (lane.healthJson.trim()) {
      const msg = '填了期望字段就要先填健康检查路径';
      errors[`lanes.${i}.healthJson`] = msg; if (laneId) errors[`lanes.${laneId}.healthJson`] = msg;
    }

    if (healthPathStr && lane.healthJson.trim()) {
      const parsedHealth = parseHealthJson(lane.healthJson);
      if (parsedHealth.error) {
        errors[`lanes.${i}.healthJson`] = parsedHealth.error; if (laneId) errors[`lanes.${laneId}.healthJson`] = parsedHealth.error;
      }
    }
  }

  const laneIdSet = new Set(drafts.lanes.map((lane) => lane.id.trim()).filter(Boolean));
  const stallStr = drafts.policy.stallAfterMinutes.trim();
  if (stallStr) {
    const stallNum = Number(stallStr);
    if (!Number.isInteger(stallNum) || stallNum < 1) errors['policy.stallAfterMinutes'] = '停摆阈值必须是正整数（分钟）';
  }

  const seenPolicyLanes = new Set<string>();
  for (const [i, row] of drafts.policy.laneConcurrency.entries()) {
    const lane = row.lane.trim();
    if (!lane) {
      errors[`policy.laneConcurrency.${i}.lane`] = '通道不能为空';
    } else if (!laneIdSet.has(lane)) {
      errors[`policy.laneConcurrency.${i}.lane`] = `通道「${lane}」不在接入方式里`;
    } else if (seenPolicyLanes.has(lane)) {
      errors[`policy.laneConcurrency.${i}.lane`] = `通道「${lane}」重复`;
    } else {
      seenPolicyLanes.add(lane);
    }
    const limitStr = row.limit.trim();
    if (!limitStr || !Number.isInteger(Number(limitStr)) || Number(limitStr) < 1) errors[`policy.laneConcurrency.${i}.limit`] = '并发上限必须是正整数';
  }

  const defaultLaneDraft = drafts.policy.defaultLane.trim();
  if (defaultLaneDraft && !laneIdSet.has(defaultLaneDraft)) errors['policy.defaultLane'] = `默认通道「${defaultLaneDraft}」不在接入方式里`;

  const defaultCardDraft = drafts.policy.defaultCard.trim();
  if (defaultCardDraft && !CARD_ID_PATTERN.test(defaultCardDraft)) errors['policy.defaultCard'] = '默认卡 ID 只能用小写字母、数字和连字符，1-48 个字符';

  for (const [i, row] of drafts.policy.bouncePatterns.entries()) {
    const code = row.code.trim();
    if (!BOUNCE_CODE_PATTERN.test(code)) errors[`policy.bouncePatterns.${i}.code`] = 'code 只能用小写字母、数字、下划线，且以字母开头';
    const pattern = row.pattern.trim();
    if (!pattern) {
      errors[`policy.bouncePatterns.${i}.pattern`] = '正则不能为空';
    } else {
      try {
        new RegExp(pattern);
      } catch (error) {
        errors[`policy.bouncePatterns.${i}.pattern`] = `正则不合法：${error instanceof Error ? error.message : String(error)}`;
      }
    }
    if (!row.label.trim()) errors[`policy.bouncePatterns.${i}.label`] = '标签不能为空';
  }

  return errors;
}
