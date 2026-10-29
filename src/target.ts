/**
 * Target addressing: one parser and one matcher for both directions.
 *
 * Kept in its own module (not in policy.ts) so that channel/outbound can use
 * it without inheriting policy's cycle and so that tests which stub the policy
 * module still get a working parser.
 */

export type TargetType = "private" | "group";

export interface ParsedTarget {
  type: TargetType;
  id: number;
}

/** `onebot:group:123` / `group:123` / `private:123` / `123` (bare => private). */
export function parseTarget(to: string): ParsedTarget {
  const normalized = String(to).replace(/^onebot:/i, "");
  if (normalized.startsWith("private:")) {
    return { type: "private", id: Number(normalized.slice(8)) };
  }
  if (normalized.startsWith("group:")) {
    return { type: "group", id: Number(normalized.slice(6)) };
  }
  return { type: "private", id: Number(normalized) };
}

export function targetKey(type: TargetType, id: number | string): string {
  return `${type}:${id}`;
}

/**
 * Supported pattern forms: `*`, `group:123`, `group:*`.
 * A bare number never matches — config.ts normalises legacy numeric patterns
 * to `group:<id>` before they get here.
 */
export function matchesTargetPattern(pattern: string, key: string, type: TargetType): boolean {
  const p = String(pattern).trim();
  if (!p) return false;
  if (p === "*") return true;
  if (p === key) return true;
  if (p === `${type}:*`) return true;
  return false;
}

export function matchesAnyTarget(
  patterns: string[] | undefined,
  key: string,
  type: TargetType,
): boolean {
  if (!patterns || patterns.length === 0) return false;
  return patterns.some((p) => matchesTargetPattern(p, key, type));
}
