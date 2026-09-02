import { type Cancellable, DaakError, ErrorCodes } from "@daak/contracts";
import { mapHttpError, mapJmapError } from "./errors.js";

/**
 * A thin JMAP client: request/response, session discovery, and nothing else.
 *
 * Hand-written rather than taken from a library because the parts that matter
 * here — state strings, batch sizes, and how a partial failure is reported —
 * are exactly the parts a client library would hide.
 *
 * `fetch` is injected. Not for elegance: it is the only way to test a protocol
 * adapter without a server, and this one has to be exercised against expired
 * cursors and partial batch failures long before a real Stalwart exists.
 */
export const CORE_CAPABILITY = "urn:ietf:params:jmap:core";
export const MAIL_CAPABILITY = "urn:ietf:params:jmap:mail";
export const SUBMISSION_CAPABILITY = "urn:ietf:params:jmap:submission";

export type MethodCall = readonly [string, Record<string, unknown>, string];
export type MethodResponse = readonly [string, Record<string, unknown>, string];

export interface JmapSession {
  readonly apiUrl: string;
  readonly downloadUrl: string;
  readonly uploadUrl: string;
  readonly accountId: string;
  readonly maxObjectsInGet: number;
  readonly maxObjectsInSet: number;
  readonly maxCallsInRequest: number;
  readonly maxSizeUpload: number;
  readonly supportsPush: boolean;
  readonly capabilities: readonly string[];
}

export interface JmapClientOptions {
  readonly sessionUrl: string;
  /**
   * Produces the `Authorization` header value.
   *
   * A function, not a string, because credentials live in the OS keychain and
   * may be refreshed between calls. Nothing here retains the value.
   */
  readonly authorization: () => string | Promise<string>;
  readonly fetch?: typeof globalThis.fetch;
  /** Override the account when the server's primary is not the one we want. */
  readonly jmapAccountId?: string;
}

export interface JmapClient {
  session(options?: Cancellable): Promise<JmapSession>;
  /** Run a batch of method calls. Throws on transport and method-level errors. */
  call(calls: readonly MethodCall[], options?: Cancellable): Promise<MethodResponse[]>;
  /** Fetch a blob's bytes, untouched. */
  download(blobId: string, options?: Cancellable): Promise<Uint8Array>;
  upload(bytes: Uint8Array, contentType: string, options?: Cancellable): Promise<string>;
}

const asRecord = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};

const asNumber = (value: unknown, fallback: number): number =>
  typeof value === "number" && Number.isFinite(value) ? value : fallback;

/** `{accountId}`-style templates, per RFC 8620 §6.2. */
const fillTemplate = (template: string, values: Record<string, string>): string =>
  template.replace(/\{(\w+)\}/g, (_match, key: string) => encodeURIComponent(values[key] ?? ""));

export const createJmapClient = (options: JmapClientOptions): JmapClient => {
  const doFetch = options.fetch ?? globalThis.fetch;
  let cached: JmapSession | undefined;

  const headers = async (extra: Record<string, string> = {}): Promise<Record<string, string>> => ({
    Authorization: await options.authorization(),
    Accept: "application/json",
    ...extra,
  });

  const send = async (
    url: string,
    init: RequestInit,
    options_?: Cancellable,
  ): Promise<Response> => {
    let response: Response;
    try {
      response = await doFetch(url, {
        ...init,
        ...(options_?.signal === undefined ? {} : { signal: options_.signal }),
      });
    } catch (error) {
      // A transport failure is always ambiguous for a write: the request may
      // have reached the server. Classifying it `transient` is what lets the
      // engine record the intent as `unknown` rather than rolling it back.
      throw DaakError.transient(ErrorCodes.NETWORK, "could not reach the JMAP server", {
        cause: error,
      });
    }
    if (!response.ok) {
      throw mapHttpError(
        response.status,
        await response.text(),
        response.headers.get("retry-after"),
      );
    }
    return response;
  };

  const session = async (options_?: Cancellable): Promise<JmapSession> => {
    if (cached !== undefined) return cached;

    const response = await send(
      options.sessionUrl,
      { method: "GET", headers: await headers() },
      options_,
    );
    const body = asRecord(await response.json());

    const core = asRecord(asRecord(body.capabilities)[CORE_CAPABILITY]);
    const primary = asRecord(body.primaryAccounts)[MAIL_CAPABILITY];
    const accountId = options.jmapAccountId ?? (typeof primary === "string" ? primary : undefined);

    if (accountId === undefined) {
      throw DaakError.permanent(
        ErrorCodes.UNSUPPORTED,
        "the JMAP session advertises no mail account",
      );
    }
    if (typeof body.apiUrl !== "string") {
      throw DaakError.permanent(ErrorCodes.UNSUPPORTED, "the JMAP session has no apiUrl");
    }

    cached = {
      apiUrl: body.apiUrl,
      downloadUrl: typeof body.downloadUrl === "string" ? body.downloadUrl : "",
      uploadUrl: typeof body.uploadUrl === "string" ? body.uploadUrl : "",
      accountId,
      // Defaults from RFC 8620 §2 where the server is silent. Chosen small: a
      // batch that is too large fails the whole request, one that is too small
      // only costs a round trip.
      maxObjectsInGet: asNumber(core.maxObjectsInGet, 500),
      maxObjectsInSet: asNumber(core.maxObjectsInSet, 500),
      maxCallsInRequest: asNumber(core.maxCallsInRequest, 16),
      maxSizeUpload: asNumber(core.maxSizeUpload, 50 * 1024 * 1024),
      supportsPush: typeof body.eventSourceUrl === "string" && body.eventSourceUrl !== "",
      capabilities: Object.keys(asRecord(body.capabilities)),
    };
    return cached;
  };

  return {
    session,

    async call(calls, options_) {
      const current = await session(options_);
      const using = [CORE_CAPABILITY, MAIL_CAPABILITY];
      if (current.capabilities.includes(SUBMISSION_CAPABILITY)) using.push(SUBMISSION_CAPABILITY);

      const response = await send(
        current.apiUrl,
        {
          method: "POST",
          headers: await headers({ "Content-Type": "application/json" }),
          body: JSON.stringify({ using, methodCalls: calls }),
        },
        options_,
      );

      const body = asRecord(await response.json());
      const responses = Array.isArray(body.methodResponses) ? body.methodResponses : [];

      const parsed: MethodResponse[] = [];
      for (const entry of responses) {
        if (!Array.isArray(entry) || entry.length < 3) continue;
        const [name, args, callId] = entry as [string, unknown, string];
        if (name === "error") {
          // A method-level error aborts the batch: later calls may have used
          // back-references to this one, so nothing after it can be trusted.
          throw mapJmapError(
            {
              type: String(asRecord(args).type ?? "unknown"),
              description: String(asRecord(args).description ?? ""),
            },
            { callId },
          );
        }
        parsed.push([name, asRecord(args), callId]);
      }
      return parsed;
    },

    async download(blobId, options_) {
      const current = await session(options_);
      const url = fillTemplate(current.downloadUrl, {
        accountId: current.accountId,
        blobId,
        type: "application/octet-stream",
        name: "message.eml",
      });
      const response = await send(
        url,
        { method: "GET", headers: await headers({ Accept: "*/*" }) },
        options_,
      );
      // Bytes, untouched. No text decoding anywhere on this path: the digest has
      // to match what the server holds, and a charset guess would change it.
      return new Uint8Array(await response.arrayBuffer());
    },

    async upload(bytes, contentType, options_) {
      const current = await session(options_);
      if (bytes.byteLength > current.maxSizeUpload) {
        throw DaakError.permanent(ErrorCodes.INVALID_INPUT, "upload exceeds the server's limit", {
          context: { size: bytes.byteLength, limit: current.maxSizeUpload },
        });
      }
      const url = fillTemplate(current.uploadUrl, { accountId: current.accountId });
      const response = await send(
        url,
        {
          method: "POST",
          headers: await headers({ "Content-Type": contentType }),
          // `BodyInit` is a DOM type this package does not pull in. The cast is
          // for the type only — a Uint8Array is a valid fetch body.
          body: bytes as unknown as NonNullable<RequestInit["body"]>,
        },
        options_,
      );
      const body = asRecord(await response.json());
      if (typeof body.blobId !== "string") {
        throw DaakError.permanent(ErrorCodes.UNSUPPORTED, "upload returned no blobId");
      }
      return body.blobId;
    },
  };
};

/** Pull one method response out of a batch by call id. */
export const responseFor = (
  responses: readonly MethodResponse[],
  callId: string,
): Record<string, unknown> => {
  const found = responses.find(([, , id]) => id === callId);
  if (found === undefined) {
    throw DaakError.transient(
      ErrorCodes.SERVER_ERROR,
      `JMAP returned no response for call ${callId}`,
    );
  }
  return found[1];
};
