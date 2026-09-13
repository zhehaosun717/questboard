// Tails the events file one JSON line at a time. Reads the file, not the server, so a Monitor keeps working
// across server restarts.
import fs from 'node:fs';

export function readNewLines(file, state) {
  if (!fs.existsSync(file)) return [];
  const size = fs.statSync(file).size;
  if (size < state.offset) state.offset = 0;
  if (size === state.offset) return [];
  const handle = fs.openSync(file, 'r');
  try {
    const buffer = Buffer.alloc(size - state.offset);
    fs.readSync(handle, buffer, 0, buffer.length, state.offset);
    state.offset = size;
    const lines = (state.carry + buffer.toString('utf8')).split('\n');
    state.carry = lines.pop();
    return lines.filter((line) => line.trim());
  } finally {
    fs.closeSync(handle);
  }
}

export function watchEvents(file, { fromStart = false, write, intervalMs = 1000 }) {
  const state = { offset: fromStart || !fs.existsSync(file) ? 0 : fs.statSync(file).size, carry: '' };
  const tick = () => {
    for (const line of readNewLines(file, state)) {
      try { write(JSON.stringify(JSON.parse(line))); } catch { process.stderr.write(`bad event line: ${line.slice(0, 200)}\n`); }
    }
  };
  tick();
  return setInterval(tick, intervalMs);
}
