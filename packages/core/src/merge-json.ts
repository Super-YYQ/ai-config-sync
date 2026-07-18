/**
 * Field-level JSON merge with ownership and unknown-field preservation.
 * Arrays of objects with `id` are merged by id; plain arrays are de-duplicated.
 */

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

export interface MergeJsonOptions {
  /** Dot-paths this tool is allowed to write. Empty = allow all managed keys in `managed`. */
  ownedPaths?: string[];
  /** Prefer managed values for owned keys; keep base for unowned. */
  preferManaged?: boolean;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function hasId(v: unknown): v is { id: string } {
  return isPlainObject(v) && typeof v.id === "string";
}

function pathAllowed(path: string, owned?: string[]): boolean {
  if (!owned || owned.length === 0) return true;
  return owned.some(
    (o) => path === o || path.startsWith(`${o}.`) || o.startsWith(`${path}.`),
  );
}

/**
 * Merge `managed` into `base`. Unknown keys in base are preserved.
 * Keys only in managed are added when allowed by ownership.
 */
export function mergeJson(
  base: unknown,
  managed: unknown,
  options: MergeJsonOptions = {},
  currentPath = "",
): unknown {
  const preferManaged = options.preferManaged ?? true;

  if (Array.isArray(base) || Array.isArray(managed)) {
    return mergeArrays(
      Array.isArray(base) ? base : [],
      Array.isArray(managed) ? managed : [],
      options,
      currentPath,
    );
  }

  if (isPlainObject(base) || isPlainObject(managed)) {
    const baseObj = isPlainObject(base) ? base : {};
    const managedObj = isPlainObject(managed) ? managed : {};
    const keys = new Set([
      ...Object.keys(baseObj),
      ...Object.keys(managedObj),
    ]);
    const out: Record<string, unknown> = {};
    for (const key of keys) {
      const childPath = currentPath ? `${currentPath}.${key}` : key;
      const inBase = key in baseObj;
      const inManaged = key in managedObj;

      if (inBase && !inManaged) {
        out[key] = baseObj[key];
        continue;
      }
      if (!inBase && inManaged) {
        if (pathAllowed(childPath, options.ownedPaths)) {
          out[key] = managedObj[key];
        }
        continue;
      }
      // both
      if (
        isPlainObject(baseObj[key]) ||
        isPlainObject(managedObj[key]) ||
        Array.isArray(baseObj[key]) ||
        Array.isArray(managedObj[key])
      ) {
        out[key] = mergeJson(
          baseObj[key],
          managedObj[key],
          options,
          childPath,
        );
      } else if (pathAllowed(childPath, options.ownedPaths) && preferManaged) {
        out[key] = managedObj[key];
      } else {
        out[key] = baseObj[key];
      }
    }
    return out;
  }

  // primitives
  if (managed === undefined) return base;
  if (pathAllowed(currentPath, options.ownedPaths) && preferManaged) {
    return managed;
  }
  return base ?? managed;
}

function mergeArrays(
  base: unknown[],
  managed: unknown[],
  options: MergeJsonOptions,
  currentPath: string,
): unknown[] {
  if (base.every(hasId) || managed.every(hasId)) {
    const map = new Map<string, unknown>();
    for (const item of base) {
      if (hasId(item)) map.set(item.id, item);
      else map.set(JSON.stringify(item), item);
    }
    for (const item of managed) {
      if (hasId(item)) {
        const existing = map.get(item.id);
        if (existing && isPlainObject(existing) && isPlainObject(item)) {
          map.set(
            item.id,
            mergeJson(existing, item, options, `${currentPath}[${item.id}]`),
          );
        } else {
          map.set(item.id, item);
        }
      } else {
        map.set(JSON.stringify(item), item);
      }
    }
    return [...map.values()];
  }

  // scalar / mixed arrays: union by JSON string, preserve base order first
  const seen = new Set<string>();
  const out: unknown[] = [];
  for (const item of [...base, ...managed]) {
    const key = JSON.stringify(item);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

/**
 * Set a dotted path on a plain object tree (creates intermediate objects).
 * Does not mutate the original.
 */
export function setByPath(
  root: unknown,
  dottedPath: string,
  value: unknown,
): unknown {
  const parts = dottedPath.split(".").filter(Boolean);
  if (parts.length === 0) return value;

  const clone = isPlainObject(root)
    ? { ...root }
    : Array.isArray(root)
      ? [...root]
      : {};

  let cursor: Record<string, unknown> = clone as Record<string, unknown>;
  for (let i = 0; i < parts.length - 1; i++) {
    const p = parts[i]!;
    const next = cursor[p];
    if (isPlainObject(next)) {
      cursor[p] = { ...next };
    } else {
      cursor[p] = {};
    }
    cursor = cursor[p] as Record<string, unknown>;
  }
  cursor[parts[parts.length - 1]!] = value;
  return clone;
}

export function getByPath(root: unknown, dottedPath: string): unknown {
  const parts = dottedPath.split(".").filter(Boolean);
  let cursor: unknown = root;
  for (const p of parts) {
    if (!isPlainObject(cursor)) return undefined;
    cursor = cursor[p];
  }
  return cursor;
}
