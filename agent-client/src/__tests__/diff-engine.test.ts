import { describe, it, expect } from "vitest";
import { computeJsonDiff } from "../lib/diff-engine";

describe("JSON Diff Engine", () => {
  it("should mark identical values as unchanged", () => {
    const oldVal = { a: 1, b: "hello", c: true };
    const newVal = { a: 1, b: "hello", c: true };

    const diff = computeJsonDiff(oldVal, newVal, "root");

    expect(diff.type).toBe("unchanged");
    expect(diff.children?.length).toBe(3);
    expect(diff.children![0].type).toBe("unchanged");
    expect(diff.children![1].type).toBe("unchanged");
    expect(diff.children![2].type).toBe("unchanged");
  });

  it("should identify added keys", () => {
    const oldVal = { a: 1 };
    const newVal = { a: 1, b: 2 };

    const diff = computeJsonDiff(oldVal, newVal, "root");

    expect(diff.type).toBe("updated"); // Root updated because it has changes
    const bNode = diff.children!.find((c) => c.key === "b");
    expect(bNode).toBeDefined();
    expect(bNode!.type).toBe("added");
    expect(bNode!.newVal).toBe(2);
    expect(bNode!.oldVal).toBeUndefined();
    expect(bNode!.path).toBe("root.b");
  });

  it("should identify removed keys", () => {
    const oldVal = { a: 1, b: 2 };
    const newVal = { a: 1 };

    const diff = computeJsonDiff(oldVal, newVal, "root");

    expect(diff.type).toBe("updated");
    const bNode = diff.children!.find((c) => c.key === "b");
    expect(bNode).toBeDefined();
    expect(bNode!.type).toBe("removed");
    expect(bNode!.oldVal).toBe(2);
    expect(bNode!.newVal).toBeUndefined();
  });

  it("should identify updated primitives", () => {
    const oldVal = { a: 1, b: "hello" };
    const newVal = { a: 1, b: "world" };

    const diff = computeJsonDiff(oldVal, newVal, "root");

    expect(diff.type).toBe("updated");
    const bNode = diff.children!.find((c) => c.key === "b");
    expect(bNode).toBeDefined();
    expect(bNode!.type).toBe("updated");
    expect(bNode!.oldVal).toBe("hello");
    expect(bNode!.newVal).toBe("world");
  });

  it("should identify nested modifications", () => {
    const oldVal = {
      user: {
        name: "Alice",
        age: 30,
      },
    };
    const newVal = {
      user: {
        name: "Alice",
        age: 31,
      },
    };

    const diff = computeJsonDiff(oldVal, newVal, "root");

    expect(diff.type).toBe("updated");
    const userNode = diff.children!.find((c) => c.key === "user");
    expect(userNode).toBeDefined();
    expect(userNode!.type).toBe("updated");

    const ageNode = userNode!.children!.find((c) => c.key === "age");
    expect(ageNode).toBeDefined();
    expect(ageNode!.type).toBe("updated");
    expect(ageNode!.oldVal).toBe(30);
    expect(ageNode!.newVal).toBe(31);
    expect(ageNode!.path).toBe("root.user.age");
  });

  it("should identify structural changes from primitive to object", () => {
    const oldVal = { info: "none" };
    const newVal = { info: { details: "some" } };

    const diff = computeJsonDiff(oldVal, newVal, "root");

    expect(diff.type).toBe("updated");
    const infoNode = diff.children!.find((c) => c.key === "info");
    expect(infoNode).toBeDefined();
    expect(infoNode!.type).toBe("updated");
    expect(infoNode!.oldVal).toBe("none");
    expect(infoNode!.newVal).toEqual({ details: "some" });
    expect(infoNode!.children).toBeUndefined(); // Structural changes don't recursively diff incompatible shapes
  });
});
