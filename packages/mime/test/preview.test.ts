import { loadFixture } from "@daak/fixtures";
import { describe, expect, it } from "vitest";
import { buildPreview, parseMessage } from "../src/index.js";

describe("preview", () => {
  it("drops quoted lines", async () => {
    // In a reply the quoted text is the previous message. A list where every
    // reply previews the same paragraph tells the reader nothing.
    const parsed = await parseMessage(loadFixture("no-references-reply").raw);
    expect(parsed.preview).toBe("Agreed, nothing surprising.");
    expect(parsed.preview).not.toContain("quarterly numbers are in");
  });

  it("stops at a signature marker", () => {
    expect(buildPreview("The numbers are in.\n\n-- \nAsha\nHead of Everything", undefined)).toBe(
      "The numbers are in.",
    );
  });

  it("collapses whitespace to a single line", () => {
    expect(buildPreview("one\n\n\ttwo   three\r\nfour", undefined)).toBe("one two three four");
  });

  it("falls back to HTML when there is no text part", () => {
    expect(buildPreview(undefined, "<p>Hello <b>there</b></p>")).toBe("Hello there");
  });

  it("does not leak script or style content into the preview", () => {
    expect(buildPreview(undefined, "<style>p{color:red}</style><p>Body</p>")).toBe("Body");
  });

  it("truncates with an ellipsis and respects the limit", () => {
    const preview = buildPreview("x".repeat(900), undefined, 40);
    expect(preview).toHaveLength(40);
    expect(preview.endsWith("…")).toBe(true);
  });

  it("is empty, not undefined, for a message with no body", async () => {
    const parsed = await parseMessage(loadFixture("empty-body").raw);
    expect(parsed.preview).toBe("");
  });

  it("stays within the 512-character contract by default", async () => {
    const parsed = await parseMessage(loadFixture("absurd-header-count").raw);
    expect(parsed.preview.length).toBeLessThanOrEqual(512);
  });
});
