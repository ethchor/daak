/**
 * Grow the corpus from a public mailing-list archive.
 *
 *   node packages/fixtures/tools/import-mbox.ts <file.mbox> <id-prefix> [limit]
 *
 * Writes each message to `corpus/<prefix>-NNN.eml` byte-for-byte, plus a STUB
 * expectation next to it. The stub is deliberately incomplete: someone has to
 * open the message, decide what it is actually testing, and fill in the
 * assertions. An auto-generated expectation asserts whatever the parser did on
 * import day, which is worse than no test at all.
 *
 * Only import from archives that are public and licensed for redistribution,
 * and scrub anything that identifies a private individual before committing.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

const [, , mboxPath, prefix, limitArg] = process.argv;
if (!mboxPath || !prefix) {
  console.error("usage: import-mbox.ts <file.mbox> <id-prefix> [limit]");
  process.exit(2);
}
const limit = limitArg ? Number.parseInt(limitArg, 10) : 50;

/**
 * mbox splitting, the only way that works: a `From ` line at the start of a
 * line, following a blank line. Splitting on "From " anywhere eats message
 * bodies that happen to quote one.
 */
const splitMbox = (raw: Buffer): Buffer[] => {
  const text = raw.toString("latin1");
  const starts: number[] = [];
  for (let i = 0; i < text.length; i++) {
    const atLineStart = i === 0 || text[i - 1] === "\n";
    if (atLineStart && text.startsWith("From ", i)) starts.push(i);
  }
  return starts.map((start, index) =>
    raw.subarray(start, index + 1 < starts.length ? starts[index + 1] : raw.length),
  );
};

/** Undo mboxo/mboxrd escaping so the bytes match what the server held. */
const unescapeFromLines = (message: Buffer): Buffer =>
  Buffer.from(
    message
      .toString("latin1")
      .replace(/^From [^\n]*\n/, "")
      .replace(/^>(>*From )/gm, "$1"),
    "latin1",
  );

const headerValue = (text: string, name: string): string => {
  const match = new RegExp(`^${name}:[ \\t]*([^\\n]*(?:\\n[ \\t][^\\n]*)*)`, "im").exec(text);
  return match?.[1]?.replace(/\r?\n[ \t]+/g, " ").trim() ?? "";
};

const raw = readFileSync(mboxPath);
const messages = splitMbox(raw).slice(0, limit);

mkdirSync(join(packageRoot, "corpus"), { recursive: true });
mkdirSync(join(packageRoot, "expected"), { recursive: true });

messages.forEach((message, index) => {
  const body = unescapeFromLines(message);
  const id = `${prefix}-${String(index + 1).padStart(3, "0")}`;
  const text = body.toString("latin1");

  writeFileSync(join(packageRoot, "corpus", `${id}.eml`), body);
  writeFileSync(
    join(packageRoot, "expected", `${id}.json`),
    `${JSON.stringify(
      {
        id,
        description:
          "TODO: say what this message tests. Delete the fixture if the answer is nothing.",
        categories: ["baseline"],
        source: "public-archive",
        sourceUrl: "TODO",
        size: body.byteLength,
        headers: {
          subject: "TODO",
          messageId: [headerValue(text, "Message-ID").replace(/^<|>$/g, "")],
        },
        structure: ["TODO"],
        attachments: [],
        hasAttachment: false,
        notes: "STUB — assertions not yet filled in. Do not commit in this state.",
      },
      null,
      2,
    )}\n`,
  );
});

console.log(`wrote ${messages.length} fixtures with stub expectations`);
console.log("Now open each one, fill in the assertions, and delete the ones that test nothing.");
