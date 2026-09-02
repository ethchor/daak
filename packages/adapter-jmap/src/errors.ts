import { DaakError, ErrorCodes } from "@daak/contracts";

/**
 * JMAP errors, mapped onto the taxonomy.
 *
 * Every type in RFC 8620 §3.6.2 and §5.3 is listed explicitly. That is the point
 * — a `default:` that returns `permanent` strands the user's change silently,
 * and one that returns `transient` hammers a server that will never accept it.
 * An unrecognised type is genuinely unknown to us, so it is `transient`: the
 * engine will retry with backoff and the failure stays visible, which is the
 * lesser of the two mistakes.
 */
export type JmapErrorType = string;

export interface JmapProblem {
  readonly type: JmapErrorType;
  readonly description?: string;
  readonly status?: number;
}

/** Method-level and set-level errors share one vocabulary. */
export const mapJmapError = (problem: JmapProblem, context?: Record<string, string>): DaakError => {
  const detail = problem.description ?? problem.type;
  const extra = { context: { ...context, jmapType: problem.type } };

  switch (problem.type) {
    // ---- retry, the server is busy or briefly broken -----------------------
    case "rateLimit":
    case "urn:ietf:params:jmap:error:limit":
      return DaakError.transient(ErrorCodes.RATE_LIMITED, detail, {
        ...extra,
        retryAfterMs: 30_000,
      });
    case "serverFail":
    case "serverPartialFail":
    case "serverUnexpected":
      return DaakError.transient(ErrorCodes.SERVER_ERROR, detail, extra);

    // ---- reconcile, then retry ---------------------------------------------
    case "stateMismatch":
      // The single most consequential mapping in this file. Calling it
      // `permanent` means the engine never resynchronises and the account stops
      // syncing for good.
      return DaakError.conflict(ErrorCodes.STATE_MISMATCH, detail, extra);
    case "cannotCalculateChanges":
    case "tooManyChanges":
      // The server cannot describe the gap since our state string. Resynchronise
      // — which is what `conflict` + `cursor_invalid` tells the engine to do.
      return DaakError.conflict(ErrorCodes.CURSOR_INVALID, detail, extra);

    // ---- stop and involve the user ----------------------------------------
    case "unauthorized":
    case "urn:ietf:params:jmap:error:unauthorized":
      return DaakError.auth(ErrorCodes.UNAUTHENTICATED, detail, extra);
    case "forbidden":
    case "accountReadOnly":
    case "urn:ietf:params:jmap:error:forbidden":
      return DaakError.auth(ErrorCodes.FORBIDDEN, detail, extra);

    // ---- do not retry: the request itself is wrong -------------------------
    case "overQuota":
      return DaakError.permanent(ErrorCodes.QUOTA_EXCEEDED, detail, extra);
    case "notFound":
      return DaakError.permanent(ErrorCodes.NOT_FOUND, detail, extra);
    case "accountNotFound":
    case "accountNotSupportedByMethod":
    case "unknownMethod":
    case "unknownCapability":
    case "unsupportedFilter":
    case "unsupportedSort":
    case "singleton":
      return DaakError.permanent(ErrorCodes.UNSUPPORTED, detail, extra);
    case "invalidArguments":
    case "invalidPatch":
    case "invalidProperties":
    case "invalidResultReference":
    case "alreadyExists":
    case "willDestroy":
    case "tooLarge":
    case "requestTooLarge":
    case "urn:ietf:params:jmap:error:limit:maxSizeRequest":
      return DaakError.permanent(ErrorCodes.INVALID_INPUT, detail, extra);

    default:
      // Not in the spec we know, or a server extension. Retrying is recoverable;
      // discarding the user's change is not.
      return DaakError.transient(
        ErrorCodes.SERVER_ERROR,
        `unrecognised JMAP error: ${detail}`,
        extra,
      );
  }
};

/** HTTP failures, before any JMAP body has been parsed. */
export const mapHttpError = (
  status: number,
  body: string,
  retryAfter?: string | null,
): DaakError => {
  const detail = body.slice(0, 200);
  if (status === 401) {
    return DaakError.auth(ErrorCodes.UNAUTHENTICATED, "JMAP rejected the credentials", {
      context: { status },
    });
  }
  if (status === 403) {
    return DaakError.auth(ErrorCodes.FORBIDDEN, "JMAP refused the request", {
      context: { status },
    });
  }
  if (status === 404) {
    return DaakError.permanent(ErrorCodes.NOT_FOUND, "no such JMAP resource", {
      context: { status },
    });
  }
  if (status === 429) {
    const seconds = Number.parseInt(retryAfter ?? "", 10);
    return DaakError.transient(ErrorCodes.RATE_LIMITED, "JMAP rate limited the request", {
      context: { status },
      retryAfterMs: Number.isFinite(seconds) ? seconds * 1000 : 30_000,
    });
  }
  if (status >= 500) {
    return DaakError.transient(ErrorCodes.SERVER_ERROR, `JMAP server error ${status}`, {
      context: { status },
    });
  }
  return DaakError.permanent(ErrorCodes.INVALID_INPUT, `JMAP rejected the request: ${detail}`, {
    context: { status },
  });
};
