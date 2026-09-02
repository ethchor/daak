/**
 * What a mailbox looks like, as numbers.
 *
 * The point of this file is that 500k copies of one message is not a 500k
 * mailbox. An index built over one repeated body is tiny, every term is either
 * ubiquitous or absent, and bm25 has nothing to discriminate on — so every
 * measurement taken against it flatters the code. The distributions below are
 * what stop that: a real vocabulary with a long tail, threads of uneven depth,
 * a handful of correspondents you hear from constantly and hundreds you do not.
 *
 * None of these numbers are measured from a real mailbox, because we do not
 * have one to measure. They are plausible rather than authoritative, and they
 * are in one place so that a better source replaces them in one edit rather
 * than thirty.
 */

/** A mailbox in the seeded account, and the share of mail that lands in it. */
export interface SeedMailbox {
  readonly name: string;
  readonly role:
    | "inbox"
    | "archive"
    | "sent"
    | "drafts"
    | "trash"
    | "junk"
    | "all"
    | "snoozed"
    | "none";
  /** Relative weight, not a probability — the generator normalises. */
  readonly weight: number;
}

export interface Population {
  readonly messages: number;
  /** Same seed, same bytes. Changing it changes every generated message. */
  readonly seed: number;
  /** Share of messages that continue an existing thread rather than start one. */
  readonly replyRate: number;
  readonly attachmentRate: number;
  /**
   * Typical attachment size.
   *
   * Deliberately far below life. Real mail averages tens of kilobytes and a
   * 500k mailbox is tens of gigabytes; generating that takes hours and fills a
   * disk, so the default trades attachment *bytes* — which only the blob store
   * cares about — for message *count*, which is what the index, the threader
   * and every query scale against. Raise it when blob I/O is the thing under
   * test, and do not read a search number as if the bodies were life-sized.
   */
  readonly attachmentBytes: number;
  /** Share carrying `List-Id`. Mailing list mail behaves differently enough to matter. */
  readonly listRate: number;
  readonly unreadRate: number;
  readonly flaggedRate: number;
  /** Share whose body is HTML rather than plain text. */
  readonly htmlRate: number;
  /** Share in a non-ASCII charset, encoded words in the subject included. */
  readonly nonAsciiRate: number;
  /** Distinct correspondents. Contact frequency follows a Zipf-like curve. */
  readonly people: number;
  /** How far back the mailbox reaches. Density rises towards `endsAt`. */
  readonly spanDays: number;
  /**
   * The most recent message's arrival time.
   *
   * Fixed rather than `Date.now()`, and that is not fussiness. Anchoring to the
   * clock makes the corpus different on every run, which quietly destroys the
   * one property the seeder exists to provide: that a number measured today
   * and a number measured next month are measuring the same mailbox. Anything
   * that wants "recent" — the search ranking's recency boost, for one — takes
   * its reference time as a parameter, so it can be handed this instead.
   */
  readonly endsAt: string;
  readonly mailboxes: readonly SeedMailbox[];
}

export const DEFAULT_MAILBOXES: readonly SeedMailbox[] = [
  { name: "Inbox", role: "inbox", weight: 40 },
  { name: "Archive", role: "archive", weight: 42 },
  { name: "Sent", role: "sent", weight: 12 },
  { name: "Junk", role: "junk", weight: 4 },
  { name: "Trash", role: "trash", weight: 2 },
];

const BASE = {
  seed: 1,
  replyRate: 0.55,
  attachmentRate: 0.14,
  attachmentBytes: 3_072,
  endsAt: "2026-09-01T12:00:00.000Z",
  listRate: 0.18,
  unreadRate: 0.07,
  flaggedRate: 0.03,
  htmlRate: 0.62,
  nonAsciiRate: 0.09,
  mailboxes: DEFAULT_MAILBOXES,
} as const;

/**
 * The three sizes the plan names, and what each is for.
 *
 * `people` and `spanDays` grow sublinearly with size, because a mailbox ten
 * times larger is usually ten years of the same few hundred correspondents
 * rather than ten times as many of them.
 */
export const SIZES = {
  "1k": { ...BASE, messages: 1_000, people: 60, spanDays: 240 },
  "50k": { ...BASE, messages: 50_000, people: 400, spanDays: 1_800 },
  "500k": { ...BASE, messages: 500_000, people: 1_200, spanDays: 5_400 },
} as const satisfies Record<string, Population>;

export type SizeName = keyof typeof SIZES;

export const isSizeName = (value: string): value is SizeName => value in SIZES;
