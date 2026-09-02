import type { Instant } from "@daak/contracts";
import { fixtureIds, loadAll } from "@daak/fixtures";
import type { Population, SeedMailbox } from "./population.js";
import { createRandom, type Random } from "./random.js";
import { paragraph, sampleWord, subjectLine } from "./vocabulary.js";

export interface GeneratedMessage {
  /** Stable across runs with the same seed — it is what the store keys on. */
  readonly providerId: string;
  /** RFC 5322 bytes, exactly as they would arrive. */
  readonly raw: Uint8Array;
  readonly receivedAt: Instant;
  readonly mailbox: string;
  readonly keywords: readonly string[];
}

const encoder = new TextEncoder();

const DOMAIN = "seed.daak.test";
const OWNER = "you@daak.test";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** RFC 5322 §3.3. Always +0000: the generator has no business inventing zones. */
const rfc5322Date = (date: Date): string => {
  const day = DAYS[date.getUTCDay()] ?? "Mon";
  const month = MONTHS[date.getUTCMonth()] ?? "Jan";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${day}, ${date.getUTCDate()} ${month} ${date.getUTCFullYear()} ${pad(
    date.getUTCHours(),
  )}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())} +0000`;
};

interface Person {
  readonly name: string;
  readonly address: string;
}

const buildPeople = (count: number, random: Random): Person[] => {
  const people: Person[] = [];
  for (let i = 0; i < count; i += 1) {
    const first = sampleWord(random);
    const last = sampleWord(random);
    const name = `${first.charAt(0).toUpperCase()}${first.slice(1)} ${last
      .charAt(0)
      .toUpperCase()}${last.slice(1)}`;
    people.push({ name, address: `${first}.${last}${i}@${DOMAIN}` });
  }
  return people;
};

/** Weighted mailbox choice, resolved once into a lookup table. */
const buildMailboxPicker = (mailboxes: readonly SeedMailbox[]): ((random: Random) => string) => {
  const total = mailboxes.reduce((sum, mailbox) => sum + mailbox.weight, 0);
  return (random) => {
    let point = random.next() * total;
    for (const mailbox of mailboxes) {
      point -= mailbox.weight;
      if (point <= 0) return mailbox.name;
    }
    return mailboxes[0]?.name ?? "Inbox";
  };
};

interface OpenThread {
  readonly root: string;
  /** The `References` chain so far, oldest first. Bounded — see below. */
  references: string[];
  subject: string;
  depth: number;
}

/** Base64 filler for an attachment. Deterministic and cheap. */
const attachmentBody = (bytes: number): string => {
  const line = "QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVphYmNkZWZnaGlqa2xtbm9wcXJz";
  const lines = Math.max(1, Math.ceil((bytes * 4) / 3 / line.length));
  const out: string[] = [];
  for (let i = 0; i < lines; i += 1) out.push(line);
  return out.join("\r\n");
};

/**
 * A subject with an RFC 2047 encoded word in it.
 *
 * Real mail is full of these and they are where naive parsers fail, so a
 * seeded mailbox that contains none is not exercising the decoder at volume.
 */
const encodedSubject = (plain: string): string =>
  `=?UTF-8?B?${Buffer.from(plain, "utf8").toString("base64")}?=`;

const BOUNDARY = "daak_seed_boundary";

interface BodyParts {
  readonly headers: string[];
  readonly body: string;
}

const buildBody = (random: Random, population: Population, text: string): BodyParts => {
  const wantsAttachment = random.chance(population.attachmentRate);
  const wantsHtml = random.chance(population.htmlRate);

  if (!wantsAttachment && !wantsHtml) {
    return {
      headers: ["MIME-Version: 1.0", "Content-Type: text/plain; charset=utf-8"],
      body: text,
    };
  }

  const parts: string[] = [];
  parts.push(`--${BOUNDARY}`);
  parts.push("Content-Type: text/plain; charset=utf-8", "", text, "");

  if (wantsHtml) {
    parts.push(`--${BOUNDARY}`);
    parts.push(
      "Content-Type: text/html; charset=utf-8",
      "",
      `<html><body><p>${text.replace(/\n/g, "</p><p>")}</p></body></html>`,
      "",
    );
  }

  if (wantsAttachment) {
    parts.push(`--${BOUNDARY}`);
    parts.push(
      'Content-Type: application/pdf; name="report.pdf"',
      'Content-Disposition: attachment; filename="report.pdf"',
      "Content-Transfer-Encoding: base64",
      "",
      attachmentBody(population.attachmentBytes),
      "",
    );
  }

  parts.push(`--${BOUNDARY}--`);

  // multipart/mixed whenever anything is attached; alternative is only correct
  // when every part is the same content in a different form.
  const subtype = wantsAttachment ? "mixed" : "alternative";
  return {
    headers: ["MIME-Version: 1.0", `Content-Type: multipart/${subtype}; boundary="${BOUNDARY}"`],
    body: parts.join("\r\n"),
  };
};

/**
 * The fixture corpus, included once per seeded mailbox.
 *
 * Once, not at a rate. The plan asks that seeded mail draw its shapes from
 * `@daak/fixtures` so the same edge cases are exercised at volume — but at a
 * rate, 5% of 500k would be twenty-five thousand copies of twenty-two
 * messages, which would collapse into twenty-two enormous threads and distort
 * every threading and ranking measurement taken afterwards. Present once, they
 * are exercised without being able to skew a distribution.
 */
const fixtureMessages = (mailbox: string): GeneratedMessage[] => {
  const start = Date.UTC(2026, 0, 1);
  return loadAll().map((fixture, index) => ({
    providerId: `fixture-${fixture.id}`,
    raw: fixture.raw,
    receivedAt: new Date(start + index * 60_000).toISOString() as Instant,
    mailbox,
    keywords: ["$seen"],
  }));
};

/**
 * How many messages `generate` will yield in total.
 *
 * Not `population.messages`: the fixture corpus rides along on top of it, so
 * the count a progress bar wants is the sum.
 */
export const plannedTotal = (population: Population): number =>
  population.messages + fixtureIds().length;

/**
 * Generate a mailbox, one message at a time.
 *
 * A generator rather than an array: 500k messages will not fit in memory as
 * decoded strings, and the seeder only ever needs one at a time.
 *
 * Messages come out oldest first, with density rising towards the present —
 * which is both what a real mailbox looks like and what makes the paging in
 * `queryMessages` behave the way it will in production.
 */
export function* generate(population: Population): Generator<GeneratedMessage> {
  const random = createRandom(population.seed);
  const people = buildPeople(population.people, random);
  const pickMailbox = buildMailboxPicker(population.mailboxes);
  const inbox = population.mailboxes[0]?.name ?? "Inbox";

  yield* fixtureMessages(inbox);

  /**
   * Recent threads, oldest evicted.
   *
   * Bounded because a reply is overwhelmingly to something recent, and because
   * an unbounded pool would make the reply target uniform over the whole
   * mailbox — which would give a 500k mailbox 500k threads of depth two rather
   * than a few deep ones and a great many singletons.
   */
  const open: OpenThread[] = [];
  const OPEN_LIMIT = 512;

  const end = Date.parse(population.endsAt);
  const span = population.spanDays * 86_400_000;

  for (let i = 0; i < population.messages; i += 1) {
    const progress = population.messages <= 1 ? 1 : i / (population.messages - 1);
    // Squared, so the mailbox is denser near the present.
    const received = new Date(end - span * (1 - progress) ** 2);
    const receivedAt = received.toISOString() as Instant;

    const messageId = `<seed-${i}@${DOMAIN}>`;
    const sender = people[random.zipf(people.length)] ?? people[0];
    if (sender === undefined) throw new Error("a population needs at least one person");

    const replying = open.length > 0 && random.chance(population.replyRate);
    const thread = replying ? open[random.zipf(open.length)] : undefined;

    const subject =
      thread === undefined ? subjectLine(random) : `Re: ${thread.subject.replace(/^Re: /, "")}`;

    const headers: string[] = [
      `Message-ID: ${messageId}`,
      `Date: ${rfc5322Date(received)}`,
      `From: ${sender.name} <${sender.address}>`,
      `To: ${OWNER}`,
    ];

    if (random.chance(population.nonAsciiRate)) {
      // Replace the plain subject with an encoded word carrying real non-ASCII.
      headers.push(`Subject: ${encodedSubject(`${subject} — рабочий вопрос`)}`);
    } else {
      headers.push(`Subject: ${subject}`);
    }

    if (thread !== undefined) {
      const parent = thread.references[thread.references.length - 1] ?? thread.root;
      headers.push(`In-Reply-To: ${parent}`);
      headers.push(`References: ${thread.references.join(" ")}`);
    }

    if (random.chance(population.listRate)) {
      const list = sampleWord(random);
      headers.push(`List-Id: ${list} discussion <${list}.lists.${DOMAIN}>`);
      headers.push(`List-Unsubscribe: <mailto:unsubscribe@lists.${DOMAIN}>`);
    }

    const text = paragraph(random, 2 + random.int(6));
    const { headers: mimeHeaders, body } = buildBody(random, population, text);
    const raw = encoder.encode(`${[...headers, ...mimeHeaders].join("\r\n")}\r\n\r\n${body}\r\n`);

    const keywords: string[] = [];
    if (!random.chance(population.unreadRate)) keywords.push("$seen");
    if (random.chance(population.flaggedRate)) keywords.push("$flagged");

    yield {
      providerId: `seed-${i}`,
      raw,
      receivedAt,
      mailbox: thread === undefined ? pickMailbox(random) : inbox,
      keywords,
    };

    if (thread === undefined) {
      open.push({ root: messageId, references: [messageId], subject, depth: 1 });
      if (open.length > OPEN_LIMIT) open.shift();
    } else {
      thread.depth += 1;
      thread.references.push(messageId);
      // A `References` header is not allowed to grow without bound; real
      // clients trim the middle and keep the root, so we do too.
      if (thread.references.length > 12) {
        thread.references = [thread.references[0] ?? messageId, ...thread.references.slice(-8)];
      }
    }
  }
}
