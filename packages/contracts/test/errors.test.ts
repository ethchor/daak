import { describe, expect, it } from "vitest";
import {
  DaakError,
  ErrorCodes,
  fromSerialized,
  isDaakError,
  isRetryable,
  SerializedDaakErrorSchema,
  toDaakError,
} from "../src/errors.js";

describe("error taxonomy", () => {
  it("classifies with a kind that answers 'what should the caller do'", () => {
    expect(DaakError.transient(ErrorCodes.TIMEOUT, "timed out").kind).toBe("transient");
    expect(DaakError.permanent(ErrorCodes.NOT_FOUND, "gone").kind).toBe("permanent");
    expect(DaakError.auth(ErrorCodes.TOKEN_EXPIRED, "expired").kind).toBe("auth");
    expect(DaakError.conflict(ErrorCodes.STATE_MISMATCH, "moved").kind).toBe("conflict");
  });

  it("retries only transient and conflict", () => {
    expect(isRetryable(DaakError.transient(ErrorCodes.NETWORK, "x"))).toBe(true);
    expect(isRetryable(DaakError.conflict(ErrorCodes.STATE_MISMATCH, "x"))).toBe(true);
    expect(isRetryable(DaakError.permanent(ErrorCodes.INVALID_INPUT, "x"))).toBe(false);
    expect(isRetryable(DaakError.auth(ErrorCodes.FORBIDDEN, "x"))).toBe(false);
    expect(isRetryable(new Error("raw"))).toBe(false);
  });

  it("normalises unknown throws to permanent, so nobody hammers a server on a mystery", () => {
    expect(toDaakError(new Error("boom")).kind).toBe("permanent");
    expect(toDaakError("boom").kind).toBe("permanent");
    expect(toDaakError({ weird: true }).message).toBe("Unknown error");
  });

  it("treats an abort as transient", () => {
    const abort = new Error("aborted");
    abort.name = "AbortError";
    expect(toDaakError(abort).kind).toBe("transient");
  });

  it("passes a DaakError through unchanged", () => {
    const original = DaakError.auth(ErrorCodes.UNAUTHENTICATED, "no creds");
    expect(toDaakError(original)).toBe(original);
    expect(isDaakError(original)).toBe(true);
  });

  it("round-trips across a serialisation boundary", () => {
    const original = DaakError.transient(ErrorCodes.RATE_LIMITED, "slow down", {
      retryAfterMs: 5_000,
      context: { host: "mail.example.org", attempt: 3 },
    });
    const wire = SerializedDaakErrorSchema.parse(JSON.parse(JSON.stringify(original)));
    const revived = fromSerialized(wire);
    expect(revived.kind).toBe("transient");
    expect(revived.code).toBe(ErrorCodes.RATE_LIMITED);
    expect(revived.retryAfterMs).toBe(5_000);
    expect(revived.context).toEqual({ host: "mail.example.org", attempt: 3 });
  });

  it("omits absent optionals from the wire form rather than sending nulls", () => {
    const wire = DaakError.permanent(ErrorCodes.NOT_FOUND, "gone").toJSON();
    expect("retryAfterMs" in wire).toBe(false);
    expect("context" in wire).toBe(false);
  });

  it("keeps the original error as `cause` for debugging", () => {
    const cause = new Error("socket hang up");
    const wrapped = DaakError.transient(ErrorCodes.NETWORK, "unreachable", { cause });
    expect(wrapped.cause).toBe(cause);
  });
});
