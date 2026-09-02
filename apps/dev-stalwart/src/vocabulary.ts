import type { Random } from "./random.js";

/**
 * The words the generated corpus is written in.
 *
 * This exists because the full-text index is only as interesting as its
 * vocabulary. With one repeated body every term is either in every document or
 * in none, the index is a fraction of its real size, and bm25 has nothing to
 * rank on — so a search benchmark against it measures almost nothing. What is
 * needed is the shape real text has: a few hundred words carrying most of the
 * volume and a very long tail of terms appearing once or twice.
 *
 * So: a common core, plus a generated tail that is synthetic but pronounceable
 * and, more importantly, distributed the way a real tail is.
 */
const COMMON =
  `the of and to in a is that for it as was with be by on not he i this are or his from at which
but have an they one you had word all were we when your can said there use each she do how their if will up other about
out many then them these so some her would make like him into time has look two more write go see number no way could
people my than first been call who its now find long down day did get come made may part meeting call review notes draft
release invoice payment schedule client project quarter budget report update summary attached please thanks regards team
document version deadline proposal contract agreement customer account order shipping delivery support ticket issue bug fix
patch build deploy server database migration index query result error warning request response header message thread reply
forward attachment folder archive search filter rule agent plugin command mailbox provider sync local remote offline`
    .split(/\s+/)
    .filter((word) => word.length > 0);

const SYLLABLES = [
  "ba",
  "ca",
  "da",
  "fa",
  "ga",
  "ha",
  "ja",
  "ka",
  "la",
  "ma",
  "na",
  "pa",
  "ra",
  "sa",
  "ta",
  "va",
  "be",
  "ce",
  "de",
  "fe",
  "ge",
  "he",
  "je",
  "ke",
  "le",
  "me",
  "ne",
  "pe",
  "re",
  "se",
  "ti",
  "vi",
  "bo",
  "co",
  "do",
  "fo",
  "go",
  "ho",
  "jo",
  "ko",
  "lo",
  "mo",
  "no",
  "po",
  "ro",
  "so",
  "to",
  "vu",
];

/**
 * Deterministic pronounceable filler for the tail of the distribution.
 *
 * Derived from the index rather than the generator, so the tail is the same
 * set of words for every seed and only the *frequencies* change. That makes
 * two corpora of different sizes comparable: the vocabulary grows, it does not
 * turn over.
 */
const tailWord = (index: number): string => {
  let n = index + 1;
  let word = "";
  do {
    const syllable = SYLLABLES[n % SYLLABLES.length];
    word += syllable ?? "xa";
    n = Math.floor(n / SYLLABLES.length);
  } while (n > 0 && word.length < 9);
  return word;
};

/** Total distinct words available. The tail dwarfs the core, as it does in real mail. */
const TAIL_SIZE = 40_000;
export const VOCABULARY_SIZE = COMMON.length + TAIL_SIZE;

export const wordAt = (index: number): string =>
  index < COMMON.length ? (COMMON[index] ?? "the") : tailWord(index - COMMON.length);

/** One word, sampled so the common core carries most of the volume. */
export const sampleWord = (random: Random): string => wordAt(random.zipf(VOCABULARY_SIZE));

export const sentence = (random: Random, words: number): string => {
  const parts: string[] = [];
  for (let i = 0; i < words; i += 1) parts.push(sampleWord(random));
  const first = parts[0] ?? "the";
  parts[0] = first.charAt(0).toUpperCase() + first.slice(1);
  return `${parts.join(" ")}.`;
};

export const paragraph = (random: Random, sentences: number): string => {
  const parts: string[] = [];
  for (let i = 0; i < sentences; i += 1) parts.push(sentence(random, 6 + random.int(14)));
  return parts.join(" ");
};

/** A subject line. Short, and drawn from the common core far more often. */
export const subjectLine = (random: Random): string => {
  const words = 2 + random.int(5);
  const parts: string[] = [];
  for (let i = 0; i < words; i += 1) {
    // Subjects skew common: nobody titles a mail with a hapax legomenon.
    parts.push(wordAt(random.zipf(Math.min(VOCABULARY_SIZE, 600))));
  }
  const first = parts[0] ?? "the";
  parts[0] = first.charAt(0).toUpperCase() + first.slice(1);
  return parts.join(" ");
};
