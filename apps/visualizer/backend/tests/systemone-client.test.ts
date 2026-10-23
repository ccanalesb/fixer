/**
 * The System One client against a fake server on a real socket: model lists in both shapes, the
 * model identity, answers read into level probabilities, and each failure named.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadLibraryConfig } from '../src/config.js';
import {
  askSystemOne,
  listSystemOneModels,
  modelIdentity,
  SystemOneError,
  systemOneEndpoint,
} from '../src/systemone/client.js';

type Handler = (req: IncomingMessage, body: string, res: ServerResponse) => void;

let server: Server;
let url: string;
let handler: Handler;
const seen: { method: string; path: string; auth: string | undefined; body: unknown }[] = [];

const json = (res: ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
};

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      seen.push({ method: req.method!, path: req.url!, auth: req.headers.authorization, body: body ? JSON.parse(body) : null });
      handler(req, body, res);
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

beforeEach(() => {
  seen.length = 0;
  handler = (_req, _body, res) => json(res, 500, { error: 'no handler' });
});

const image = new Uint8Array([0xff, 0xd8, 0xff, 0x00, 0x01]);
const questions = {
  'q#tension': { type: 'score' as const, instructions: 'How tense?', criteria: ['none', 'some', 'a lot'] },
  'q#excused': { type: 'noul' as const, instructions: 'No framing device?' },
};

describe('listSystemOneModels', () => {
  it('reads the System One shape, with the identity the endpoint gives', async () => {
    handler = (_q, _b, res) =>
      json(res, 200, {
        models: [
          { name: 'culling-model', description: 'x', release_date: '2026-09-24', x_model_id: 'owner/vision-model@8b318c9' },
          { name: 'jev-latest', description: 'y', release_date: '2026-10-14' },
        ],
      });
    const ep = systemOneEndpoint({ endpoint: `${url}/`, model: 'culling-model', apiKey: 'k' });
    const models = await listSystemOneModels(ep);
    expect(models).toEqual([
      { name: 'culling-model', modelId: 'owner/vision-model@8b318c9' },
      { name: 'jev-latest', modelId: null },
    ]);
    expect(seen[0]).toMatchObject({ method: 'GET', path: '/v1/models', auth: 'Bearer k' });
  });

  it('reads the OpenAI shape Ollama and oMLX answer with', async () => {
    handler = (_q, _b, res) => json(res, 200, { object: 'list', data: [{ id: 'clef-flash:latest', object: 'model' }] });
    const models = await listSystemOneModels(systemOneEndpoint({ endpoint: url, model: 'clef-flash:latest', apiKey: '' }));
    expect(models).toEqual([{ name: 'clef-flash:latest', modelId: null }]);
    expect(seen[0]!.auth).toBeUndefined();
  });

  it('names a model by its endpoint when the endpoint gives no identity', () => {
    const ep = systemOneEndpoint({ endpoint: `${url}/`, model: 'clef', apiKey: '' });
    expect(modelIdentity(ep, { name: 'clef', modelId: null })).toBe(`clef@${url}`);
    expect(modelIdentity(ep, { name: 'culling-model', modelId: 'owner/vision-model@8b318c9' })).toBe('owner/vision-model@8b318c9');
  });

  it('an endpoint that does not answer is down', async () => {
    const ep = systemOneEndpoint({ endpoint: 'http://127.0.0.1:1', model: 'x', apiKey: '' });
    const e = await listSystemOneModels(ep).catch((err: unknown) => err);
    expect(e).toBeInstanceOf(SystemOneError);
    expect(e).toMatchObject({ failure: 'down' });
    expect((e as Error).message).toContain('http://127.0.0.1:1 does not answer');
  });

  it('a rejected API key is refused, and a list it cannot read is malformed', async () => {
    handler = (_q, _b, res) => json(res, 401, { error: { message: 'API key required' } });
    const ep = systemOneEndpoint({ endpoint: url, model: 'x', apiKey: 'bad' });
    await expect(listSystemOneModels(ep)).rejects.toMatchObject({ failure: 'refused' });
    handler = (_q, _b, res) => json(res, 200, { nothing: true });
    await expect(listSystemOneModels(ep)).rejects.toMatchObject({ failure: 'malformed' });
  });
});

describe('askSystemOne', () => {
  const ep = () => systemOneEndpoint({ endpoint: url, model: 'm', apiKey: 'k' });

  it('sends the model, an empty state, the image as a data URL and the questions', async () => {
    handler = (_q, _b, res) =>
      json(res, 200, {
        model: 'm',
        answers: {
          'q#tension': { type: 'score', score: 1.6, confidence: 0.5, legend: {}, probabilities: { '0': 0.1, '1': 0.2, '2': 0.7 } },
          'q#excused': { type: 'noul', noul: 0.25 },
        },
        usage: { input_tokens: 1, output_tokens: 0 },
      });
    const answers = await askSystemOne(ep(), { model: 'm', image, questions });
    expect(seen[0]).toMatchObject({ method: 'POST', path: '/v1/systemone', auth: 'Bearer k' });
    expect(seen[0]!.body).toEqual({
      model: 'm',
      state: '',
      images: [`data:image/jpeg;base64,${Buffer.from(image).toString('base64')}`],
      questions,
    });
    expect(answers).toEqual({ 'q#tension': [0.1, 0.2, 0.7], 'q#excused': [0.75, 0.25] });
  });

  it('sends raw base64 when asked to, and names a PNG a PNG', async () => {
    handler = (_q, _b, res) =>
      json(res, 200, { answers: { 'q#tension': { type: 'score', probabilities: { '0': 1, '1': 0, '2': 0 } } } });
    const one = { 'q#tension': questions['q#tension'] };
    await askSystemOne(ep(), { model: 'm', image, questions: one, encoding: 'base64' });
    expect((seen[0]!.body as { images: string[] }).images).toEqual([Buffer.from(image).toString('base64')]);
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]);
    await askSystemOne(ep(), { model: 'm', image: png, questions: one });
    expect((seen[1]!.body as { images: string[] }).images[0]).toMatch(/^data:image\/png;base64,/);
  });

  it('an HTTP error keeps its status', async () => {
    handler = (_q, _b, res) => json(res, 400, { error: 'images must be base64 data URLs (data:image/...)' });
    await expect(askSystemOne(ep(), { model: 'm', image, questions })).rejects.toMatchObject({ failure: 'http', status: 400 });
  });

  it('reads a noul’s false/true probabilities when the endpoint sends them', async () => {
    handler = (_q, _b, res) =>
      json(res, 200, {
        model: 'm',
        answers: {
          'q#tension': { type: 'score', score: 0, confidence: 1, legend: {}, probabilities: { '0': 1, '1': 0, '2': 0 } },
          'q#excused': { type: 'noul', noul: 0.3, probabilities: { false: 0.7000000000000001, true: 0.3 } },
        },
        usage: { input_tokens: 1, output_tokens: 0 },
      });
    const answers = await askSystemOne(ep(), { model: 'm', image, questions });
    expect(answers['q#excused']).toEqual([0.7000000000000001, 0.3]);
  });

  it('an answer missing a question or a level is malformed', async () => {
    handler = (_q, _b, res) =>
      json(res, 200, {
        model: 'm',
        answers: { 'q#tension': { type: 'score', score: 0, confidence: 1, legend: {}, probabilities: { '0': 1, '1': 0 } } },
        usage: { input_tokens: 1, output_tokens: 0 },
      });
    const e = await askSystemOne(ep(), { model: 'm', image, questions }).catch((err: unknown) => err);
    expect(e).toMatchObject({ failure: 'malformed' });
    expect((e as Error).message).toContain('q#tension');
    handler = (_q, _b, res) => json(res, 200, 'not json');
    await expect(askSystemOne(ep(), { model: 'm', image, questions })).rejects.toMatchObject({ failure: 'malformed' });
  });

  it('404 is a model not listed, 503 is down, any other status names itself', async () => {
    handler = (_q, _b, res) => json(res, 404, { error: 'model m is not listed by this app' });
    await expect(askSystemOne(ep(), { model: 'm', image, questions })).rejects.toMatchObject({ failure: 'not_listed' });
    handler = (_q, _b, res) => json(res, 503, { error: 'worker exited' });
    await expect(askSystemOne(ep(), { model: 'm', image, questions })).rejects.toMatchObject({ failure: 'down' });
    handler = (_q, _b, res) =>
      json(res, 422, [
        { loc: ['body', 'state'], msg: 'bad state', type: 'custom' },
        { loc: ['body'], msg: 'too long', type: 'custom' },
      ]);
    const e = await askSystemOne(ep(), { model: 'm', image, questions }).catch((err: unknown) => err);
    expect(e).toMatchObject({ failure: 'http' });
    expect((e as Error).message).toBe(`${ep().label} answered HTTP 422: bad state; too long`);
  });
});

describe('culling_models in config.yaml', () => {
  it('defaults both stages to this app with no model, and reads every key of a stage', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lt-s1-cfg-'));
    try {
      expect(loadLibraryConfig(join(dir, 'none.yaml')).cullingModels).toEqual({
        culling_profile: { endpoint: 'this_app', model: '', apiKey: '' },
        score_forecast: { endpoint: 'this_app', model: '', apiKey: '' },
      });
      const cfg = join(dir, 'config.yaml');
      writeFileSync(
        cfg,
        [
          'culling_models:',
          '  culling_profile:',
          '    endpoint: this_app',
          '    model: culling-model',
          '    api_key: ""',
          '  score_forecast:',
          '    endpoint: http://localhost:9000',
          '    model: clef',
          '    api_key: "1234"',
          '',
        ].join('\n'),
      );
      expect(loadLibraryConfig(cfg).cullingModels.score_forecast).toEqual({
        endpoint: 'http://localhost:9000',
        model: 'clef',
        apiKey: '1234',
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('systemOneEndpoint', () => {
  it('this app is reached in-process, never over a socket, and takes no API key', async () => {
    const calls: string[] = [];
    const ep = systemOneEndpoint({ endpoint: 'this_app', model: 'culling-model', apiKey: 'ignored' }, {
      thisAppFetch: async (input) => {
        calls.push(String(input instanceof Request ? input.url : input));
        return new Response(JSON.stringify({ models: [{ name: 'culling-model', description: '', release_date: '' }] }), {
          headers: { 'content-type': 'application/json' },
        });
      },
    });
    expect(ep.label).toBe('this app');
    expect(await listSystemOneModels(ep)).toEqual([{ name: 'culling-model', modelId: null }]);
    expect(calls).toEqual(['http://this-app/v1/models']);
    expect(modelIdentity(ep, { name: 'culling-model', modelId: null })).toBe('culling-model@this_app');
  });
});
