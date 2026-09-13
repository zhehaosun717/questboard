// The machine-level questboard directory: the model roster and the status log are shared by every
// project on this computer (a Codex limit or an empty DeepSeek balance is true for all of them).
import os from 'node:os';
import path from 'node:path';

export function questboardHome(env = process.env) {
  return env.QUESTBOARD_HOME ? path.resolve(env.QUESTBOARD_HOME) : path.join(os.homedir(), '.questboard');
}

export function homePaths(home = questboardHome()) {
  return {
    home,
    roster: path.join(home, 'roster.json'),
    status: path.join(home, 'status.jsonl'),
  };
}
