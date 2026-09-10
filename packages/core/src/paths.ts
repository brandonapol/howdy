const SEP = "/";

export const normalizePath = (input: string): string => {
  const absolute = input.startsWith(SEP);
  const parts: string[] = [];
  for (const part of input.split(SEP)) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (parts.length > 0 && parts[parts.length - 1] !== "..") parts.pop();
      else if (!absolute) parts.push("..");
      continue;
    }
    parts.push(part);
  }
  const joined = parts.join(SEP);
  return absolute ? SEP + joined : joined;
};

export const isContained = (parent: string, child: string): boolean => {
  const p = normalizePath(parent).replace(/\/+$/, "");
  const c = normalizePath(child).replace(/\/+$/, "");
  if (p === "" || p === SEP) return true;
  if (c === p) return true;
  return c.startsWith(p + SEP);
};

export const describePath = (workspace: string, path: string): string =>
  isContained(workspace, path)
    ? normalizePath(path).slice(normalizePath(workspace).length + 1) || "."
    : normalizePath(path);
