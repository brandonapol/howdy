import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { openDb } from "./db/index.js";
import type { Config } from "./config.js";

const stamp = (now = Date.now()): string =>
  new Date(now).toISOString().replace(/[:.]/g, "-").slice(0, 19);

export const backup = async (
  config: Config,
  destination: string,
  now = Date.now(),
): Promise<string> => {
  mkdirSync(destination, { recursive: true });
  const name = `howdy-${stamp(now)}`;
  const staging = join(destination, name);
  mkdirSync(staging, { recursive: true });

  const db = openDb(config.dbPath);
  try {
    await db.backup(join(staging, "howdy.db"));
  } finally {
    db.close();
  }

  const archive = join(destination, `${name}.tar.gz`);
  const parts = ["-czf", archive, "-C", staging, "howdy.db"];
  if (existsSync(config.botsDir)) {
    parts.push("-C", config.root, "bots");
  }
  execFileSync("tar", parts, { stdio: "pipe" });
  rmSync(staging, { recursive: true, force: true });
  return archive;
};

export const restore = (config: Config, archive: string): void => {
  if (!existsSync(archive)) throw new Error(`no such archive: ${archive}`);
  mkdirSync(config.root, { recursive: true });

  const existing = existsSync(config.dbPath);
  if (existing) {
    execFileSync("cp", [config.dbPath, `${config.dbPath}.before-restore`], { stdio: "pipe" });
  }

  execFileSync("tar", ["-xzf", archive, "-C", config.root], { stdio: "pipe" });
  for (const suffix of ["-wal", "-shm"]) {
    const stale = `${config.dbPath}${suffix}`;
    if (existsSync(stale)) rmSync(stale);
  }
};

export const listBackups = (destination: string): readonly string[] =>
  existsSync(destination)
    ? readdirSync(destination)
        .filter((f) => f.startsWith("howdy-") && f.endsWith(".tar.gz"))
        .sort()
    : [];
