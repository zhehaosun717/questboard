// GET /api/settings — a read-only summary of where this board reads and writes: the project config, the
// machine roster and status log, where usage keys would come from (present or not, never the key), and the
// OMO file. Paths are local facts, so only local host names get an answer.
import fs from 'node:fs';
import { LOCAL_HOSTS, readJsonBody, sendJson, writeRefusal } from './http.js';
import { readRawConfig, resolveConfig, saveProjectConfig } from '../core/config.js';
import { bashPath, planDispatch, preflight } from '../core/dispatch.js';
import { laneServers, startLaneServer } from '../core/laneServer.js';
import { createCredentials, openCodeAuthFile } from '../usage/credentials.js';
import { PROVIDERS } from '../usage/providers.js';
import { omoConfigFile } from '../integrations/omo.js';

export function describeProject(config) {
  const raw = readRawConfig(config.root);
  const rawLanes = raw && raw.lanes && typeof raw.lanes === 'object' && !Array.isArray(raw.lanes) ? raw.lanes : {};
  return {
    name: config.name,
    root: config.root,
    port: config.port,
    paths: config.paths,
    briefs: { dispatchDirs: config.briefs.dispatchDirs, ownerDirs: config.briefs.ownerDirs, recentDays: config.briefs.recentDays },
    reviewPagesDir: config.reviewPages ? config.reviewPages.dir : null,
    lanes: Object.entries(config.lanes).map(([id, lane]) => ({
      id,
      run: lane.run,
      outputDir: lane.outputDir || null,
      api: lane.api || null,
      serve: lane.serve || null,
      serialize: lane.serialize,
      defaultModel: lane.defaultModel || null,
      optionalArgs: Array.isArray(rawLanes[id]?.optionalArgs) ? rawLanes[id].optionalArgs : (lane.optionalArgs || []),
    })),
    verification: config.verification ? {
      progressDirs: config.verification.progressDirs,
      hooks: config.verification.hooks.map(({ cwdPath, ...hook }) => hook),
    } : null,
    policy: config.policy,
    usage: config.usage,
  };
}

function validatePreviewLane(root, lane) {
  if (!lane || typeof lane !== 'object' || Array.isArray(lane)) {
    return { error: 'lane must be an object', fields: { lane: 'must be an object' } };
  }
  if (typeof lane.id !== 'string' || !lane.id.trim()) {
    return { error: 'lane.id must be a non-empty string', fields: { 'lane.id': 'must be a non-empty string' } };
  }
  const laneId = lane.id;
  try {
    const raw = {
      name: 'preview',
      lanes: { [laneId]: lane },
    };
    const resolved = resolveConfig(root, raw);
    return { lane: resolved.lanes[laneId] };
  } catch (err) {
    const rawMsg = err.message || String(err);
    const prefix = 'questboard config: ';
    const cleanMsg = rawMsg.startsWith(prefix) ? rawMsg.slice(prefix.length) : rawMsg;
    const match = cleanMsg.match(/^(lanes\.[^: ]+)(?::\s*|\s+)(.*)$/);
    let field = 'lane';
    let message = cleanMsg;
    if (match) {
      field = match[1];
      message = match[2];
    }
    const fields = { [field]: message };
    if (field.startsWith(`lanes.${laneId}.`)) {
      const sub = field.slice(`lanes.${laneId}.`.length);
      fields[sub] = message;
    }
    return { error: cleanMsg, fields };
  }
}

function previewArgv(config, command) {
  const [head, ...rest] = command;
  if (head === 'node') return [process.execPath, ...rest];
  if (head.endsWith('.sh')) return [bashPath(config), ...command];
  return [...command];
}

function optionalArgWhitespaceError(lane) {
  if (!Array.isArray(lane.optionalArgs)) return null;
  for (const [index, group] of lane.optionalArgs.entries()) {
    if (!group || typeof group !== 'object' || Array.isArray(group)) continue;
    if (Array.isArray(group.args) && group.args.some((arg) => typeof arg === 'string' && !arg.trim())) {
      const field = `lanes.${lane.id}.optionalArgs[${index}].args`;
      return { error: `${field} must not contain empty or whitespace-only arguments`, fields: { [field]: 'must not contain empty or whitespace-only arguments', [`optionalArgs[${index}].args`]: 'must not contain empty or whitespace-only arguments' } };
    }
    if (Array.isArray(group.omitWhen) && group.omitWhen.some((value) => typeof value === 'string' && !value.trim())) {
      const field = `lanes.${lane.id}.optionalArgs[${index}].omitWhen`;
      return { error: `${field} must not contain empty or whitespace-only values`, fields: { [field]: 'must not contain empty or whitespace-only values', [`optionalArgs[${index}].omitWhen`]: 'must not contain empty or whitespace-only values' } };
    }
  }
  return null;
}

function cleanPlanError(err) {
  const rawMsg = err.message || String(err);
  const prefix = 'questboard config: ';
  return rawMsg.startsWith(prefix) ? rawMsg.slice(prefix.length) : rawMsg;
}

export function previewLaneCommand(config, payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return { ok: false, error: 'request body must be an object', fields: { lane: 'request body must be an object' } };
  }
  const { lane, card = {}, sample = {} } = payload;
  const validation = validatePreviewLane(config.root, lane);
  if (validation.error) {
    return { ok: false, error: validation.error, fields: validation.fields };
  }
  const validatedLane = validation.lane;
  const whitespaceError = optionalArgWhitespaceError(lane);
  if (whitespaceError) return { ok: false, ...whitespaceError };

  const cardInput = card && typeof card === 'object' && !Array.isArray(card) ? card : {};
  const sampleInput = sample && typeof sample === 'object' && !Array.isArray(sample) ? sample : {};
  const values = {
    name: sampleInput.name,
    brief: sampleInput.brief,
    package: sampleInput.package,
    model: cardInput.model,
    variant: cardInput.variant,
    agent: cardInput.agent,
  };

  const omitted = [];
  for (const group of (validatedLane.optionalArgs || [])) {
    const value = values[group.when];
    const absent = value === undefined || value === null || value === '';
    if (absent) {
      omitted.push({ when: group.when, reason: 'absent' });
    } else if (group.omitWhen && group.omitWhen.includes(value)) {
      omitted.push({ when: group.when, reason: `omitWhen: ${value}` });
    }
  }

  const warnings = [];
  const hasPositionalVariant = Array.isArray(validatedLane.run) && validatedLane.run.some((arg) => typeof arg === 'string' && arg.includes('{variant}'));
  if (hasPositionalVariant) {
    warnings.push('该接入方式的执行命令中直接包含 {variant}，无论卡片是否填写变体都会传入，无法按需省略。如需可选变体，请将执行命令中的 {variant} 移除，并在下方「可选参数」中配置。');
  }

  let plan;
  const previewConfig = { ...config, lanes: { ...config.lanes, [validatedLane.id]: validatedLane } };
  try {
    plan = planDispatch(
      previewConfig,
      { id: values.package, brief: values.brief },
      { id: 'preview-card', lane: validatedLane.id, model: values.model, variant: values.variant, agent: values.agent },
      values.name,
    );
    // This calls dispatch.js's real resolveCommand for every planned step and applies its script-existence
    // check. The small formatter below only turns the already-resolved plan command into display argv.
    preflight(previewConfig, plan);
  } catch (err) {
    const cleanMsg = cleanPlanError(err);
    return { ok: false, error: cleanMsg, fields: { run: cleanMsg } };
  }

  const runStep = plan[plan.length - 1];
  const argv = previewArgv(previewConfig, runStep.command);
  return { ok: true, argv, omitted, warnings };
}

export function createSettingsRoutes({ config, home, env = process.env, homedir, omoFile = omoConfigFile(), fetchImpl = fetch, spawnImpl }) {
  const credentials = createCredentials({ env, ...(homedir ? { homedir } : {}) });

  // GET /api/settings/lanes — which server lanes answer now. POST /api/settings/lanes/<id>/start — start one from
  // its configured serve command. POST /api/settings/lanes/preview — simulate argv with optionalArgs.
  async function handleLaneServers(request, response, parts) {
    if (parts.length === 3 && request.method === 'GET') {
      sendJson(response, 200, { lanes: await laneServers(config, { fetchImpl }) });
      return;
    }
    if (parts.length === 4 && parts[3] === 'preview' && request.method === 'POST') {
      const refusal = writeRefusal(request);
      if (refusal) { sendJson(response, 403, { error: refusal }); return; }
      let body;
      try {
        body = await readJsonBody(request, 256 * 1024);
      } catch (err) {
        sendJson(response, 400, { error: err.message, fields: { lane: err.message } });
        return;
      }
      const result = previewLaneCommand(config, body);
      if (!result.ok) {
        sendJson(response, 400, { error: result.error, fields: result.fields });
        return;
      }
      sendJson(response, 200, { argv: result.argv, omitted: result.omitted, warnings: result.warnings });
      return;
    }
    if (parts.length === 5 && parts[4] === 'start' && request.method === 'POST') {
      const refusal = writeRefusal(request);
      if (refusal) { sendJson(response, 403, { error: refusal }); return; }
      const result = await startLaneServer({ config, laneId: parts[3], fetchImpl, ...(spawnImpl ? { spawnImpl } : {}) });
      sendJson(response, result.status, result.body);
      return;
    }
    sendJson(response, 404, { error: 'not found' });
  }

  async function handle(request, response, url) {
    const parts = url.pathname.split('/').filter(Boolean);
    const isLanes = parts[0] === 'api' && parts[1] === 'settings' && parts[2] === 'lanes';
    if (url.pathname !== '/api/settings' && !isLanes) return false;
    const hostname = String(request.headers.host || '').split(':')[0];
    if (!LOCAL_HOSTS.has(hostname)) { sendJson(response, 403, { error: `host ${hostname || '(none)'} is not local` }); return true; }
    if (isLanes) { await handleLaneServers(request, response, parts); return true; }
    if (request.method === 'POST') {
      const refusal = writeRefusal(request);
      if (refusal) { sendJson(response, 403, { error: refusal }); return true; }
      const body = await readJsonBody(request, 256 * 1024);
      if (!body.raw || typeof body.raw !== 'object' || Array.isArray(body.raw)) { sendJson(response, 400, { error: 'raw must be the whole questboard.config.json object' }); return true; }
      try {
        const next = saveProjectConfig(config.root, body.raw);
        // The running server captured its config at startup, so nothing here takes effect until it restarts.
        sendJson(response, 200, { ok: true, restartRequired: true, project: describeProject(next), raw: body.raw });
      } catch (error) {
        sendJson(response, 400, { error: error.message });
      }
      return true;
    }
    if (request.method !== 'GET') { sendJson(response, 405, { error: 'GET or POST' }); return true; }
    sendJson(response, 200, {
      project: describeProject(config),
      raw: readRawConfig(config.root),
      home: { dir: home.home, roster: home.roster, rosterExists: fs.existsSync(home.roster), status: home.status },
      usageKeys: PROVIDERS.filter((p) => p.keys || p.oauth).map((p) => ({
        id: p.id,
        name: p.name,
        sources: credentials.presence({ ...(p.keys || {}), oauthIds: p.oauth ? p.oauth.openCodeIds : [] }),
      })),
      openCodeAuthFile: { file: openCodeAuthFile({ env, ...(homedir ? { homedir } : {}) }), exists: fs.existsSync(openCodeAuthFile({ env, ...(homedir ? { homedir } : {}) })) },
      omo: { file: omoFile, exists: fs.existsSync(omoFile) },
    });
    return true;
  }

  return { handle };
}
