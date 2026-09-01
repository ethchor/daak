import { describe, expect, it } from "vitest";
import {
  decodeHeader,
  parseAddressHeader,
  parseDate,
  parseListId,
  parseMessageIds,
} from "../src/index.js";
import type { ParseWarning } from "../src/types.js";

describe("message ids", () => {
  it("strips angle brackets so threading compares like with like", () => {
    expect(parseMessageIds("<abc@example.org>")).toEqual(["abc@example.org"]);
  });

  it("splits a References chain", () => {
    expect(parseMessageIds("<a@x> <b@x>\r\n <c@x>")).toEqual(["a@x", "b@x", "c@x"]);
  });

  it("accepts an unbracketed id rather than discarding it", () => {
    // Malformed, and emitted by whole mail clients. Dropping it breaks
    // threading for everyone using them.
    expect(parseMessageIds("abc@example.org")).toEqual(["abc@example.org"]);
  });

  it("returns nothing for an absent or empty header", () => {
    expect(parseMessageIds(undefined)).toEqual([]);
    expect(parseMessageIds("   ")).toEqual([]);
    expect(parseMessageIds("<>")).toEqual([]);
  });
});

describe("list id", () => {
  it("takes what is inside the brackets, not the whole header", () => {
    // Storing the whole value makes every list look distinct from itself.
    expect(parseListId("Developer discussion <devs.lists.example.org>")).toBe(
      "devs.lists.example.org",
    );
  });

  it("falls back to the raw value when there are no brackets", () => {
    expect(parseListId("devs.lists.example.org")).toBe("devs.lists.example.org");
  });

  it("is undefined when absent", () => {
    expect(parseListId(undefined)).toBeUndefined();
    expect(parseListId("  ")).toBeUndefined();
  });
});

describe("dates", () => {
  const warn = (): ParseWarning[] => [];

  it("normalises a valid date to UTC", () => {
    expect(parseDate("Tue, 4 Aug 2026 11:02:00 +0530", warn())).toBe("2026-08-04T05:32:00.000Z");
  });

  it("returns undefined for nonsense, and never substitutes now", () => {
    // A message silently stamped with the current time jumps to the top of the
    // mailbox and looks correct. Absent is honest and sorts predictably.
    const warnings = warn();
    expect(parseDate("Fri, 32 Aug 2026 25:99:00 +9900", warnings)).toBeUndefined();
    expect(warnings.map((w) => w.code)).toEqual(["date.unparseable"]);
  });

  it("rejects a date outside any plausible range", () => {
    const warnings = warn();
    expect(parseDate("Mon, 1 Jan 1900 00:00:00 +0000", warnings)).toBeUndefined();
    expect(parseDate("Mon, 1 Jan 2200 00:00:00 +0000", warnings)).toBeUndefined();
    expect(warnings).toHaveLength(2);
  });

  it("records a missing header distinctly from an unparseable one", () => {
    const warnings = warn();
    expect(parseDate(undefined, warnings)).toBeUndefined();
    expect(warnings.map((w) => w.code)).toEqual(["date.missing"]);
  });
});

describe("addresses", () => {
  it("flattens a group into its members", () => {
    // A reply-all that quietly drops two recipients is unforgivable.
    expect(
      parseAddressHeader("Team: alice@example.org, bob@example.org;, carol@example.org"),
    ).toEqual([
      { name: "", address: "alice@example.org" },
      { name: "", address: "bob@example.org" },
      { name: "", address: "carol@example.org" },
    ]);
  });

  it("yields no recipients for an empty group", () => {
    expect(parseAddressHeader("undisclosed-recipients:;")).toEqual([]);
  });

  it("keeps a display name containing a comma", () => {
    expect(parseAddressHeader('"Rao, Priya" <priya@example.org>')).toEqual([
      { name: "Rao, Priya", address: "priya@example.org" },
    ]);
  });

  it("accepts an address no RFC would bless rather than refusing to show it", () => {
    const parsed = parseAddressHeader("not an email");
    expect(parsed).toHaveLength(1);
  });

  it("returns nothing for an absent header", () => {
    expect(parseAddressHeader(undefined)).toEqual([]);
  });
});

describe("encoded words", () => {
  it("decodes a Q-encoded latin-1 word, underscore as space", () => {
    expect(decodeHeader("=?ISO-8859-1?Q?Fran=E7ois_M=FCller?=")).toBe("François Müller");
  });

  it("decodes a B-encoded UTF-8 word", () => {
    expect(decodeHeader("=?utf-8?B?4KSF4KSo4KSC4KSk?=")).toBe("अनंत");
  });

  it("leaves plain text alone", () => {
    expect(decodeHeader("Quarterly numbers")).toBe("Quarterly numbers");
  });
});
