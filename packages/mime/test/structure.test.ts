import { loadFixture } from "@daak/fixtures";
import { describe, expect, it } from "vitest";
import { parseMessage } from "../src/parse.js";
import { flattenStructure, parseContentType, scanStructure } from "../src/structure.js";

const encode = (text: string) => new TextEncoder().encode(text);

describe("content-type parsing", () => {
  it("defaults to text/plain when the header is absent", () => {
    expect(parseContentType(undefined)).toEqual({ contentType: "text/plain", parameters: {} });
    expect(parseContentType("")).toEqual({ contentType: "text/plain", parameters: {} });
  });

  it("lowercases the type and keeps parameters", () => {
    expect(parseContentType("TEXT/HTML; charset=UTF-8")).toEqual({
      contentType: "text/html",
      parameters: { charset: "UTF-8" },
    });
  });

  it("survives a quoted boundary containing a semicolon", () => {
    // Rare and legal, and it defeats a naive split(';').
    const result = parseContentType('multipart/mixed; boundary="a;b;c"');
    expect(result.parameters["boundary"]).toBe("a;b;c");
  });
});

describe("structure scanning", () => {
  it("reports containers before their children, depth first", async () => {
    const parsed = await parseMessage(loadFixture("multipart-related-inline-image").raw);
    expect(parsed.structure).toEqual(["multipart/related", "text/html", "image/png"]);
  });

  it("does not descend into an attached message", async () => {
    const parsed = await parseMessage(loadFixture("nested-rfc822-forward").raw);
    // Descending would attribute the inner message's headers to this one, which
    // is how a forward corrupts threading.
    expect(parsed.structure).toEqual(["multipart/mixed", "text/plain", "message/rfc822"]);
    expect(parsed.envelope.messageIdHeader).toEqual(["fwd-outer@example.org"]);
  });

  it("keeps the last part when the closing boundary never arrives", async () => {
    const parsed = await parseMessage(loadFixture("broken-boundary").raw);
    expect(parsed.structure).toEqual(["multipart/mixed", "text/plain", "text/plain"]);
    expect(parsed.warnings.map((w) => w.code)).toContain("boundary.unclosed");
    // Truncating the run-on part would silently drop the attachment.
    expect(parsed.attachments.map((a) => a.displayName)).toEqual(["note.txt"]);
  });

  it("flags a multipart with no boundary rather than guessing", () => {
    const { root, warnings } = scanStructure(
      encode("Content-Type: multipart/mixed\r\n\r\nnothing to split on\r\n"),
    );
    expect(flattenStructure(root)).toEqual(["multipart/mixed"]);
    expect(warnings.map((w) => w.code)).toContain("boundary.missing");
  });

  it("stops at the depth limit instead of following a nesting bomb", () => {
    let payload = "Content-Type: text/plain\r\n\r\ndeep\r\n";
    for (let level = 0; level < 8; level++) {
      const boundary = `b${level}`;
      payload =
        `Content-Type: multipart/mixed; boundary="${boundary}"\r\n\r\n` +
        `--${boundary}\r\n${payload}\r\n--${boundary}--\r\n`;
    }
    const { warnings } = scanStructure(encode(payload), 3);
    expect(warnings.map((w) => w.code)).toContain("structure.depth-exceeded");
  });

  it("splits on a bare LF blank line as readily as CRLF", async () => {
    const parsed = await parseMessage(loadFixture("bare-lf-endings").raw);
    expect(parsed.structure).toEqual(["text/plain"]);
  });
});

describe("attachment classification", () => {
  it("does not put a paperclip on a newsletter with an inline logo", async () => {
    const parsed = await parseMessage(loadFixture("multipart-related-inline-image").raw);
    expect(parsed.hasAttachment).toBe(false);
    expect(parsed.attachments).toHaveLength(0);
    expect(parsed.inlineParts).toEqual([
      expect.objectContaining({ contentId: "logo.772@weekly.example", contentType: "image/png" }),
    ]);
  });

  it("treats a detached signature as protocol, not as a file", async () => {
    const parsed = await parseMessage(loadFixture("smime-signed").raw);
    expect(parsed.hasAttachment).toBe(false);
    expect(parsed.structure).toContain("application/pkcs7-signature");
  });

  it("treats an invite body as the message, not as an attachment", async () => {
    const parsed = await parseMessage(loadFixture("calendar-invite").raw);
    expect(parsed.hasAttachment).toBe(false);
    expect(parsed.structure).toContain("text/calendar");
  });

  it("keeps a genuine attachment, and names one the sender did not", async () => {
    const parsed = await parseMessage(loadFixture("attachment-no-filename").raw);
    expect(parsed.attachments).toHaveLength(1);
    expect(parsed.attachments[0]?.filename).toBeNull();
    // A blank row in the UI is not acceptable; the name must be stable.
    expect(parsed.attachments[0]?.displayName).toBe("attachment-1.bin");
  });

  it("decodes attachment bytes", async () => {
    const parsed = await parseMessage(loadFixture("attachment-no-filename").raw);
    expect(new TextDecoder().decode(parsed.attachments[0]?.content)).toBe("ABCDEFG");
  });
});

describe("parse failure", () => {
  it("throws only for input that is not a message at all", async () => {
    await expect(parseMessage(new Uint8Array(0))).rejects.toMatchObject({
      kind: "permanent",
      code: "mime.parse_failed",
    });
  });

  it("degrades rather than throwing on garbage that has a header shape", async () => {
    const parsed = await parseMessage(encode("Subject: ?\r\nContent-Type: nonsense/\r\n\r\n "));
    expect(parsed.envelope.subject).toBe("?");
    expect(parsed.warnings.length).toBeGreaterThan(0);
  });
});
