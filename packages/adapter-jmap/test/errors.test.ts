import { describe, expect, it } from "vitest";
import { mapHttpError, mapJmapError } from "../src/errors.js";
import { buildPatch, escapePointer, keysOf, toMailboxRole } from "../src/mapping.js";

/**
 * The error mapping gets its own suite because it is the part of this adapter
 * with the least visible consequences and the most expensive ones. A wrong kind
 * here does not fail a test somewhere else — it strands a user's change, or
 * hammers a server that will never accept it, months later.
 */
describe("JMAP error mapping", () => {
  it("makes a state mismatch a conflict, so the engine resynchronises", () => {
    // The single most consequential mapping in the file. `permanent` here means
    // an account silently stops syncing and never recovers.
    expect(mapJmapError({ type: "stateMismatch" })).toMatchObject({
      kind: "conflict",
      code: "sync.state_mismatch",
    });
  });

  it("treats an uncomputable change set as an expired cursor", () => {
    for (const type of ["cannotCalculateChanges", "tooManyChanges"]) {
      expect(mapJmapError({ type })).toMatchObject({
        kind: "conflict",
        code: "sync.cursor_invalid",
      });
    }
  });

  it("routes credential problems to the user, not to a retry loop", () => {
    expect(mapJmapError({ type: "unauthorized" }).kind).toBe("auth");
    expect(mapJmapError({ type: "forbidden" }).kind).toBe("auth");
    expect(mapJmapError({ type: "accountReadOnly" }).kind).toBe("auth");
  });

  it("marks server trouble transient", () => {
    for (const type of ["rateLimit", "serverFail", "serverPartialFail", "serverUnexpected"]) {
      expect(`${type}:${mapJmapError({ type }).kind}`).toBe(`${type}:transient`);
    }
  });

  it("gives a rate limit something to wait for", () => {
    expect(mapJmapError({ type: "rateLimit" }).retryAfterMs).toBeGreaterThan(0);
  });

  it("marks a malformed request permanent, so it is not retried for ever", () => {
    for (const type of ["invalidArguments", "invalidPatch", "tooLarge", "overQuota", "notFound"]) {
      expect(`${type}:${mapJmapError({ type }).kind}`).toBe(`${type}:permanent`);
    }
  });

  it("treats an unrecognised type as transient, never permanent", () => {
    // A server extension or a newer spec. Retrying is recoverable; discarding
    // the user's change is not.
    const error = mapJmapError({ type: "somethingNobodyHasWrittenYet" });
    expect(error.kind).toBe("transient");
    expect(error.message).toContain("unrecognised");
  });

  it("keeps the JMAP type in context, and no message content", () => {
    const error = mapJmapError({ type: "overQuota", description: "mailbox full" });
    expect(error.context).toMatchObject({ jmapType: "overQuota" });
    // Errors are logged and shipped to plugins and agents.
    expect(JSON.stringify(error.toJSON())).not.toContain("Subject");
  });
});

describe("HTTP error mapping", () => {
  it("separates unauthenticated from forbidden", () => {
    expect(mapHttpError(401, "").code).toBe("auth.unauthenticated");
    expect(mapHttpError(403, "").code).toBe("auth.forbidden");
  });

  it("honours Retry-After on a 429", () => {
    expect(mapHttpError(429, "", "12").retryAfterMs).toBe(12_000);
    expect(mapHttpError(429, "", null).retryAfterMs).toBeGreaterThan(0);
  });

  it("treats 5xx as transient and other 4xx as permanent", () => {
    expect(mapHttpError(503, "").kind).toBe("transient");
    expect(mapHttpError(400, "bad").kind).toBe("permanent");
  });
});

describe("shape mapping", () => {
  it("maps known roles and refuses to guess unknown ones", () => {
    expect(toMailboxRole("inbox")).toBe("inbox");
    expect(toMailboxRole("Trash")).toBe("trash");
    // Real JMAP roles with no equivalent here. `none` keeps them as ordinary
    // mailboxes rather than pretending they are something they are not.
    expect(toMailboxRole("flagged")).toBe("none");
    expect(toMailboxRole(null)).toBe("none");
  });

  it("reads a JMAP set map as a sorted list of present keys", () => {
    expect(keysOf({ $seen: true, $flagged: true })).toEqual(["$flagged", "$seen"]);
    // A key set to anything but true is not present.
    expect(keysOf({ $seen: false })).toEqual([]);
    expect(keysOf(undefined)).toEqual([]);
  });

  it("escapes JSON Pointer characters in a keyword", () => {
    // A user keyword containing `/` would otherwise patch a path that does not
    // exist, silently.
    expect(escapePointer("project/alpha")).toBe("project~1alpha");
    expect(escapePointer("a~b")).toBe("a~0b");
  });

  it("builds an add/remove patch rather than a whole-object update", () => {
    // A whole-object update sends a set we may have read stale, wiping a
    // keyword another client added in between.
    expect(buildPatch("keywords", ["$seen"], ["$flagged"])).toEqual({
      "keywords/$seen": true,
      "keywords/$flagged": null,
    });
  });

  it("lets a later add win over an earlier remove of the same value", () => {
    expect(buildPatch("mailboxIds", ["mb1"], ["mb1"])).toEqual({ "mailboxIds/mb1": true });
  });
});
