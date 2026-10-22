/**
 * A System One server on a local port, for an external endpoint: lists its models OpenAI-style
 * (`data[].id`, no `x_model_id`), answers from the fake Laya scripts, and can refuse the API key or an
 * image encoding, fail a photo or stop answering.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { LayaQuestion } from '../../src/laya/rows.js';
import { fakePhotoKey, scriptedAnswers, type FakeLayaState } from './fake-laya.js';

export interface FakeSystemOneServer {
  url: string;
  /** Every `/v1/systemone` request: the photo key (null for the start check), model and auth header. */
  requests: {
    key: string | null;
    model: string;
    authorization: string | undefined;
    questions: string[];
    state: unknown;
    encoding: 'data_url' | 'base64';
  }[];
  /** Answer 400 to images in the other encoding, as oMLX (data URLs only) and Ollama (raw only) do. */
  accepts: 'data_url' | 'base64' | 'both';
  /** Answer 400 to every `/v1/systemone` request. */
  badRequest: boolean;
  /** Refuse requests whose `authorization` is not `Bearer <apiKey>`. */
  apiKey: string | null;
  /** Answer HTTP 500 for this photo. */
  failOn: string | null;
  /** Close the server when this photo is asked: the photo and every later call get no answer. */
  dieOn: string | null;
  close(): Promise<void>;
}

function systemOneAnswer(q: LayaQuestion, p: number[]) {
  if (q.type === 'noul') return { type: 'noul', noul: p[1], probabilities: { false: p[0], true: p[1] } };
  if (q.type === 'score') return { type: 'score', probabilities: Object.fromEntries(p.map((v, i) => [String(i), v])) };
  const keys = Array.isArray(q.criteria) ? q.criteria : Object.keys(q.criteria ?? {});
  return { type: 'choice', probabilities: Object.fromEntries(keys.map((k, i) => [k, p[i]])) };
}

export async function startFakeSystemOneServer(state: FakeLayaState, models: string[]): Promise<FakeSystemOneServer> {
  let server: Server;
  const fake: FakeSystemOneServer = {
    url: '',
    requests: [],
    apiKey: null,
    accepts: 'data_url',
    badRequest: false,
    failOn: null,
    dieOn: null,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const send = (status: number, body: unknown) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(body));
      };
      if (fake.apiKey !== null && req.headers.authorization !== `Bearer ${fake.apiKey}`) {
        return send(401, { error: { message: 'invalid api key' } });
      }
      if (req.method === 'GET' && req.url === '/v1/models') return send(200, { data: models.map((id) => ({ id })) });
      if (req.method !== 'POST' || req.url !== '/v1/systemone') return send(404, { error: 'not found' });
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
        model: string;
        state: unknown;
        images: string[];
        questions: Record<string, LayaQuestion>;
      };
      const sent = body.images[0]!;
      const encoding = sent.startsWith('data:') ? ('data_url' as const) : ('base64' as const);
      const key = fakePhotoKey(new Uint8Array(Buffer.from(sent.replace(/^data:[^,]*,/, ''), 'base64')));
      fake.requests.push({
        key,
        model: body.model,
        authorization: req.headers.authorization,
        questions: Object.keys(body.questions),
        state: body.state,
        encoding,
      });
      if (!models.includes(body.model)) return send(404, { error: `model ${body.model} not found` });
      if (fake.badRequest) return send(400, { error: 'question too long' });
      if (fake.accepts !== 'both' && fake.accepts !== encoding) {
        return send(400, { error: fake.accepts === 'data_url' ? 'images must be base64 data URLs (data:image/...)' : 'illegal base64 data' });
      }
      if (key !== null && key === fake.dieOn) {
        req.socket.destroy();
        void fake.close();
        return;
      }
      if (key !== null && key === fake.failOn) return send(500, { error: 'out of memory' });
      const p = scriptedAnswers(state, key, body.questions);
      const answers = Object.fromEntries(Object.entries(body.questions).map(([qid, q]) => [qid, systemOneAnswer(q, p[qid]!)]));
      send(200, { model: body.model, answers, usage: { input_tokens: 1, output_tokens: 0 } });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  fake.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return fake;
}
