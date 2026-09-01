import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { FixtureCategory, FixtureExpectation } from "./schema.js";
import { FixtureExpectationSchema, ManifestSchema } from "./schema.js";

export * from "./schema.js";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
export const CORPUS_DIR = join(packageRoot, "corpus");
export const EXPECTED_DIR = join(packageRoot, "expected");

export interface Fixture {
  readonly id: string;
  readonly path: string;
  /** The message, byte for byte as it is stored. Never decoded here. */
  readonly raw: Uint8Array;
  readonly expected: FixtureExpectation;
}

let cachedIds: readonly string[] | undefined;

/** Every fixture id, sorted. Reads the directory, not the manifest. */
export const fixtureIds = (): readonly string[] => {
  cachedIds ??= readdirSync(CORPUS_DIR)
    .filter((name) => name.endsWith(".eml"))
    .map((name) => name.slice(0, -".eml".length))
    .sort();
  return cachedIds;
};

export const loadFixture = (id: string): Fixture => {
  const path = join(CORPUS_DIR, `${id}.eml`);
  const raw = new Uint8Array(readFileSync(path));
  const expected = FixtureExpectationSchema.parse(
    JSON.parse(readFileSync(join(EXPECTED_DIR, `${id}.json`), "utf8")),
  );
  return { id, path, raw, expected };
};

export const loadAll = (): readonly Fixture[] => fixtureIds().map(loadFixture);

export const byCategory = (category: FixtureCategory): readonly Fixture[] =>
  loadAll().filter((f) => f.expected.categories.includes(category));

export const loadManifest = () =>
  ManifestSchema.parse(JSON.parse(readFileSync(join(CORPUS_DIR, "MANIFEST.json"), "utf8")));

/**
 * Large messages are GENERATED, not committed.
 *
 * A 50MB attachment is a real case that must be tested and an unforgivable
 * thing to put in git history. Build it here instead; the shape is what
 * matters, not the specific bytes.
 */
export const makeLargeMessage = (attachmentBytes: number): Uint8Array => {
  const boundary = "large_fixture_boundary";
  const header = [
    "Message-ID: <generated-large@example.org>",
    "Date: Mon, 3 Aug 2026 09:14:22 +0000",
    "From: Bulk <bulk@example.org>",
    "To: you@example.net",
    "Subject: Generated large attachment",
    "MIME-Version: 1.0",
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    "",
    `--${boundary}`,
    "Content-Type: text/plain; charset=us-ascii",
    "",
    "Large attachment follows.",
    "",
    `--${boundary}`,
    'Content-Type: application/octet-stream; name="large.bin"',
    'Content-Disposition: attachment; filename="large.bin"',
    "Content-Transfer-Encoding: base64",
    "",
    "",
  ].join("\r\n");
  const footer = `\r\n--${boundary}--\r\n`;

  // Deterministic filler: one base64 line repeated. Cheap to build, and
  // compresses to nothing if it ever does end up on disk.
  const line = "QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVphYmNkZWZnaGlqa2xtbm9wcXJz\r\n";
  const lines = Math.max(1, Math.ceil((attachmentBytes * 4) / 3 / 60));
  return new TextEncoder().encode(header + line.repeat(lines) + footer);
};
