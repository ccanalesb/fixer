/**
 * Vision calls against OpenAI-compatible providers.
 */
import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import {
  AuthenticationError,
  ContextLengthError,
  InvalidRequestError,
  ModelUnavailableError,
  PayloadTooLargeError,
  ProviderConnectionError,
  ProviderError,
  ProviderTimeoutError,
  RateLimitError,
} from './errors.js';
import { requestJson } from './http.js';
import type { LogCallback } from './retry.js';

/** A resolved provider endpoint: everything a request needs and nothing more. */
export interface ProviderClient {
  providerId: string;
  baseUrl: string;
  apiKey: string;
  authMode?: 'none' | 'bearer' | 'header';
  authHeaderName?: string;
  extraHeaders: Record<string, string>;
  timeoutMs: number;
}

interface ChatMessageContentPart {
  type: 'text' | 'image_url';
  text?: string;
  image_url?: { url: string };
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string | ChatMessageContentPart[];
}

async function encodeImage(path: string): Promise<string> {
  return (await readFile(path)).toString('base64');
}

function imageUrlPart(b64: string): ChatMessageContentPart {
  return { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${b64}` } };
}

/**
 * Map an HTTP failure onto the `ProviderError` hierarchy.
 *
 * The body text is inspected as well as the status, because providers disagree
 * about which 400 means "context too long" versus "bad model name", and the two
 * take different paths — one escalates `max_tokens`, the other aborts.
 */
function mapHttpError(
  status: number,
  body: string,
  headers: Headers,
  ctx: { provider: string | null; model: string | null },
): ProviderError {
  const retryAfterRaw = headers.get('retry-after');
  const parsed = retryAfterRaw === null ? Number.NaN : Number.parseFloat(retryAfterRaw);
  const retryAfter = Number.isFinite(parsed) ? parsed : null;
  const opts = { ...ctx, retryAfter };
  const msg = `${status}: ${body.slice(0, 500)}`;
  const lower = body.toLowerCase();

  if (status === 429) return new RateLimitError(msg, opts);
  if (status === 401 || status === 403) return new AuthenticationError(msg, ctx);
  if (status === 413) return new PayloadTooLargeError(msg, ctx);
  if (status === 400) {
    if (
      lower.includes('context length') ||
      lower.includes('too many tokens') ||
      lower.includes('maximum') ||
      lower.includes('budget_tokens') ||
      lower.includes('thinking')
    ) {
      return new ContextLengthError(msg, ctx);
    }
    return new InvalidRequestError(msg, ctx);
  }
  if (
    lower.includes('multimodal') ||
    lower.includes('image_url') ||
    lower.includes('modality')
  ) {
    return new InvalidRequestError(msg, ctx);
  }
  if (status === 503) return new ModelUnavailableError(msg, ctx);
  return new ProviderError(msg, ctx);
}

/** Map a transport-level failure — no HTTP response was received. */
function mapTransportError(
  e: unknown,
  ctx: { provider: string | null; model: string | null },
): ProviderError {
  const message = e instanceof Error ? e.message : String(e);
  if (e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError')) {
    return new ProviderTimeoutError(message, ctx);
  }
  // Refused, DNS failure, TLS failure: permanent for this provider.
  return new ProviderConnectionError(message, ctx);
}

async function postJson(
  client: ProviderClient,
  path: string,
  body: unknown,
  model: string,
): Promise<unknown> {
  const ctx = { provider: client.providerId, model };
  return requestJson(client, path, {
    method: 'POST',
    body,
    onHttpError: (res, text) => mapHttpError(res.status, text, res.headers, ctx),
    onTransportError: (e) => mapTransportError(e, ctx),
  });
}

interface ChatCompletion {
  choices?: { message?: { content?: string | null } }[];
}

/**
 * Generate a structured description for one image. Returns the raw text.
 *
 * `think` defaults false because that is the reliable structured-JSON path;
 * `maxTokens` bounds the budget, and thinking needs a larger one or the answer
 * truncates before the JSON closes.
 */
export async function generateDescription(
  client: ProviderClient,
  model: string,
  imagePath: string,
  opts: {
    logCallback?: LogCallback;
    userPrompt?: string | null;
    think?: boolean;
    maxTokens?: number;
    fallbackPrompt: string;
  },
): Promise<string> {
  const maxTokens = opts.maxTokens ?? 2048;
  const imgB64 = await encodeImage(imagePath);
  const textPrompt =
    opts.userPrompt && opts.userPrompt.trim() ? opts.userPrompt.trim() : opts.fallbackPrompt;

  const messages: ChatMessage[] = [
    {
      role: 'user',
      content: [{ type: 'text', text: textPrompt }, imageUrlPart(imgB64)],
    },
  ];

  const body = (await postJson(
    client,
    '/chat/completions',
    { model, messages, max_tokens: maxTokens },
    model,
  )) as ChatCompletion;
  const raw = body.choices?.[0]?.message?.content ?? '';

  opts.logCallback?.('debug', `[describe] ${basename(imagePath)} -> ${raw.length} chars`);
  return raw;
}

/** A text-only chat completion, with no images. */
export async function completeChatText(
  client: ProviderClient,
  model: string,
  opts: { system: string; user: string; maxTokens?: number; temperature?: number },
): Promise<string> {
  const body = (await postJson(
    client,
    '/chat/completions',
    {
      model,
      messages: [
        { role: 'system', content: opts.system },
        { role: 'user', content: opts.user },
      ],
      max_tokens: opts.maxTokens ?? 512,
      temperature: opts.temperature ?? 0,
      // Claude models bill reasoning tokens even for a repair call, and this
      // path only ever needs mechanical output.
      ...(model.toLowerCase().includes('claude')
        ? { extra_body: { reasoning_effort: 'none' } }
        : {}),
    },
    model,
  )) as ChatCompletion;
  return body.choices?.[0]?.message?.content ?? '';
}

const SCORE_JSON_REPAIR_SYSTEM =
  'You are a JSON repair tool. Output analysis is forbidden; emit data only.\n' +
  'Return a single JSON object with exactly these keys:\n' +
  '- "perspective_slug" (string)\n' +
  '- "score" (integer from 1 through 10 inclusive)\n' +
  '- "rationale" (string)\n' +
  'Do not wrap the JSON in markdown fences. Do not add any text before or after the object.';

/**
 * Build the `llmFixer` that `parseScoreResponseWithRetry` calls at most once.
 *
 * The raw output is truncated to 4096 characters: a model that has gone off the
 * rails can emit the whole context back, and paying to send that to a second
 * model buys nothing the first few kilobytes do not already show.
 *
 * There is no default repair client here on purpose — the fixer runs against the
 * same provider and model that produced the bad answer, which the caller knows
 * and this module does not.
 */
export function makeScoreJsonLlmFixer(
  client: ProviderClient,
  model: string,
): (raw: string, errorSummary: string) => Promise<string> {
  return async (raw, errorSummary) =>
    completeChatText(client, model, {
      system: SCORE_JSON_REPAIR_SYSTEM,
      user:
        'The previous output is not valid JSON for the required score schema.\n\n' +
        `Raw model output (first 4096 characters):\n${raw.slice(0, 4096)}\n\n` +
        `Validation error summary:\n${errorSummary}\n\n` +
        'Respond with ONLY the corrected JSON object. Keys must be exactly ' +
        'perspective_slug, score, and rationale.',
    });
}
