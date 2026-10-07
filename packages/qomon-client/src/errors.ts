/**
 * Qomon error taxonomy (risk R2, ticket B7). The documented contract is only
 * a bare `{"status":"fail"}`; the live sandbox actually returns RFC7807-style
 * bodies with real HTTP status codes. This maps both onto typed errors so
 * callers (and the backoff policy) can branch on kind, not on strings.
 */

export interface QomonErrorContext {
  method: string;
  path: string;
  attempt: number;
  httpStatus?: number;
  requestId?: string;
  body?: unknown;
}

export class QomonError extends Error {
  constructor(
    message: string,
    readonly context: QomonErrorContext,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = new.target.name;
  }

  /** Whether the backoff policy should retry this. */
  get retryable(): boolean {
    return false;
  }
}

/** 401 / 403: bad or expired key, or missing scope. Never retried. */
export class QomonAuthError extends QomonError {}

/** 404. Never retried. */
export class QomonNotFoundError extends QomonError {}

/** 400 / 422: the request was rejected on validation. Never retried. */
export class QomonValidationError extends QomonError {}

/** 429 or a heuristic rate-limit detection. Retryable, honouring retryAfterMs. */
export class QomonRateLimitError extends QomonError {
  constructor(
    message: string,
    context: QomonErrorContext,
    readonly retryAfterMs: number | null,
    options?: { cause?: unknown },
  ) {
    super(message, context, options);
  }
  override get retryable(): boolean {
    return true;
  }
}

/** 5xx. Retryable. */
export class QomonServerError extends QomonError {
  override get retryable(): boolean {
    return true;
  }
}

/** Network failure, DNS, timeout, connection reset. Retryable. */
export class QomonTransportError extends QomonError {
  override get retryable(): boolean {
    return true;
  }
}

/** The HTTP call succeeded but the body did not match the expected schema. */
export class QomonMalformedResponseError extends QomonError {}

export function classifyHttpError(
  httpStatus: number,
  context: QomonErrorContext,
  body: unknown,
): QomonError {
  const detail =
    (typeof body === 'object' &&
      body !== null &&
      'detail' in body &&
      typeof (body as { detail: unknown }).detail === 'string' &&
      (body as { detail: string }).detail) ||
    `HTTP ${httpStatus}`;
  const ctx = { ...context, httpStatus, body };

  if (httpStatus === 401 || httpStatus === 403) {
    return new QomonAuthError(`Qomon auth failed: ${detail}`, ctx);
  }
  if (httpStatus === 404) {
    return new QomonNotFoundError(`Qomon not found: ${detail}`, ctx);
  }
  if (httpStatus === 429) {
    return new QomonRateLimitError(`Qomon rate limited: ${detail}`, ctx, null);
  }
  if (httpStatus === 400 || httpStatus === 422) {
    return new QomonValidationError(`Qomon rejected the request: ${detail}`, ctx);
  }
  if (httpStatus >= 500) {
    return new QomonServerError(`Qomon server error: ${detail}`, ctx);
  }
  return new QomonError(`Qomon request failed: ${detail}`, ctx);
}
