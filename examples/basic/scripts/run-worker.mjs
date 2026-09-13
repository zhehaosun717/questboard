#!/usr/bin/env node
// Generic worker wrapper for questboard lanes.
// Logs dispatch to the project registry, streams worker output to <outputDir>/<name>.out,
// captures the exit code in <outputDir>/<name>.exit, and optionally copies a report file to <name>.md.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

// 1. Separate wrapper flags from the agent command after '--'
const args = process.argv.slice(2);
const dashDash = args.indexOf('--');
if (dashDash === -1) fail('missing -- separator before agent command');

const wrapperArgs = args.slice(0, dashDash);
const agentCmd = args.slice(dashDash + 1);
if (agentCmd.length === 0) fail('no agent command specified after --');

// 2. Parse flags before '--' (flags may come in any order; unknown flags are an error)
let lane, name, brief, model = '', variant = '', pkg = '', report = null;
for (let i = 0; i < wrapperArgs.length; i++) {
  const flag = wrapperArgs[i];
  const next = () => (++i < wrapperArgs.length ? wrapperArgs[i] : fail(`missing value for ${flag}`));
  if (flag === '--lane') lane = next();
  else if (flag === '--name') name = next();
  else if (flag === '--brief') brief = next();
  else if (flag === '--model') model = next();
  else if (flag === '--variant') variant = next();
  else if (flag === '--package') pkg = next();
  else if (flag === '--report') report = next();
  else fail(`unknown option: ${flag}`);
}

if (!lane || !name || !brief) fail('missing required arguments (--lane, --name, --brief)');

// 3. Verify the brief file exists and read its content
const briefPath = path.resolve(process.cwd(), brief);
if (!fs.existsSync(briefPath)) fail(`brief file not found: ${brief}`);
let briefText;
try {
  briefText = fs.readFileSync(briefPath, 'utf8');
} catch (err) {
  fail(`cannot read brief file: ${err.message}`);
}

// 4. Read questboard.config.json from cwd to resolve outputDir and registry path
const configPath = path.resolve(process.cwd(), 'questboard.config.json');
if (!fs.existsSync(configPath)) fail(`missing config: ${configPath}`);
let rawConfig;
try {
  rawConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
} catch (err) {
  fail(`cannot parse questboard.config.json: ${err.message}`);
}

const laneConfig = rawConfig.lanes && rawConfig.lanes[lane];
if (!laneConfig) fail(`unknown lane: ${lane}`);
const outputDirRel = laneConfig.outputDir || laneConfig.deliveryDir;
if (!outputDirRel) fail(`lane ${lane} has no outputDir`);

const dataDir = rawConfig.dataDir === undefined ? '.questboard-data' : rawConfig.dataDir;
const registryRel = rawConfig.registry === undefined ? path.join(dataDir, 'registry.jsonl') : rawConfig.registry;
const registryPath = path.resolve(process.cwd(), registryRel);
const outputDir = path.resolve(process.cwd(), outputDirRel);

// 5. Append one registry row before starting the worker (evidence workerEvidence looks for)
const dispatchRow = {
  at: new Date().toISOString(),
  event: 'dispatch',
  package: pkg,
  lane,
  model,
  variant,
  name,
  brief,
};
try {
  fs.mkdirSync(path.dirname(registryPath), { recursive: true });
  fs.appendFileSync(registryPath, JSON.stringify(dispatchRow) + '\n', 'utf8');
} catch (err) {
  fail(`cannot write registry: ${err.message}`);
}

// 6. Create <outputDir>/, write <name>.out empty at once, open for write
const outPath = path.join(outputDir, `${name}.out`);
const exitPath = path.join(outputDir, `${name}.exit`);
fs.mkdirSync(outputDir, { recursive: true });
fs.writeFileSync(outPath, '');
const outFd = fs.openSync(outPath, 'w');

// 7. Spawn agent command with brief piped to stdin; stdout+stderr appended to .out.
// On Windows, CLIs installed by npm are .cmd shims that only cmd.exe can start. A bare command name is
// looked up on PATH; a .cmd/.bat hit goes through cmd.exe with each argument quoted, anything else (node.exe,
// codex.exe) is started directly so its arguments arrive untouched. The brief travels over stdin.
function resolveOnPath(command) {
  if (process.platform !== 'win32' || /[\\/]/.test(command) || path.extname(command)) return command;
  const dirs = (process.env.PATH || '').split(';').filter(Boolean);
  const exts = ['.exe', '.cmd', '.bat', '.com'];
  for (const dir of dirs) for (const ext of exts) {
    const candidate = path.join(dir, command + ext);
    if (fs.existsSync(candidate)) return candidate;
  }
  return command;
}
const quoteForCmd = (arg) => (/[\s"]/.test(arg) ? `"${arg.replace(/"/g, '\\"')}"` : arg);
const [cmd, ...cmdArgs] = agentCmd;
const resolved = resolveOnPath(cmd);
const viaShell = /\.(cmd|bat)$/i.test(resolved);
const file = viaShell ? process.env.ComSpec || 'cmd.exe' : resolved;
const fileArgs = viaShell ? ['/d', '/s', '/c', `"${[quoteForCmd(resolved), ...cmdArgs.map(quoteForCmd)].join(' ')}"`] : cmdArgs;
let child;
try {
  child = spawn(file, fileArgs, {
    cwd: process.cwd(),
    stdio: ['pipe', outFd, outFd],
    windowsVerbatimArguments: viaShell,
    windowsHide: true,
  });
} catch (err) {
  try { fs.closeSync(outFd); } catch {}
  fail(`failed to spawn worker: ${err.message}`);
}

let settled = false;
child.on('error', (err) => {
  if (settled) return;
  settled = true;
  try { fs.closeSync(outFd); } catch {}
  fail(`failed to start worker: ${err.message}`);
});

child.stdin.on('error', () => {});
child.stdin.end(briefText);

child.on('close', (code) => {
  if (settled) return;
  settled = true;
  try { fs.closeSync(outFd); } catch {}

  const exitCode = code !== null ? code : 1;
  try {
    fs.writeFileSync(exitPath, `${exitCode}\n`, 'utf8');
    if (report) {
      const reportPath = path.resolve(process.cwd(), report);
      if (fs.existsSync(reportPath)) {
        fs.copyFileSync(reportPath, path.join(outputDir, `${name}.md`));
      }
    }
  } catch (err) {
    fail(`failed to write exit or report: ${err.message}`);
  }
  process.exit(0);
});
