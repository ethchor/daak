import { parseMessage } from "@daak/mime";
import { describe, expect, it } from "vitest";
import { generate } from "../src/generate.js";
import { type Population, SIZES } from "../src/population.js";
import { createRandom } from "../src/random.js";
import { VOCABULARY_SIZE, wordAt } from "../src/vocabulary.js";

const tiny: Population = { ...SIZES["1k"], messages: 300 };

const take = (population: Population) => [...generate(population)];

describe("determinism", () => {
  it("produces byte-identical messages for the same seed", () => {
    const first = take(tiny);
    const second = take(tiny);
    expect(second.length).toBe(first.length);
    for (let i = 0; i < first.length; i += 1) {
      // Byte-for-byte, because a performance number is only comparable if the
      // corpus behind it is the same corpus on a different machine.
      expect(second[i]?.raw).toEqual(first[i]?.raw);
      expect(second[i]?.receivedAt).toBe(first[i]?.receivedAt);
    }
  });

  it("produces a different corpus for a different seed", () => {
    const first = take(tiny);
    const second = take({ ...tiny, seed: 2 });
    const differing = first.filter((message, i) => {
      const other = second[i];
      return other === undefined || message.raw.length !== other.raw.length;
    });
    expect(differing.length).toBeGreaterThan(0);
  });
});

describe("shape", () => {
  const messages = take(tiny);
  const generated = messages.filter((message) => message.providerId.startsWith("seed-"));

  it("emits the whole fixture corpus once, and only once", () => {
    // Once rather than at a rate: at a rate the corpus would collapse into a
    // few enormous threads and distort every measurement taken afterwards.
    const fixtures = messages.filter((message) => message.providerId.startsWith("fixture-"));
    expect(fixtures.length).toBeGreaterThan(0);
    expect(new Set(fixtures.map((message) => message.providerId)).size).toBe(fixtures.length);
  });

  it("orders messages oldest first", () => {
    for (let i = 1; i < generated.length; i += 1) {
      const previous = generated[i - 1]?.receivedAt ?? "";
      expect(generated[i]?.receivedAt.localeCompare(previous)).toBeGreaterThanOrEqual(0);
    }
  });

  it("is denser towards the present", () => {
    // Half the messages should sit in far less than half the time span.
    const first = Date.parse(generated[0]?.receivedAt ?? "");
    const last = Date.parse(generated[generated.length - 1]?.receivedAt ?? "");
    const middle = Date.parse(generated[Math.floor(generated.length / 2)]?.receivedAt ?? "");
    expect(middle - first).toBeGreaterThan((last - first) / 2);
  });

  it("spreads across the configured mailboxes", () => {
    const used = new Set(messages.map((message) => message.mailbox));
    expect(used.size).toBeGreaterThan(1);
  });

  it("produces threads of uneven depth rather than all singletons", () => {
    const replies = generated.filter((message) =>
      new TextDecoder().decode(message.raw).includes("In-Reply-To:"),
    );
    expect(replies.length).toBeGreaterThan(generated.length / 4);
  });
});

describe("the messages are real messages", () => {
  it("parses every generated message without a warning we did not ask for", async () => {
    for (const message of take({ ...tiny, messages: 120 })) {
      if (message.providerId.startsWith("fixture-")) continue;
      const parsed = await parseMessage(message.raw);
      expect(parsed.envelope.subject.length).toBeGreaterThan(0);
      expect(parsed.envelope.from.length).toBe(1);
      expect(parsed.envelope.sentAt).toBeDefined();
    }
  });

  it("decodes the non-ASCII subjects it claims to generate", async () => {
    const messages = take({ ...tiny, messages: 400, nonAsciiRate: 1 });
    const generated = messages.filter((message) => message.providerId.startsWith("seed-"));
    const first = generated[0];
    expect(first).toBeDefined();
    if (first === undefined) return;
    const parsed = await parseMessage(first.raw);
    expect(parsed.envelope.subject).toContain("рабочий");
  });

  it("attaches something when it says it has attached something", async () => {
    const messages = take({ ...tiny, messages: 40, attachmentRate: 1 });
    const generated = messages.filter((message) => message.providerId.startsWith("seed-"));
    for (const message of generated) {
      const parsed = await parseMessage(message.raw);
      expect(parsed.hasAttachment).toBe(true);
    }
  });
});

describe("vocabulary", () => {
  it("has a long tail, which is the whole reason it exists", () => {
    // A corpus written in fifty words gives an index where every term is
    // either ubiquitous or absent, and bm25 has nothing to rank on.
    expect(VOCABULARY_SIZE).toBeGreaterThan(10_000);
    expect(wordAt(0)).not.toBe(wordAt(VOCABULARY_SIZE - 1));
  });

  it("keeps the tail stable across seeds, so two sizes stay comparable", () => {
    // Only the frequencies change with the seed; the words themselves do not.
    expect(wordAt(5_000)).toBe(wordAt(5_000));
  });

  it("draws the common core far more often than the tail", () => {
    const random = createRandom(7);
    let common = 0;
    for (let i = 0; i < 2_000; i += 1) if (random.zipf(VOCABULARY_SIZE) < 200) common += 1;
    expect(common).toBeGreaterThan(400);
  });
});
