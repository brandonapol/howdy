import { homedir } from "node:os";
import { join, resolve } from "node:path";

const env = (key: string, fallback: string): string => {
  const v = process.env[key];
  return v === undefined || v === "" ? fallback : v;
};

const int = (key: string, fallback: number): number => {
  const v = Number(process.env[key]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
};

export type Config = {
  readonly root: string;
  readonly dbPath: string;
  readonly botsDir: string;
  readonly workspacesDir: string;
  readonly host: string;
  readonly port: number;
  readonly sharedSecret: string | null;
  readonly turnTimeoutMs: number;
  readonly permissionTimeoutMs: number;
  readonly dailyTokenCeiling: number;
  readonly webDist: string | null;
};

export const loadConfig = (): Config => {
  const root = resolve(env("HOWDY_ROOT", join(homedir(), ".howdy")));
  const secret = process.env["HOWDY_SECRET"];
  const webDist = process.env["HOWDY_WEB_DIST"];
  return {
    root,
    dbPath: join(root, "howdy.db"),
    botsDir: join(root, "bots"),
    workspacesDir: join(root, "workspaces"),
    host: env("HOWDY_HOST", "0.0.0.0"),
    port: int("HOWDY_PORT", 4747),
    sharedSecret: secret === undefined || secret === "" ? null : secret,
    turnTimeoutMs: int("HOWDY_TURN_TIMEOUT_MS", 180_000),
    permissionTimeoutMs: int("HOWDY_PERMISSION_TIMEOUT_MS", 120_000),
    dailyTokenCeiling: int("HOWDY_DAILY_TOKEN_CEILING", 2_000_000),
    webDist: webDist === undefined || webDist === "" ? null : resolve(webDist),
  };
};
