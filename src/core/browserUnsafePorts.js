// Ports a browser (or a fetch() implementation following the same rule) refuses to connect to at all — the
// WHATWG Fetch "bad port" list (https://fetch.spec.whatwg.org/#port-blocking). Generic and project-agnostic:
// anything that opens the board in a browser cares about this, not just Node's fetch(). The data lives in
// browserUnsafePorts.json, a single canonical, machine-readable list, so this module and the desktop shell's
// Rust settings parser (desktop/src-tauri/src/settings.rs) read the same 82 ports instead of two copies that
// could drift apart. Cross-checked against the `badPorts` table bundled in the installed Node v22.23.2 /
// undici 6.28.0 — not derived by scanning. Re-derive it if a fetch implementation ever changes that table.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DATA_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'browserUnsafePorts.json');

export const BROWSER_UNSAFE_PORTS = new Set(JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')));

export function isBrowserUnsafePort(port) {
  return BROWSER_UNSAFE_PORTS.has(port);
}
