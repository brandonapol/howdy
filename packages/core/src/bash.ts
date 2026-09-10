export type BashVerdict = "allow" | "ask" | "deny";

export type BashAnalysis = {
  readonly verdict: BashVerdict;
  readonly reason: string;
  readonly binaries: readonly string[];
  readonly redirects: readonly string[];
  readonly paths: readonly string[];
};

export const looksLikePath = (token: string): boolean =>
  token.startsWith("/") ||
  token.startsWith("~") ||
  token === ".." ||
  token.startsWith("../") ||
  token.includes("/../");

export const DENIED_BINARIES: readonly string[] = [
  "sh", "bash", "zsh", "dash", "ksh", "fish", "csh", "tcsh",
  "sudo", "doas", "su", "pkexec",
  "eval", "exec", "source",
  "dd", "mkfs", "fdisk", "parted", "shred", "wipefs", "sfdisk", "mkswap",
  "shutdown", "reboot", "halt", "poweroff", "init", "systemctl",
  "iptables", "nft", "ufw", "modprobe", "insmod", "rmmod",
  "useradd", "userdel", "usermod", "passwd", "visudo", "chpasswd",
  "crontab", "at", "nc", "ncat", "netcat", "telnet",
];

const WRAPPERS: readonly string[] = [
  "xargs", "env", "nohup", "timeout", "time", "watch", "nice", "ionice",
  "command", "builtin", "stdbuf", "setsid", "unbuffered",
];

type DenyRule = { readonly test: RegExp; readonly reason: string };

const DENY_RULES: readonly DenyRule[] = [
  {
    test: /\brm\s+(?:-[a-z]*\s+)*-?[a-z]*(?:rf|fr)[a-z]*\s+(?:-{2}\s+)?(?:\/|~|\$HOME|\/\*|\.\.)\s*(?:\*)?\s*$/i,
    reason: "recursive force delete of a root or home path",
  },
  { test: /:\s*\(\s*\)\s*\{.*\|.*&.*\}\s*;/, reason: "fork bomb" },
  { test: /\bchmod\s+(?:-R\s+)?0?777\s+\/(?:\s|$)/, reason: "world-writable root" },
  { test: /\bchown\s+-R\s+[^\s]+\s+\/(?:\s|$)/, reason: "recursive chown of root" },
  { test: /\bgit\s+push\b[^\n]*\s(?:--force(?!-with-lease)|-f)(?:\s|$)/, reason: "force push rewrites shared history" },
  { test: />\s*\/dev\/(?:sd|nvme|mmcblk|hd)/, reason: "raw write to a block device" },
  { test: />\s*\/etc\//, reason: "write into /etc" },
  { test: /\bhistory\s+-c\b/, reason: "clearing shell history" },
];

const isSpace = (ch: string): boolean => ch === " " || ch === "\t";

export const splitSegments = (input: string): readonly string[] => {
  const out: string[] = [];
  let current = "";
  let single = false;
  let double = false;
  let depth = 0;
  let backtick = false;

  const flush = () => {
    if (current.trim() !== "") out.push(current.trim());
    current = "";
  };

  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i] ?? "";
    const next = input[i + 1] ?? "";

    if (ch === "\\" && !single) {
      current += ch + next;
      i += 1;
      continue;
    }
    if (ch === "'" && !double && !backtick) { single = !single; current += ch; continue; }
    if (ch === '"' && !single && !backtick) { double = !double; current += ch; continue; }
    if (single) { current += ch; continue; }

    if (ch === "`") { backtick = !backtick; current += ch; continue; }
    if (ch === "$" && (next === "(" )) { depth += 1; current += "$("; i += 1; continue; }
    if ((ch === "<" || ch === ">") && next === "(") { depth += 1; current += ch + "("; i += 1; continue; }
    if (ch === "(" && depth > 0) { depth += 1; current += ch; continue; }
    if (ch === ")" && depth > 0) { depth -= 1; current += ch; continue; }

    if (!double && !backtick && depth === 0) {
      if (ch === "&" && next === "&") { flush(); i += 1; continue; }
      if (ch === "|" && next === "|") { flush(); i += 1; continue; }
      if (ch === "|" || ch === ";" || ch === "&" || ch === "\n") { flush(); continue; }
    }
    current += ch;
  }
  flush();
  return out;
};

export const extractSubstitutions = (input: string): readonly string[] => {
  const found: string[] = [];
  let single = false;

  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i] ?? "";
    const next = input[i + 1] ?? "";
    if (ch === "\\") { i += 1; continue; }
    if (ch === "'") { single = !single; continue; }
    if (single) continue;

    const opensDollar = ch === "$" && next === "(";
    const opensProcess = (ch === "<" || ch === ">") && next === "(";
    if (opensDollar || opensProcess) {
      let depth = 1;
      let j = i + 2;
      let inner = "";
      while (j < input.length && depth > 0) {
        const c = input[j] ?? "";
        if (c === "(") depth += 1;
        else if (c === ")") depth -= 1;
        if (depth > 0) inner += c;
        j += 1;
      }
      found.push(inner);
      i = j - 1;
      continue;
    }

    if (ch === "`") {
      let j = i + 1;
      let inner = "";
      while (j < input.length && input[j] !== "`") {
        inner += input[j] ?? "";
        j += 1;
      }
      found.push(inner);
      i = j;
    }
  }
  return found;
};

const stripSubstitutions = (input: string): string =>
  input
    .replace(/\$\([^()]*\)/g, " ")
    .replace(/[<>]\([^()]*\)/g, " ")
    .replace(/`[^`]*`/g, " ");

export const tokenize = (segment: string): readonly string[] => {
  const tokens: string[] = [];
  let current = "";
  let single = false;
  let double = false;

  for (let i = 0; i < segment.length; i += 1) {
    const ch = segment[i] ?? "";
    if (ch === "\\" && !single) { current += segment[i + 1] ?? ""; i += 1; continue; }
    if (ch === "'" && !double) { single = !single; continue; }
    if (ch === '"' && !single) { double = !double; continue; }
    if (!single && !double && isSpace(ch)) {
      if (current !== "") tokens.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  if (current !== "") tokens.push(current);
  return tokens;
};

const basename = (word: string): string => {
  const clean = word.split("/").pop() ?? word;
  return clean.toLowerCase();
};

const isAssignment = (token: string): boolean => /^[A-Za-z_][A-Za-z0-9_]*=/.test(token);

const REDIRECT = /^\d*(?:>>|>|<)$/;

export const commandOf = (
  segment: string,
): {
  readonly binary: string | null;
  readonly redirects: readonly string[];
  readonly args: readonly string[];
} => {
  const tokens = tokenize(segment);
  const redirects: string[] = [];
  const args: string[] = [];
  let binary: string | null = null;
  let index = 0;

  while (index < tokens.length) {
    const token = tokens[index];
    if (token === undefined) break;

    const inlineRedirect = /^\d*(?:>>|>|<)(.+)$/.exec(token);
    if (inlineRedirect !== null) {
      const target = inlineRedirect[1];
      if (target !== undefined) redirects.push(target);
      index += 1;
      continue;
    }
    if (REDIRECT.test(token)) {
      const target = tokens[index + 1];
      if (target !== undefined) redirects.push(target);
      index += 2;
      continue;
    }
    if (binary === null && isAssignment(token)) { index += 1; continue; }
    if (binary === null) {
      const name = basename(token);
      if (WRAPPERS.includes(name)) {
        index += 1;
        while (index < tokens.length) {
          const arg = tokens[index] ?? "";
          if (arg.startsWith("-") || /^\d+(?:\.\d+)?[smhd]?$/.test(arg)) index += 1;
          else break;
        }
        continue;
      }
      binary = name;
      index += 1;
      continue;
    }
    args.push(token);
    index += 1;
  }

  return { binary, redirects, args };
};

export const analyzeBash = (
  command: string,
  allowlist: readonly string[],
): BashAnalysis => {
  const allowed = new Set(allowlist.map((c) => c.toLowerCase()));
  const binaries: string[] = [];
  const redirects: string[] = [];
  const paths: string[] = [];
  let ask: string | null = null;

  const walk = (input: string, depth: number): BashAnalysis | null => {
    if (depth > 6) {
      return {
        verdict: "deny",
        reason: "command nests substitutions too deeply to analyse",
        binaries,
        redirects,
        paths,
      };
    }

    for (const rule of DENY_RULES) {
      if (rule.test.test(input)) {
        return { verdict: "deny", reason: rule.reason, binaries, redirects, paths };
      }
    }

    for (const segment of splitSegments(input)) {
      for (const inner of extractSubstitutions(segment)) {
        const nested = walk(inner, depth + 1);
        if (nested !== null && nested.verdict === "deny") return nested;
      }

      const { binary, redirects: found, args } = commandOf(stripSubstitutions(segment));
      redirects.push(...found);
      paths.push(...args.filter(looksLikePath));
      if (binary === null) continue;
      binaries.push(binary);

      if (DENIED_BINARIES.includes(binary) || binary.startsWith("mkfs")) {
        return {
          verdict: "deny",
          reason: `${binary} is never allowed`,
          binaries,
          redirects,
          paths,
        };
      }
      if (!allowed.has(binary) && ask === null) ask = binary;
    }
    return null;
  };

  const denied = walk(command, 0);
  if (denied !== null) return denied;

  if (binaries.length === 0) {
    return { verdict: "ask", reason: "no command could be parsed", binaries, redirects, paths };
  }
  if (ask !== null) {
    return { verdict: "ask", reason: `${ask} is not on the allowlist`, binaries, redirects, paths };
  }
  return { verdict: "allow", reason: "every command is allowlisted", binaries, redirects, paths };
};
