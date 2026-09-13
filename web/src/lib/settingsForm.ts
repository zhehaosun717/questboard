import { parseCardEnv } from './rosterForm';

export interface LaneDraft {
  id: string;
  run: string[];
  outputDir: string;
  api: string;
  deliveryDir: string;
  defaultModel: string;
  editCounter: string;
  serialize: boolean;
  spacingMs: string;
  env: string;
  sessionRun: string[];
  sessionSaveTo: string;
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

export interface PolicyDraft {
  bannedModelPatterns: string[];
  bannedAgents: string[];
}

export interface SettingsDrafts {
  project: ProjectDraft;
  briefs: BriefsDraft;
  lanes: LaneDraft[];
  policy: PolicyDraft;
  review: ReviewDraft;
}

const LANE_ID_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;
const str = (v: unknown): string => (typeof v === 'string' ? v : v !== undefined && v !== null ? String(v) : '');
const strList = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : []);

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

  const lanes: LaneDraft[] = [];
  if (rawLanes) {
    for (const [id, laneVal] of Object.entries(rawLanes)) {
      const lane = typeof laneVal === 'object' && laneVal !== null ? (laneVal as Record<string, unknown>) : {};
      const session = typeof lane.session === 'object' && lane.session !== null ? (lane.session as Record<string, unknown>) : undefined;
      const envStr = lane.env && typeof lane.env === 'object'
        ? Object.entries(lane.env as Record<string, unknown>).map(([k, v]) => `${k}=${String(v)}`).join('\n')
        : '';
      lanes.push({
        id,
        run: strList(lane.run),
        outputDir: str(lane.outputDir),
        api: str(lane.api),
        deliveryDir: str(lane.deliveryDir),
        defaultModel: str(lane.defaultModel),
        editCounter: str(lane.editCounter),
        serialize: Boolean(lane.serialize),
        spacingMs: lane.spacingMs !== undefined && lane.spacingMs !== null ? String(lane.spacingMs) : '',
        env: envStr,
        sessionRun: strList(session?.run),
        sessionSaveTo: str(session?.saveTo),
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
    },
    review: { dir: str(review?.dir) },
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
    const origLane = typeof origLanes[lane.id] === 'object' && origLanes[lane.id] !== null ? { ...(origLanes[lane.id] as Record<string, unknown>) } : {};
    const laneObj: Record<string, unknown> = { ...origLane };
    laneObj.run = [...lane.run];
    setOrDelete(laneObj, 'outputDir', lane.outputDir);
    setOrDelete(laneObj, 'api', lane.api);
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

    newLanes[lane.id] = laneObj;
  }
  next.lanes = newLanes;

  const origPolicy = typeof raw?.policy === 'object' && raw.policy !== null ? (raw.policy as Record<string, unknown>) : {};
  next.policy = { ...origPolicy, bannedModelPatterns: [...drafts.policy.bannedModelPatterns], bannedAgents: [...drafts.policy.bannedAgents] };
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

  if (!drafts.lanes || drafts.lanes.length === 0) {
    errors.lanes = '至少需要配置一条通道';
    return errors;
  }

  const seenIds = new Set<string>();
  // entries() carries the index without an array lookup, which under noUncheckedIndexedAccess would be
  // `LaneDraft | undefined` at every use below.
  for (const [i, lane] of drafts.lanes.entries()) {
    const laneId = lane.id.trim();

    if (!laneId) {
      errors[`lanes.${i}.id`] = '通道 ID 不能为空';
    } else if (!LANE_ID_PATTERN.test(laneId)) {
      const msg = '通道 ID 必须以小写字母开头，只能包含小写字母、数字和连字符，最多 32 个字符';
      errors[`lanes.${i}.id`] = msg; errors[`lanes.${laneId}.id`] = msg; errors[`lanes.${laneId}`] = msg;
    } else if (seenIds.has(laneId)) {
      const msg = `通道 ID「${laneId}」重复`;
      errors[`lanes.${i}.id`] = msg; errors[`lanes.${laneId}.id`] = msg;
    } else {
      seenIds.add(laneId);
    }

    if (!lane.run || lane.run.length === 0) {
      errors[`lanes.${i}.run`] = '执行命令不能为空'; if (laneId) errors[`lanes.${laneId}.run`] = '执行命令不能为空';
    } else if (lane.run.some((arg) => typeof arg !== 'string' || !arg.trim())) {
      errors[`lanes.${i}.run`] = '执行命令参数不能为空白'; if (laneId) errors[`lanes.${laneId}.run`] = '执行命令参数不能为空白';
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
  }

  return errors;
}
