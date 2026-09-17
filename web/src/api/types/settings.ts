// Settings domain (src/server/settingsRoutes.js) plus the lane-argument editing shapes used by the form.
// Split out of api/types.ts; that file is now a re-export barrel for all of these domain files.

// Settings (src/server/settingsRoutes.js). Key sources are booleans; keys never leave the server.
export interface SettingsReport {
  project: {
    name: string;
    root: string;
    port: number;
    paths: { data: string; events: string; registry: string; lock: string };
    briefs: { dispatchDirs: string[]; ownerDirs: string[]; recentDays: number };
    reviewPagesDir: string | null;
    lanes: Array<{ id: string; run: string[]; outputDir: string | null; api: string | null; serve: string[] | null; serialize: boolean; defaultModel: string | null; optionalArgs?: OptionalArgGroup[] }>;
    verification: {
      progressDirs: string[];
      hooks: Array<{
        id: string;
        command: string[];
        timeoutSeconds: number;
        cwd: string;
        envKeys: string[];
        kinds: string[];
        trigger: 'delivered';
        enabled: boolean;
      }>;
    } | null;
    // Additive policy fields (feedback 38); bouncePatterns are compiled on the server (RegExp serializes as {}) so the form edits the raw file through `raw` instead.
    policy: {
      bannedModelPatterns: string[];
      bannedAgents: string[];
      stallAfterMinutes?: number;
      laneConcurrency?: Record<string, number>;
      defaultLane?: string | null;
      defaultCard?: string | null;
    };
  };
  // questboard.config.json exactly as written — what the settings page edits. `project` above is the resolved
  // view (absolute paths, compiled patterns) and cannot be written back.
  raw: Record<string, unknown> | null;
  home: { dir: string; roster: string; rosterExists: boolean; status: string };
  usageKeys: Array<{ id: string; name: string; sources: Array<{ kind: 'env' | 'opencode'; name: string; present: boolean }> }>;
  openCodeAuthFile: { file: string; exists: boolean };
  omo: { file: string; exists: boolean };
}

// Optional argument group for lanes (src/core/config.js).
export interface OptionalArgGroup {
  when: 'variant' | 'agent';
  args: string[];
  omitWhen?: string[];
  insertAt?: number;
  [key: string]: unknown;
}

export interface LanePreviewCard {
  model?: string;
  variant?: string;
  agent?: string;
}

export interface LanePreviewSample {
  name?: string;
  brief?: string;
  package?: string;
}

export interface LanePreviewRequest {
  lane: Record<string, unknown>;
  card?: LanePreviewCard;
  sample?: LanePreviewSample;
}

export interface LanePreviewOmitted {
  when: string;
  reason: string;
}

export interface LanePreviewResponse {
  argv: string[];
  omitted: LanePreviewOmitted[];
  warnings: string[];
}
