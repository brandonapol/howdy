import { existsSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { analyzeBash, describePath, isContained } from "@howdy/core";
import type { Bot } from "@howdy/core";
import type { CanUseTool, PermissionResult } from "@anthropic-ai/claude-agent-sdk";
import type { Db } from "../db/index.js";
import type { EventBus } from "../events.js";

const PATH_KEYS = ["file_path", "path", "notebook_path", "filePath"] as const;

export type PendingRequest = {
  readonly id: string;
  readonly botId: string;
  readonly roomId: string;
  readonly tool: string;
  readonly rule: string;
  readonly detail: string;
  readonly resolve: (allowed: boolean, always: boolean) => void;
};

export type PermissionBroker = {
  readonly gateFor: (bot: Bot, roomId: string) => CanUseTool;
  readonly decide: (id: string, allowed: boolean, always: boolean) => boolean;
  readonly pending: () => readonly Omit<PendingRequest, "resolve">[];
  readonly cancelAll: () => number;
};

export const settledPath = (raw: string, cwd: string): string => {
  const absolute = isAbsolute(raw) ? raw : resolve(cwd, raw);
  let probe = absolute;
  const tail: string[] = [];
  while (!existsSync(probe) && dirname(probe) !== probe) {
    tail.unshift(probe.slice(dirname(probe).length + 1));
    probe = dirname(probe);
  }
  try {
    return [realpathSync(probe), ...tail].join("/");
  } catch {
    return absolute;
  }
};

const pathFrom = (input: Record<string, unknown>): string | null => {
  for (const key of PATH_KEYS) {
    const value = input[key];
    if (typeof value === "string" && value !== "") return value;
  }
  return null;
};

const allow = (): PermissionResult => ({ behavior: "allow" });
const deny = (message: string): PermissionResult => ({ behavior: "deny", message });

export const createPermissionBroker = (
  db: Db,
  bus: EventBus,
  timeoutMs: number,
): PermissionBroker => {
  const waiting = new Map<string, PendingRequest>();

  const remembered = (botId: string, tool: string, rule: string): boolean =>
    db
      .prepare(
        "SELECT 1 FROM permissions WHERE bot_id = ? AND tool_name = ? AND rule = ? AND behavior = 'allow'",
      )
      .get(botId, tool, rule) !== undefined;

  const remember = (botId: string, tool: string, rule: string): void => {
    db.prepare(
      `INSERT INTO permissions (id, bot_id, tool_name, rule, behavior, created_at)
       VALUES (?,?,?,?,'allow',?) ON CONFLICT(bot_id, tool_name, rule) DO NOTHING`,
    ).run(randomUUID(), botId, tool, rule, Date.now());
  };

  const ask = (
    bot: Bot,
    roomId: string,
    tool: string,
    rule: string,
    detail: string,
    signal: AbortSignal,
  ): Promise<PermissionResult> =>
    new Promise<PermissionResult>((settle) => {
      const id = randomUUID();
      let done = false;

      const finish = (result: PermissionResult) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        waiting.delete(id);
        settle(result);
      };

      const timer = setTimeout(
        () => finish(deny(`no answer within ${Math.round(timeoutMs / 1000)}s, denied by default`)),
        timeoutMs,
      );

      signal.addEventListener("abort", () => finish(deny("turn aborted")), { once: true });

      waiting.set(id, {
        id,
        botId: String(bot.id),
        roomId,
        tool,
        rule,
        detail,
        resolve: (allowed, always) => {
          if (allowed && always) remember(String(bot.id), tool, rule);
          bus.publish({ kind: "permissionResolved", id, allowed });
          finish(allowed ? allow() : deny("denied by the operator"));
        },
      });

      bus.publish({
        kind: "permissionRequest",
        id,
        roomId,
        botId: String(bot.id),
        tool,
        detail,
      });
    });

  const gateFor = (bot: Bot, roomId: string): CanUseTool =>
    async (toolName, input, options) => {
      if (toolName === "Bash") {
        const command = typeof input["command"] === "string" ? input["command"] : "";
        const analysis = analyzeBash(command, bot.allowedCommands);

        if (analysis.verdict === "deny") {
          return deny(`refused: ${analysis.reason}`);
        }

        const escaping = [...analysis.redirects, ...analysis.paths]
          .map((target) => settledPath(target, bot.workspacePath))
          .filter((target) => !isContained(bot.workspacePath, target));

        if (escaping.length > 0) {
          const first = escaping[0] ?? "";
          if (remembered(String(bot.id), "Bash", `path:${first}`)) return allow();
          return ask(
            bot, roomId, "Bash", `path:${first}`,
            `${command}\n\nreaches outside the workspace: ${escaping.join(", ")}`,
            options.signal,
          );
        }

        if (analysis.verdict === "allow") return allow();

        const rule = analysis.binaries.find((b) => !bot.allowedCommands.includes(b)) ?? command;
        if (remembered(String(bot.id), "Bash", rule)) return allow();
        return ask(bot, roomId, "Bash", rule, command, options.signal);
      }

      if (toolName.startsWith("mcp__howdy-")) return allow();

      const raw = pathFrom(input);
      if (raw !== null) {
        const target = settledPath(raw, bot.workspacePath);
        if (isContained(bot.workspacePath, target)) return allow();
        if (remembered(String(bot.id), toolName, target)) return allow();
        return ask(
          bot, roomId, toolName, target,
          `${toolName} outside the workspace: ${describePath(bot.workspacePath, target)}`,
          options.signal,
        );
      }

      if (remembered(String(bot.id), toolName, "*")) return allow();
      return ask(bot, roomId, toolName, "*", `${toolName} with ${JSON.stringify(input).slice(0, 200)}`, options.signal);
    };

  return {
    gateFor,
    decide: (id, allowed, always) => {
      const request = waiting.get(id);
      if (request === undefined) return false;
      request.resolve(allowed, always);
      return true;
    },
    pending: () =>
      [...waiting.values()].map(({ resolve: _resolve, ...rest }) => rest),
    cancelAll: () => {
      const count = waiting.size;
      for (const request of [...waiting.values()]) request.resolve(false, false);
      return count;
    },
  };
};
