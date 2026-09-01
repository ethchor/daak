import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CORPUS_DIR,
  EXPECTED_DIR,
  type FixtureCategory,
  fixtureIds,
  loadAll,
  loadFixture,
  loadManifest,
  makeLargeMessage,
} from "../src/index.js";

/**
 * These tests guard the corpus itself, not any parser.
 *
 * A corpus that silently loses a fixture, or whose bytes get reformatted by an
 * editor, stops being a regression suite without anything going red. So the
 * bytes are checked against recorded sizes and the pairing is checked both ways.
 */
describe("corpus integrity", () => {
  const ids = fixtureIds();

  it("has fixtures", () => {
    expect(ids.length).toBeGreaterThan(0);
  });

  it("pairs every message with an expectation, in both directions", () => {
    const expectedIds = readdirSync(EXPECTED_DIR)
      .filter((n) => n.endsWith(".json"))
      .map((n) => n.slice(0, -".json".length))
      .sort();
    expect(expectedIds).toEqual([...ids]);
  });

  it("keeps the manifest in step with the directory", () => {
    expect(loadManifest().fixtures).toEqual([...ids]);
  });

  it("records the exact byte length of every message", () => {
    // The tripwire for an editor stripping trailing whitespace or rewriting
    // line endings on a file it had no business touching.
    for (const id of ids) {
      const onDisk = statSync(join(CORPUS_DIR, `${id}.eml`)).size;
      expect(`${id}:${loadFixture(id).expected.size}`).toBe(`${id}:${onDisk}`);
    }
  });

  it("gives every fixture a description saying why it is in the corpus", () => {
    for (const fixture of loadAll()) {
      expect(fixture.expected.description.length).toBeGreaterThan(20);
      expect(fixture.expected.categories.length).toBeGreaterThan(0);
    }
  });

  it("has a header/body separator in every message", () => {
    for (const fixture of loadAll()) {
      const text = Buffer.from(fixture.raw).toString("latin1");
      expect(text.includes("\r\n\r\n") || text.includes("\n\n")).toBe(true);
    }
  });

  it("preserves the line endings each fixture was written with", () => {
    const lf = Buffer.from(loadFixture("bare-lf-endings").raw).toString("latin1");
    expect(lf.includes("\r\n")).toBe(false);

    const crlf = Buffer.from(loadFixture("simple-plaintext").raw).toString("latin1");
    expect(crlf.includes("\r\n")).toBe(true);
  });
});

describe("corpus coverage", () => {
  /**
   * The categories the build plan calls out. A gap here is a class of real
   * message we have no regression test for — the list is allowed to grow,
   * never to shrink.
   */
  const REQUIRED: FixtureCategory[] = [
    "multipart",
    "nested",
    "attachment",
    "inline-image",
    "base64",
    "quoted-printable",
    "8bit",
    "charset",
    "rfc2047",
    "headers",
    "folding",
    "threading",
    "calendar",
    "smime",
    "malformed",
    "dates",
    "byte-preservation",
  ];

  it("covers every required category", () => {
    const present = new Set(loadAll().flatMap((f) => f.expected.categories));
    expect(REQUIRED.filter((c) => !present.has(c))).toEqual([]);
  });

  it("includes messages that must not throw, only degrade", () => {
    const recovery = loadAll().filter((f) => f.expected.categories.includes("malformed"));
    expect(recovery.length).toBeGreaterThanOrEqual(3);
  });
});

describe("generated large messages", () => {
  it("builds a large message without committing one to git", () => {
    const message = makeLargeMessage(1_000_000);
    expect(message.byteLength).toBeGreaterThan(1_000_000);
    const text = Buffer.from(message).toString("latin1");
    expect(text.startsWith("Message-ID:")).toBe(true);
    expect(text.trimEnd().endsWith("--large_fixture_boundary--")).toBe(true);
  });
});

describe("expectations are honest about what they assert", () => {
  it("never claims an attachment a fixture does not describe", () => {
    for (const fixture of loadAll()) {
      const { attachments, hasAttachment } = fixture.expected;
      expect(`${fixture.id}:${hasAttachment}`).toBe(`${fixture.id}:${attachments.length > 0}`);
    }
  });

  it("lists a container content type before its children", () => {
    for (const fixture of loadAll()) {
      const first = fixture.expected.structure[0];
      if (first?.startsWith("multipart/")) {
        expect(fixture.expected.structure.length).toBeGreaterThan(1);
      }
    }
  });

  it("keeps every fixture small enough to read in a review", () => {
    for (const id of fixtureIds()) {
      const bytes = readFileSync(join(CORPUS_DIR, `${id}.eml`)).byteLength;
      expect(`${id}:${bytes < 64 * 1024}`).toBe(`${id}:true`);
    }
  });
});
