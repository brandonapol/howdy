import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { botId, defaultCeilings } from "@howdy/core";
import type { Bot, Effort, ModelId } from "@howdy/core";
import type { Db } from "../db/index.js";
import type { Config } from "../config.js";

export const DEFAULT_ALLOWED_COMMANDS: readonly string[] = [
  "gh", "git", "ls", "cat", "head", "tail", "wc", "rg", "grep", "fd", "find",
  "echo", "pwd", "mkdir", "touch", "cp", "mv", "diff", "sort", "uniq", "jq",
  "node", "npm", "npx", "tsc", "kubectl", "helm", "argocd", "docker", "curl",
  "date", "which", "env", "sed", "awk", "tree", "du", "df",
];

const TEMPLATE = (name: string) => `# ${name}

## Who you are

Write who this bot is. Voice, temperament, what it cares about, what it refuses
to do. This file is yours to edit; the bot never writes to it.

## How you work

- Prefer doing over describing.
- Say when you are unsure.
- Keep it short unless the work justifies length.

## What you know

Standing context this bot should always have: your infrastructure, your naming
conventions, the repos it should care about.
`;

type BotRow = {
  id: string; slug: string; name: string; model: string; effort: string;
  noisiness: number; cooldown_turns: number; avatar_color: string;
  bot_dir: string; workspace_path: string; allowed_commands: string; enabled: number;
};

const toBot = (row: BotRow): Bot => ({
  id: botId(row.id),
  slug: row.slug,
  name: row.name,
  model: row.model as ModelId,
  effort: row.effort as Effort,
  noisiness: row.noisiness,
  cooldownTurns: row.cooldown_turns,
  avatarColor: row.avatar_color,
  botDir: row.bot_dir,
  workspacePath: row.workspace_path,
  allowedCommands: JSON.parse(row.allowed_commands) as string[],
  enabled: row.enabled === 1,
});

export const slugify = (name: string): string =>
  name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) ||
  "bot";

export type CreateBotInput = {
  readonly name: string;
  readonly model?: ModelId;
  readonly effort?: Effort;
  readonly noisiness?: number;
  readonly cooldownTurns?: number;
  readonly avatarColor?: string;
  readonly allowedCommands?: readonly string[];
};

export type BotStore = {
  readonly list: () => readonly Bot[];
  readonly get: (id: string) => Bot | null;
  readonly bySlug: (slug: string) => Bot | null;
  readonly create: (input: CreateBotInput) => Bot;
  readonly update: (id: string, patch: Partial<CreateBotInput> & { enabled?: boolean }) => Bot | null;
  readonly remove: (id: string) => boolean;
  readonly personality: (bot: Bot) => string;
  readonly writePersonality: (bot: Bot, text: string) => void;
  readonly memory: (bot: Bot) => string;
  readonly remember: (bot: Bot, fact: string, now?: number) => void;
};

const clamp01 = (n: number): number => Math.min(1, Math.max(0, n));

export const createBotStore = (db: Db, config: Config): BotStore => {
  const select = db.prepare("SELECT * FROM bots WHERE id = ?");
  const selectSlug = db.prepare("SELECT * FROM bots WHERE slug = ?");
  const selectAll = db.prepare("SELECT * FROM bots ORDER BY name");

  const read = (path: string): string =>
    existsSync(path) ? readFileSync(path, "utf8") : "";

  return {
    list: () => (selectAll.all() as BotRow[]).map(toBot),
    get: (id) => {
      const row = select.get(id) as BotRow | undefined;
      return row === undefined ? null : toBot(row);
    },
    bySlug: (slug) => {
      const row = selectSlug.get(slug) as BotRow | undefined;
      return row === undefined ? null : toBot(row);
    },
    create: (input) => {
      const name = input.name.trim() === "" ? "Bot" : input.name.trim();
      const base = slugify(name);
      let slug = base;
      let n = 2;
      while (selectSlug.get(slug) !== undefined) {
        slug = `${base}-${n}`;
        n += 1;
      }
      const id = randomUUID();
      const botDir = join(config.botsDir, slug);
      const workspacePath = join(config.workspacesDir, slug);
      mkdirSync(join(botDir, "notes"), { recursive: true });
      mkdirSync(workspacePath, { recursive: true });
      const personalityPath = join(botDir, "personality.md");
      if (!existsSync(personalityPath)) writeFileSync(personalityPath, TEMPLATE(name));
      const memoryPath = join(botDir, "memory.md");
      if (!existsSync(memoryPath)) writeFileSync(memoryPath, "");

      db.prepare(
        `INSERT INTO bots (id, slug, name, model, effort, noisiness, cooldown_turns,
          avatar_color, bot_dir, workspace_path, allowed_commands, enabled, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,1,?)`,
      ).run(
        id, slug, name,
        input.model ?? "claude-sonnet-5",
        input.effort ?? "medium",
        clamp01(input.noisiness ?? 0.7),
        Math.max(0, input.cooldownTurns ?? 1),
        input.avatarColor ?? "#6b8f71",
        botDir, workspacePath,
        JSON.stringify(input.allowedCommands ?? DEFAULT_ALLOWED_COMMANDS),
        Date.now(),
      );
      return toBot(select.get(id) as BotRow);
    },
    update: (id, patch) => {
      const row = select.get(id) as BotRow | undefined;
      if (row === undefined) return null;
      db.prepare(
        `UPDATE bots SET name=?, model=?, effort=?, noisiness=?, cooldown_turns=?,
         avatar_color=?, allowed_commands=?, enabled=? WHERE id=?`,
      ).run(
        patch.name ?? row.name,
        patch.model ?? row.model,
        patch.effort ?? row.effort,
        patch.noisiness === undefined ? row.noisiness : clamp01(patch.noisiness),
        patch.cooldownTurns === undefined ? row.cooldown_turns : Math.max(0, patch.cooldownTurns),
        patch.avatarColor ?? row.avatar_color,
        patch.allowedCommands === undefined
          ? row.allowed_commands
          : JSON.stringify(patch.allowedCommands),
        patch.enabled === undefined ? row.enabled : patch.enabled ? 1 : 0,
        id,
      );
      return toBot(select.get(id) as BotRow);
    },
    remove: (id) => db.prepare("DELETE FROM bots WHERE id = ?").run(id).changes > 0,
    personality: (bot) => read(join(bot.botDir, "personality.md")),
    writePersonality: (bot, text) => {
      mkdirSync(bot.botDir, { recursive: true });
      writeFileSync(join(bot.botDir, "personality.md"), text);
    },
    memory: (bot) => read(join(bot.botDir, "memory.md")),
    remember: (bot, fact, now = Date.now()) => {
      const trimmed = fact.trim();
      if (trimmed === "") return;
      const path = join(bot.botDir, "memory.md");
      mkdirSync(bot.botDir, { recursive: true });
      const stamp = new Date(now).toISOString().slice(0, 10);
      writeFileSync(path, `${read(path)}- (${stamp}) ${trimmed}\n`);
    },
  };
};

export const defaultRoomCeilings = defaultCeilings;
