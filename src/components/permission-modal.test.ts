import { describe, test, expect } from "bun:test";
import { multiResourceList } from "./PermissionModal.tsx";

describe("multiResourceList (C2.11)", () => {
  test("undefined resources show the title alone", () => {
    expect(multiResourceList(undefined)).toBeNull();
  });

  test("v1 shape: a single resource equal to the title is not listed", () => {
    expect(multiResourceList(["bash: ls"])).toBeNull();
  });

  test("empty resources are not listed", () => {
    expect(multiResourceList([])).toBeNull();
  });

  test("more than one resource is returned in order for listing", () => {
    expect(multiResourceList(["sleep 20", "echo finished"])).toEqual(["sleep 20", "echo finished"]);
  });
});
