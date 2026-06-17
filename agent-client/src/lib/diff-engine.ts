export type DiffType = "added" | "removed" | "updated" | "unchanged";

export interface DiffNode {
  type: DiffType;
  key: string;
  path: string;
  oldVal?: unknown;
  newVal?: unknown;
  children?: DiffNode[];
}

function isObject(val: unknown): val is Record<string, unknown> {
  return typeof val === "object" && val !== null;
}

/**
 * Recursively diffs two JSON values.
 */
export function computeJsonDiff(
  oldVal: unknown,
  newVal: unknown,
  key = "",
  path = ""
): DiffNode {
  const currentPath = path ? `${path}.${key}` : key;

  // 1. Identical primitives
  if (oldVal === newVal) {
    return {
      type: "unchanged",
      key,
      path: currentPath,
      newVal,
    };
  }

  // 2. Structural mismatch (one object, one primitive, or different types)
  if (
    isObject(oldVal) !== isObject(newVal) ||
    Array.isArray(oldVal) !== Array.isArray(newVal)
  ) {
    return {
      type: "updated",
      key,
      path: currentPath,
      oldVal,
      newVal,
    };
  }

  // 3. Both are objects (or arrays)
  if (isObject(oldVal) && isObject(newVal)) {
    const oldKeys = Object.keys(oldVal);
    const newKeys = Object.keys(newVal);
    const allKeys = Array.from(new Set([...oldKeys, ...newKeys])).sort();

    const children: DiffNode[] = [];
    let hasChanges = false;

    for (const k of allKeys) {
      const inOld = k in oldVal;
      const inNew = k in newVal;

      if (inOld && !inNew) {
        // Removed
        children.push({
          type: "removed",
          key: k,
          path: currentPath ? `${currentPath}.${k}` : k,
          oldVal: oldVal[k],
        });
        hasChanges = true;
      } else if (!inOld && inNew) {
        // Added
        children.push({
          type: "added",
          key: k,
          path: currentPath ? `${currentPath}.${k}` : k,
          newVal: newVal[k],
        });
        hasChanges = true;
      } else {
        // Present in both, recursively diff
        const childDiff = computeJsonDiff(oldVal[k], newVal[k], k, currentPath);
        children.push(childDiff);
        if (childDiff.type !== "unchanged") {
          hasChanges = true;
        }
      }
    }

    return {
      type: hasChanges ? "updated" : "unchanged",
      key,
      path: currentPath,
      children,
      oldVal: hasChanges ? oldVal : undefined,
      newVal: hasChanges ? newVal : undefined,
    };
  }

  // 4. Different primitives
  return {
    type: "updated",
    key,
    path: currentPath,
    oldVal,
    newVal,
  };
}
