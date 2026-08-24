import packageManifest from "../package.json" with { type: "json" };
import { describe, expect, it } from "vitest";
import { PACKAGE_VERSION } from "./version.js";

describe("package version identity", () => {
  it("uses the published package version for every runtime identity", () => {
    expect(PACKAGE_VERSION).toBe(packageManifest.version);
    expect(PACKAGE_VERSION).toMatch(/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u);
  });
});
