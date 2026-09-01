/**
 * Reply and forward prefixes are kept apart on purpose.
 *
 * Both are stripped to get a thread's display subject. Only a *reply* prefix
 * licenses subject-based grouping (see `thread.ts`): "Re: Lunch" continues a
 * conversation, while "Fwd: Lunch" is usually the same text sent to a new
 * audience for a new reason. Treating a forward as a reply is how a client
 * silently staples an unrelated conversation onto yours.
 *
 * The token lists are finite by design. Matching "anything before a colon" eats
 * real subjects like "Bug: crash on open".
 */
const REPLY_TOKENS = ["re", "res", "aw", "antw", "sv", "vs", "ref", "odp", "r"];
const FORWARD_TOKENS = ["fwd", "fw", "wg", "tr", "rv", "enc", "vb", "i"];

// An optional bracketed counter covers the "Re[2]: subject" convention.
const build = (tokens: readonly string[]) =>
  new RegExp(`^\\s*(?:${tokens.join("|")})\\s*(?:\\[\\d+\\])?\\s*:\\s*`, "i");

const REPLY = build(REPLY_TOKENS);
const FORWARD = build(FORWARD_TOKENS);

export interface NormalisedSubject {
  /** Prefixes stripped, whitespace collapsed. The grouping key. */
  readonly base: string;
  /** A reply prefix was removed. The only thing that licenses subject grouping. */
  readonly wasReply: boolean;
  /** A forward prefix was removed. Stripped for display, never grouped on. */
  readonly wasForward: boolean;
}

/**
 * Strip reply and forward prefixes.
 *
 * Applied repeatedly, because "Re: Fwd: Re: numbers" is a real subject line and
 * one pass leaves two prefixes behind. Bounded rather than unbounded: a subject
 * made entirely of prefixes is input we were handed, not a reason to spin.
 */
export const normaliseSubject = (subject: string): NormalisedSubject => {
  let base = subject.replace(/\s+/g, " ").trim();
  let wasReply = false;
  let wasForward = false;

  for (let pass = 0; pass < 16; pass++) {
    const withoutReply = base.replace(REPLY, "");
    if (withoutReply !== base) {
      base = withoutReply.trim();
      wasReply = true;
      continue;
    }
    const withoutForward = base.replace(FORWARD, "");
    if (withoutForward !== base) {
      base = withoutForward.trim();
      wasForward = true;
      continue;
    }
    break;
  }

  return { base, wasReply, wasForward };
};
