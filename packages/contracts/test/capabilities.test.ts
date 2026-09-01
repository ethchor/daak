import { describe, expect, it } from "vitest";
import {
  type Capability,
  CORE_CAPABILITIES,
  grants,
  grantsAll,
  isCapability,
  missingCapabilities,
  USER_INVOKER,
} from "../src/capabilities.js";

describe("capabilities", () => {
  it("recognises core and parameterised capabilities", () => {
    expect(isCapability("mail:read")).toBe(true);
    expect(isCapability("command:invoke:mail.archive")).toBe(true);
    expect(isCapability("net:fetch:api.example.com")).toBe(true);
    expect(isCapability("mail:delete-everything")).toBe(false);
    // A bare prefix with no argument grants nothing and is not a capability.
    expect(isCapability("command:invoke:")).toBe(false);
  });

  it("has no implicit hierarchy: reading bodies is a separate ask from reading metadata", () => {
    expect(grants(["mail:read-body"], "mail:read")).toBe(false);
    expect(grants(["mail:read"], "mail:read-body")).toBe(false);
  });

  it("never lets draft:write imply mail:send", () => {
    expect(grants(["draft:write"], "mail:send")).toBe(false);
  });

  it("widens only within a parameterised namespace when a wildcard is held", () => {
    expect(grants(["command:invoke:mail.*"], "command:invoke:mail.archive")).toBe(true);
    expect(grants(["command:invoke:mail.*"], "command:invoke:settings.open")).toBe(false);
    expect(grants(["net:fetch:*"], "net:fetch:example.com")).toBe(true);
    // A bare `*` must not become ambient authority.
    expect(grants(["*" as Capability], "mail:read")).toBe(false);
  });

  it("reports precisely what is missing", () => {
    const held: Capability[] = ["mail:read", "annotation:write"];
    expect(missingCapabilities(held, ["mail:read", "mail:send", "blob:read"])).toEqual([
      "mail:send",
      "blob:read",
    ]);
    expect(grantsAll(held, ["mail:read", "annotation:write"])).toBe(true);
    expect(grantsAll(held, ["mail:read", "mail:send"])).toBe(false);
  });

  it("gives the direct user everything", () => {
    for (const capability of CORE_CAPABILITIES) {
      expect(grants(USER_INVOKER.capabilities, capability)).toBe(true);
    }
    expect(grants(USER_INVOKER.capabilities, "command:invoke:anything.at.all")).toBe(true);
  });
});
