import { type Fixture, loadAll, loadFixture } from "@daak/fixtures";
import { describe, expect, it } from "vitest";
import { parseMessage } from "../src/parse.js";

/**
 * The corpus, run against the parser.
 *
 * This is the lane's done-criterion: every fixture parses, none throws, and the
 * expectations hold. When a fixture fails, the fixture is right — see
 * CLAUDE.md.
 */
const fixtures = loadAll();

describe("corpus", () => {
  it("has fixtures to run", () => {
    expect(fixtures.length).toBeGreaterThan(0);
  });

  it.each(fixtures.map((f) => [f.id, f] as const))(
    "parses %s without throwing",
    async (_id, fixture: Fixture) => {
      await expect(parseMessage(fixture.raw)).resolves.toBeDefined();
    },
  );

  it.each(fixtures.map((f) => [f.id, f] as const))(
    "meets the expectation for %s",
    async (_id, fixture: Fixture) => {
      const parsed = await parseMessage(fixture.raw);
      const expected = fixture.expected;
      const h = expected.headers;

      if (h.subject !== undefined) expect(parsed.envelope.subject).toBe(h.subject);

      for (const [field, want] of [
        ["from", h.from],
        ["to", h.to],
        ["cc", h.cc],
      ] as const) {
        if (want === undefined) continue;
        const got = parsed.envelope[field];
        expect(got).toHaveLength(want.length);
        want.forEach((wanted, index) => {
          const actual = got[index];
          expect(actual?.address).toBe(wanted.address);
          // A fixture that omits `name` is not asserting on it.
          if (wanted.name !== undefined) expect(actual?.name).toBe(wanted.name);
        });
      }

      if (h.messageId !== undefined) expect(parsed.envelope.messageIdHeader).toEqual(h.messageId);
      if (h.inReplyTo !== undefined) expect(parsed.envelope.inReplyTo).toEqual(h.inReplyTo);
      if (h.references !== undefined) expect(parsed.envelope.references).toEqual(h.references);
      if (h.listId !== undefined) expect(parsed.envelope.listId).toBe(h.listId);
      if (h.date !== undefined) expect(parsed.envelope.sentAt ?? null).toBe(h.date);

      expect(parsed.structure).toEqual(expected.structure);

      for (const needle of expected.text?.contains ?? []) {
        expect(parsed.text ?? "").toContain(needle);
      }
      if (expected.text?.equals !== undefined) {
        expect((parsed.text ?? "").trim()).toBe(expected.text.equals);
      }
      for (const needle of expected.html?.contains ?? []) {
        expect(parsed.html ?? "").toContain(needle);
      }

      expect(parsed.attachments.map((a) => a.contentType)).toEqual(
        expected.attachments.map((a) => a.contentType),
      );
      expected.attachments.forEach((wanted, index) => {
        if (wanted.filename !== undefined) {
          expect(parsed.attachments[index]?.filename).toBe(wanted.filename);
        }
      });
      expect(parsed.hasAttachment).toBe(expected.hasAttachment);

      for (const wanted of expected.inlineParts ?? []) {
        const found = parsed.inlineParts.find((p) => p.contentId === wanted.contentId);
        expect(found, `inline part ${wanted.contentId}`).toBeDefined();
        expect(found?.contentType).toBe(wanted.contentType);
      }
    },
  );
});

describe("byte preservation", () => {
  it("never mutates the input", async () => {
    for (const fixture of fixtures) {
      const before = Uint8Array.from(fixture.raw);
      await parseMessage(fixture.raw);
      expect(Array.from(fixture.raw)).toEqual(Array.from(before));
    }
  });

  it("reports the exact input size, whatever the line endings", async () => {
    for (const fixture of fixtures) {
      const parsed = await parseMessage(fixture.raw);
      expect(`${fixture.id}:${parsed.size}`).toBe(`${fixture.id}:${fixture.raw.byteLength}`);
    }
  });

  it("does not normalise LF-only messages to CRLF anywhere it can be observed", async () => {
    const fixture = loadFixture("bare-lf-endings");
    const parsed = await parseMessage(fixture.raw);
    expect(parsed.size).toBe(fixture.raw.byteLength);
    expect(parsed.text).toContain("Line one.");
    expect(parsed.text).toContain("Line two.");
  });
});
