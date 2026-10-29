/**
 * Exception hierarchy for vision provider errors.
 *
 * The split between retryable and not is the whole point of the file. A
 * retryable error is retried with backoff and then cascaded to the next
 * provider; a non-retryable one is surfaced immediately, because retrying a bad
 * API key just burns the user's time.
 */

export class ProviderError extends Error {
  readonly provider: string | null;
  readonly model: string | null;
  /** Seconds the provider asked us to wait, from its `Retry-After` header. */
  readonly retryAfter: number | null;

  constructor(
    message: string,
    opts: { provider?: string | null; model?: string | null; retryAfter?: number | null } = {},
  ) {
    super(message);
    this.name = new.target.name;
    this.provider = opts.provider ?? null;
    this.model = opts.model ?? null;
    this.retryAfter = opts.retryAfter ?? null;
  }
}

/** 429 — quota exceeded. */
export class RateLimitError extends ProviderError {}

/** The request timed out. */
export class ProviderTimeoutError extends ProviderError {}

/** Cannot reach the provider (Ollama not running, DNS failure). */
export class ProviderConnectionError extends ProviderError {}

/** 503 — server overloaded, or the model is not loaded. */
export class ModelUnavailableError extends ProviderError {}

/** Token or context limit exceeded — retry with a smaller image or more tokens. */
export class ContextLengthError extends ProviderError {}

/** 413 — the request body exceeds the provider's limit. */
export class PayloadTooLargeError extends ProviderError {}

/** 401 / 403 — bad or missing API key. */
export class AuthenticationError extends ProviderError {}

/** 400 — bad model name, or an unsupported input format. */
export class InvalidRequestError extends ProviderError {}

/** The server refused multimodal input for this model; try the next in the cascade. */
export class ImageRefusedError extends ProviderError {
  readonly responseBody: string;

  constructor(
    message: string,
    opts: { provider?: string | null; model?: string | null; retryAfter?: number | null },
    responseBody: string,
  ) {
    super(message, opts);
    this.responseBody = responseBody;
  }
}

/** Retried with backoff, then cascaded to the next provider. */
export function isRetryableError(e: unknown): boolean {
  return (
    e instanceof RateLimitError ||
    e instanceof ProviderTimeoutError ||
    e instanceof ModelUnavailableError ||
    e instanceof ContextLengthError ||
    e instanceof PayloadTooLargeError
  );
}

/**
 * Surfaced immediately — no retry, no fallback.
 *
 * `ProviderConnectionError` is here deliberately: a refused connection or a DNS
 * failure is permanent for that provider, so burning the retry ladder on it only
 * delays the cascade. The dispatcher still moves to the next provider, because
 * unlike the other two this failure is provider-specific rather than global.
 */
export function isNotRetryableError(e: unknown): boolean {
  return (
    e instanceof AuthenticationError ||
    e instanceof InvalidRequestError ||
    e instanceof ProviderConnectionError
  );
}
