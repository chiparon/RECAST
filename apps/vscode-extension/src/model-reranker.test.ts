import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, expect, it, vi } from 'vitest';
import { DEFAULT_LLM_SETTINGS } from '@forexplore/contracts';
import { ConfiguredModelReranker } from './model-reranker';
import { createModelCredentialProvider, modelCredentialId } from './model-credential';
import { setModelCredentialProvider } from './local-fetch';

afterEach(() => setModelCredentialProvider(undefined));
const candidates = [0, 1].map(id => ({ id: String(id), name: 'feature', granularity: 'function', relativePath: 'a.py', preview: 'def feature(): pass' }));
it('preserves real module names and representative evidence in the ranking transport', async () => {
  let payload: any;
  const ranker = new ConfiguredModelReranker(() => 'http://127.0.0.1:8788', async () => {}, async (_url, init) => {
    payload = JSON.parse(String(init?.body));
    return Response.json({ order: ['c1', 'c0'] });
  });
  const documents = ['Order processing\nCore APIs: placeOrder\nImplementation evidence:\nOrderService.java\nplaceOrder()',
    'Multipart parsing\nCore APIs: parse\nImplementation evidence:\nMultipartParser.java\ncheckFileSize()'];
  await ranker.rank('upload', documents, new AbortController().signal);
  expect(payload.candidates.map((candidate: any) => candidate.name)).toEqual(['Order processing', 'Multipart parsing']);
  expect(payload.candidates.map((candidate: any) => candidate.preview)).toEqual(documents);
});

it('forwards fresh panel keys and model settings for module reranking', async () => {
  const requests: any[] = [];
  const server = createServer((req, res) => {
    requests.push(req.headers); req.resume();
    res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ order: requests.length === 1 ? ['1', '0'] : ['c1', 'c0'] }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  let key = 'test-panel-key-one'; let settings = { ...DEFAULT_LLM_SETTINGS };
  setModelCredentialProvider(createModelCredentialProvider({ get: async () => key, store: async () => {}, delete: async () => {} }, () => url, () => settings));
  try {
    const ensure = vi.fn(async () => {}); const ranker = new ConfiguredModelReranker(() => url, ensure);
    expect((await ranker.rerank('feature', candidates)).map(c => c.id)).toEqual(['1', '0']);
    key = 'test-panel-key-two'; settings = { ...settings, model: 'changed-model' };
    expect((await ranker.rank('feature', ['one', 'two'], new AbortController().signal)).map(c => c.index)).toEqual([1, 0]);
    expect(requests.map(r => r['x-recast-model-key'])).toEqual(['test-panel-key-one', 'test-panel-key-two']);
    expect(JSON.parse(decodeURIComponent(requests[1]['x-recast-model-config'])).model).toBe('changed-model');
    expect(ensure).toHaveBeenCalledTimes(2);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});
it('routes both reranking APIs to the owned port after startup and follows backend restarts', async () => {
  const configured = 'http://127.0.0.1:8788';
  let runtime = configured;
  let key = 'saved-key-one';
  let settings = { ...DEFAULT_LLM_SETTINGS };
  const requests: Array<{ backend: number; method?: string; path?: string; key: unknown; model: string; ids: string[] }> = [];
  const servers = [0, 1].map(backend => createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    const payload = JSON.parse(body) as { candidates: Array<{ id: string }> };
    const model = JSON.parse(decodeURIComponent(String(req.headers['x-recast-model-config'])));
    requests.push({ backend, method: req.method, path: req.url, key: req.headers['x-recast-model-key'],
      model: model.model, ids: payload.candidates.map(candidate => candidate.id) });
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ order: payload.candidates.map(candidate => candidate.id).reverse() }));
  }));
  const storage = { get: vi.fn(async (id: string) => id === modelCredentialId(configured, settings) ? key : undefined),
    store: vi.fn(), delete: vi.fn() };
  setModelCredentialProvider(createModelCredentialProvider(storage, () => configured, () => settings, () => runtime));
  try {
    await Promise.all(servers.map(server => new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))));
    const endpoints = servers.map(server => `http://127.0.0.1:${(server.address() as AddressInfo).port}`);
    let starts = 0;
    const ensure = vi.fn(async () => {
      const endpoint = endpoints[starts++];
      if (!endpoint) throw new Error('Unexpected backend startup');
      runtime = endpoint;
    });
    const ranker = new ConfiguredModelReranker(() => runtime, ensure, undefined,
      () => JSON.stringify({ endpoint: configured, llm: settings }));
    const initialIdentity = ranker.cacheKey();

    expect((await ranker.rerank('feature', candidates)).map(candidate => candidate.id)).toEqual(['1', '0']);
    expect(runtime).toBe(endpoints[0]);
    expect(ranker.cacheKey()).toBe(initialIdentity);
    key = 'saved-key-two';
    settings = { ...settings, model: 'changed-model' };
    const changedIdentity = ranker.cacheKey();
    expect(changedIdentity).not.toBe(initialIdentity);
    expect((await ranker.rank('feature', ['one', 'two'], new AbortController().signal)).map(candidate => candidate.index)).toEqual([1, 0]);
    expect(runtime).toBe(endpoints[1]);
    expect(ranker.cacheKey()).toBe(changedIdentity);
    expect(requests).toEqual([
      { backend: 0, method: 'POST', path: '/v1/retrieval-rerank', key: 'saved-key-one', model: DEFAULT_LLM_SETTINGS.model, ids: ['0', '1'] },
      { backend: 1, method: 'POST', path: '/v1/retrieval-rerank', key: 'saved-key-two', model: 'changed-model', ids: ['c0', 'c1'] },
    ]);
    expect(storage.get.mock.calls).toEqual([[modelCredentialId(configured, settings)], [modelCredentialId(configured, settings)]]);
    expect(ensure).toHaveBeenCalledTimes(2);
  } finally {
    await Promise.all(servers.map(server => new Promise<void>(resolve => server.close(() => resolve()))));
  }
});
it('rejects fabricated or repeated candidate IDs and honors cancellation', async () => {
  const ranker = new ConfiguredModelReranker(() => 'http://127.0.0.1:8788', async () => {}, async () => Response.json({ order: ['0', '0'] }));
  await expect(ranker.rerank('feature', candidates)).rejects.toThrow('无效候选');
  const controller = new AbortController(); controller.abort();
  await expect(ranker.rerank('feature', candidates, controller.signal)).rejects.toThrow();
});

it('automatic transport preserves the selected prefix and exposes decision evidence',async()=>{
 const decisions:any[]=[]; let request:any;
 const selection={responsibilities:['parse'],candidates:[],proposed:[],selected:[{id:'c1',reason:'parse',evidence:'parse()',incrementalValue:'primary'}],rejected:[],missingResponsibilities:['store']};
 const ranker=new ConfiguredModelReranker(()=> 'http://127.0.0.1:8788',async()=>{},async(_url,init)=>{
  request=JSON.parse(String(init?.body)); return Response.json({order:['c1','c0'],selection});
 },undefined,{onSelection:s=>decisions.push(s)});
 expect((await ranker.rank('parse',['storage','parser'],new AbortController().signal)).map(r=>r.index)).toEqual([1,0]);
 expect(request.selectReferences).toBe(true);expect(decisions[0]).toEqual(selection);
});
it('automatic transport does not silently choose a hybrid/default rank when selection is absent',async()=>{
 const ranker=new ConfiguredModelReranker(()=> 'http://127.0.0.1:8788',async()=>{},async()=>Response.json({order:['c0','c1']}),undefined,{onSelection:()=>{throw new Error('must not reach caller');}});
 await expect(ranker.rank('parse',['storage','parser'],new AbortController().signal)).rejects.toThrow('selection');
});
