const QUOTED_LINE = /^\s*>/;
const HTML_TAG = /<[^>]*>/g;
const WHITESPACE = /\s+/g;

/**
 * The one-line summary shown in the message list.
 *
 * Quoted lines are dropped first: in a reply, the quoted text is the *previous*
 * message, and a list where every reply previews the same paragraph is useless.
 * Signature and forward markers end the preview for the same reason.
 */
const STOP_MARKERS = ["-- \n", "-- \r\n", "---------- Forwarded message"];

export const buildPreview = (
  text: string | undefined,
  html: string | undefined,
  limit = 512,
): string => {
  let source = text;
  if (source === undefined || source.trim() === "") {
    if (html === undefined) return "";
    source = html.replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ").replace(HTML_TAG, " ");
  }

  for (const marker of STOP_MARKERS) {
    const at = source.indexOf(marker);
    if (at > 0) source = source.slice(0, at);
  }

  const meaningful = source
    .split(/\r?\n/)
    .filter((line) => !QUOTED_LINE.test(line))
    .join(" ")
    .replace(WHITESPACE, " ")
    .trim();

  return meaningful.length > limit ? `${meaningful.slice(0, limit - 1).trimEnd()}…` : meaningful;
};
