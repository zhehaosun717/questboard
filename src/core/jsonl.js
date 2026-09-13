// Append-only JSON lines with fsync, and a reader that fails loudly on corruption — except a torn final
// line, which is what a crash mid-append leaves behind and is safe to skip.
import fs from 'node:fs';
import path from 'node:path';

export function readJsonLines(file) {
  if (!fs.existsSync(file)) return [];
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  const records = [];
  lines.forEach((line, index) => {
    if (!line.trim()) return;
    try {
      records.push(JSON.parse(line));
    } catch (error) {
      const isLast = lines.slice(index + 1).every((rest) => !rest.trim());
      if (!isLast) throw new Error(`${file}:${index + 1} is not JSON: ${error.message}`);
    }
  });
  return records;
}

export function appendJsonLine(file, record) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const handle = fs.openSync(file, 'a');
  try {
    fs.writeSync(handle, `${JSON.stringify(record)}\n`, null, 'utf8');
    fs.fsyncSync(handle);
  } finally {
    fs.closeSync(handle);
  }
}

// Windows refuses a rename over a file an editor or antivirus holds open (EPERM/EBUSY): retry briefly.
export function writeJsonAtomic(file, value, attempts = 5) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  for (let attempt = 1; ; attempt += 1) {
    try {
      fs.renameSync(temp, file);
      return;
    } catch (error) {
      if (attempt >= attempts || !['EPERM', 'EBUSY', 'EACCES'].includes(error.code)) throw new Error(`cannot save ${file}: ${error.message}`);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50 * attempt);
    }
  }
}
