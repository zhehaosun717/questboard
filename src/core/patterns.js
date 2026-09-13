// Package ids and brief paths, derived from the project config.

// config.briefs.packagePattern matches a package id at the start of a brief file name ("RUN-4" in
// "RUN-4-the-way-back.md"); an id on its own must match it completely.
export function packageIdPattern(config) {
  const source = config.briefs.packagePattern.source.replace(/^\^/, '').replace(/\$$/, '');
  return new RegExp(`^(?:${source})$`);
}

export function packageFromFileName(config, fileName) {
  const source = config.briefs.packagePattern.source.replace(/^\^/, '').replace(/\$$/, '');
  const match = fileName.match(new RegExp(`^(?:${source})(?=-|\\.|$)`));
  return match ? match[0] : null;
}

const FILE_NAME = /^[A-Za-z0-9._-]+\.md$/;

// A brief's contents are sent to a third-party model, so a dispatchable quest may only point at a file
// directly inside a configured briefs directory. Owner quests are never dispatched and may also use
// ownerDirs (for example design notes).
export function briefPathAllowed(config, brief, kind) {
  const normalized = String(brief || '').replaceAll('\\', '/');
  const slash = normalized.lastIndexOf('/');
  if (slash < 0) return false;
  const dir = normalized.slice(0, slash);
  const file = normalized.slice(slash + 1);
  const dirs = kind === 'owner' ? [...config.briefs.dispatchDirs, ...config.briefs.ownerDirs] : config.briefs.dispatchDirs;
  return FILE_NAME.test(file) && dirs.map((d) => d.replaceAll('\\', '/').replace(/\/$/, '')).includes(dir);
}
