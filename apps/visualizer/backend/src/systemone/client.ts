/**
 * System One client: how culling reaches a decision model (ADR-0021). `POST {url}/v1/systemone` with
 * `{model, state, images: [base64], questions}`, models from `GET {url}/v1/models`. Servers disagree on
 * the image: oMLX wants a data URL, Ollama raw base64; the caller picks (`SystemOneImageEncoding`).
 *
 * It does not know whether the endpoint is this app or another server: this app is the same requests
 * through the app's own `fetch`, in-process.
 */
import { z } from 'zod';
import type { CullingModelConfig } from '../config.js';
import type { LayaQuestion } from '../laya/rows.js';

export const THIS_APP_ENDPOINT = 'this_app';
const THIS_APP_URL = 'http://this-app';
/** A model load on the endpoint's first call can take a while; past this the endpoint is down. */
const REQUEST_TIMEOUT_MS = 300_000;

export type SystemOneFailure = 'down' | 'not_listed' | 'refused' | 'http' | 'malformed';

export type SystemOneImageEncoding = 'data_url' | 'base64';

export class SystemOneError extends Error {
  override readonly name = 'SystemOneError';
  constructor(
    readonly failure: SystemOneFailure,
    message: string,
    /** The HTTP status, when the endpoint answered one. */
    readonly status?: number,
  ) {
    super(message);
  }
}

export interface SystemOneEndpoint {
  /** `this_app`, or the URL without a trailing slash: part of a model's identity. */
  id: string;
  /** What messages call it: "this app" or the URL. */
  label: string;
  url: string;
  apiKey: string;
  fetch: typeof fetch;
}

export interface ListedModel {
  name: string;
  /** What the endpoint says this model is (`x_model_id`), when it says. */
  modelId: string | null;
}

export type SystemOneAnswers = Record<string, number[]>;

/** This app's route group, loaded on first use so jobs and the CLI need no server. */
const thisAppFetch: typeof fetch = async (input, init) => {
  const { systemOneRoutes } = await import('../api/systemone.js');
  return systemOneRoutes.request(input instanceof URL ? input.href : input, init);
};

export function systemOneEndpoint(cfg: CullingModelConfig, opts: { thisAppFetch?: typeof fetch } = {}): SystemOneEndpoint {
  if (cfg.endpoint === THIS_APP_ENDPOINT) {
    return {
      id: THIS_APP_ENDPOINT,
      label: 'this app',
      url: THIS_APP_URL,
      apiKey: '',
      fetch: opts.thisAppFetch ?? thisAppFetch,
    };
  }
  const url = cfg.endpoint.replace(/\/+$/, '');
  return { id: url, label: url, url, apiKey: cfg.apiKey, fetch: globalThis.fetch.bind(globalThis) };
}

/** The identity stage versions hash: the endpoint's own, or the model's name on that endpoint. */
export function modelIdentity(ep: SystemOneEndpoint, model: ListedModel): string {
  return model.modelId ?? `${model.name}@${ep.id}`;
}

const ModelsList = z.union([
  z.object({ models: z.array(z.object({ name: z.string(), x_model_id: z.string().nullish() })) }),
  z.object({ data: z.array(z.object({ id: z.string() })) }),
]);

const Probabilities = z.record(z.string(), z.number());
const Answer = z.discriminatedUnion('type', [
  z.object({ type: z.literal('score'), probabilities: Probabilities }),
  z.object({ type: z.literal('choice'), probabilities: Probabilities }),
  z.object({
    type: z.literal('noul'),
    noul: z.number(),
    probabilities: z.object({ false: z.number(), true: z.number() }).optional(),
  }),
]);
const Response = z.object({ answers: z.record(z.string(), z.unknown()) });

const errorText = (e: unknown): string => {
  const cause = e instanceof Error && e.cause instanceof Error ? `: ${e.cause.message}` : '';
  return `${e instanceof Error ? e.message : String(e)}${cause}`;
};

async function request(ep: SystemOneEndpoint, path: string, body?: unknown, timeoutMs = REQUEST_TIMEOUT_MS): Promise<unknown> {
  const headers: Record<string, string> = {};
  if (ep.apiKey) headers.authorization = `Bearer ${ep.apiKey}`;
  if (body !== undefined) headers['content-type'] = 'application/json';
  let res: globalThis.Response;
  try {
    res = await ep.fetch(`${ep.url}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    throw new SystemOneError('down', `${ep.label} does not answer (${errorText(e)})`);
  }
  const text = await res.text();
  if (!res.ok) {
    let detail = text.slice(0, 300);
    try {
      const j = JSON.parse(text) as { error?: unknown };
      if (Array.isArray(j)) detail = j.map((i: { msg?: unknown }) => String(i?.msg ?? '')).join('; ');
      else if (typeof j.error === 'string') detail = j.error;
      else if (j.error && typeof j.error === 'object' && 'message' in j.error) detail = String(j.error.message);
    } catch {
      // Not JSON: the raw text says it.
    }
    const at = `${ep.label} answered HTTP ${res.status}: ${detail}`;
    const fail = (failure: SystemOneFailure, message: string) => new SystemOneError(failure, message, res.status);
    if (res.status === 401 || res.status === 403) throw fail('refused', `${ep.label} refused the API key (${at})`);
    if (res.status === 404) throw fail('not_listed', at);
    if (res.status === 503) throw fail('down', `${ep.label} cannot answer now (${at})`);
    throw fail('http', at);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new SystemOneError('malformed', `${ep.label} sent something that is not JSON: ${text.slice(0, 120)}`);
  }
}

export async function listSystemOneModels(ep: SystemOneEndpoint, opts: { timeoutMs?: number } = {}): Promise<ListedModel[]> {
  const parsed = ModelsList.safeParse(await request(ep, '/v1/models', undefined, opts.timeoutMs));
  if (!parsed.success) throw new SystemOneError('malformed', `${ep.label} sent a model list it cannot read`);
  const list = parsed.data;
  return 'models' in list
    ? list.models.map((m) => ({ name: m.name, modelId: m.x_model_id ?? null }))
    : list.data.map((m) => ({ name: m.id, modelId: null }));
}

/** Level probabilities in the order the question lists them (score levels, choice keys, noul false/true). */
function levels(qid: string, q: LayaQuestion, raw: unknown, label: string): number[] {
  const bad = (why: string) => new SystemOneError('malformed', `${label} sent a malformed answer to ${qid}: ${why}`);
  const parsed = Answer.safeParse(raw);
  if (!parsed.success) throw bad(raw === undefined ? 'no answer' : 'unreadable answer');
  const a = parsed.data;
  if (a.type !== q.type) throw bad(`a ${a.type} answer to a ${q.type} question`);
  if (a.type === 'noul') return a.probabilities ? [a.probabilities.false, a.probabilities.true] : [1 - a.noul, a.noul];
  const keys =
    a.type === 'score'
      ? (q.criteria as string[]).map((_, i) => String(i))
      : Array.isArray(q.criteria)
        ? q.criteria
        : Object.keys(q.criteria ?? {});
  return keys.map((k) => {
    const p = a.probabilities[k];
    if (p === undefined) throw bad(`no probability for level ${k}`);
    return p;
  });
}

function imageMime(b: Uint8Array): string {
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
  if (Buffer.from(b.subarray(8, 12)).toString('latin1') === 'WEBP') return 'image/webp';
  return 'image/jpeg';
}

/** One image, every question about it; answers by question id. The image goes as a data URL unless told otherwise. */
export async function askSystemOne(
  ep: SystemOneEndpoint,
  req: { model: string; image: Uint8Array; questions: Record<string, LayaQuestion>; encoding?: SystemOneImageEncoding },
): Promise<SystemOneAnswers> {
  const base64 = Buffer.from(req.image).toString('base64');
  const body = {
    model: req.model,
    state: '',
    images: [req.encoding === 'base64' ? base64 : `data:${imageMime(req.image)};base64,${base64}`],
    questions: req.questions,
  };
  const parsed = Response.safeParse(await request(ep, '/v1/systemone', body));
  if (!parsed.success) throw new SystemOneError('malformed', `${ep.label} sent an answer with no answers`);
  const out: SystemOneAnswers = {};
  for (const [qid, q] of Object.entries(req.questions)) out[qid] = levels(qid, q, parsed.data.answers[qid], ep.label);
  return out;
}
