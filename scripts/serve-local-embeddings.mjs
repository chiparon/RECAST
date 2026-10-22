import { createServer } from 'node:http';
import { copyFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { embeddingBatches } from './embedding-batches.mjs';
import { createFeatureEncoder } from './feature-encoder.mjs';

// Optional local inference runtime; keep native ML dependencies out of the extension bundle.
const requireRuntime = createRequire(path.resolve(process.env.FOREXPLORE_EMBEDDING_TOOLS ?? process.cwd(), 'package.json'));
const runtime = await import(pathToFileURL(requireRuntime.resolve('@huggingface/transformers')).href);
const { pipeline, env } = runtime.default ?? runtime;
// A POSIX default is wrong on Windows: the cache then never matches the one the
// services script fills, so every start tried to download from huggingface.co.
env.cacheDir = process.env.FOREXPLORE_MODEL_CACHE ?? path.join(homedir(), '.cache', 'forexplore-model-cache');
if (process.env.FOREXPLORE_MODEL_HOST) env.remoteHost = process.env.FOREXPLORE_MODEL_HOST;
const model = process.env.FOREXPLORE_EMBEDDING_MODEL ?? 'Xenova/multilingual-e5-small';
const revision = process.env.FOREXPLORE_EMBEDDING_REVISION ?? '761b726dd34fb83930e26aab4e9ac3899aa1fa78';
const modelId = `${model}@${revision}`;
const port = Number(process.env.FOREXPLORE_EMBEDDING_PORT ?? 4021);

// The library caches downloads under <model>/<revision>/ but resolves an offline
// load from <model>/. Promote a completed download once, then load without any
// network call: a metadata fetch to huggingface.co fails on this machine (the
// proxy is not used by fetch) and that failure killed the whole service, which
// surfaced as a bare "检索失败：fetch failed" in the workbench.
const modelDirectory = path.join(env.cacheDir, ...model.split('/'));
const revisionDirectory = path.join(modelDirectory, revision);
const cached = (name) => path.join(modelDirectory, name);
const promote = (name) => {
  const source = path.join(revisionDirectory, name);
  if (existsSync(cached(name)) || !existsSync(source)) return;
  mkdirSync(path.dirname(cached(name)), { recursive: true });
  copyFileSync(source, cached(name));
};
for (const name of ['config.json', 'tokenizer.json', 'tokenizer_config.json']) promote(name);
try {
  const variants = existsSync(path.join(revisionDirectory, 'onnx'))
    ? readdirSync(path.join(revisionDirectory, 'onnx')).filter((name) => name.endsWith('.onnx')) : [];
  for (const name of variants) promote(path.join('onnx', name));
} catch { /* a missing onnx directory is reported by the pipeline call below */ }
const complete = ['config.json', 'tokenizer.json', 'tokenizer_config.json']
  .every((name) => existsSync(cached(name)))
  && existsSync(path.join(modelDirectory, 'onnx'))
  && readdirSync(path.join(modelDirectory, 'onnx')).some((name) => name.endsWith('.onnx'));
if (complete) env.allowRemoteModels = false;

console.log(JSON.stringify({ stage: 'loading-model', model, revision, offline: env.allowRemoteModels === false }));

// The quantized q8 model runs most of its operators on the CPU and this server
// never probed for a GPU, while the rerank server next to it already did. On this
// machine that difference is 145 ms versus 16 ms per short document, i.e. a whole
// day versus a few hours for the enterprise asset projection.
const requestedDevice = process.env.FOREXPLORE_EMBEDDING_DEVICE?.trim();
const requestedDtype = process.env.FOREXPLORE_EMBEDDING_DTYPE?.trim();
let extractor;
let device;
let dtype;
const defaultDevices = process.platform === 'win32' ? ['dml', 'cpu'] : ['cuda', 'cpu'];
for (const candidate of requestedDevice ? [requestedDevice] : defaultDevices) {
  const candidateDtype = requestedDtype ?? (candidate === 'cpu' ? 'q8' : 'fp16');
  try {
    extractor = await pipeline('feature-extraction', model, { dtype: candidateDtype, device: candidate, revision });
    device = candidate;
    dtype = candidateDtype;
    break;
  } catch (error) {
    console.error(JSON.stringify({ stage: 'device-failed', device: candidate, dtype: candidateDtype,
      message: error instanceof Error ? error.message : String(error) }));
  }
}
if (!extractor) throw new Error('No usable inference device for embeddings.');
const encoder = await createFeatureEncoder({ extractor, runtime: runtime.default ?? runtime,
  enabled: model === 'Xenova/multilingual-e5-small' && revision === '761b726dd34fb83930e26aab4e9ac3899aa1fa78',
  loadTokenizer: () => requireRuntime('tokenizers').Tokenizer.fromFile(
    existsSync(path.join(revisionDirectory, 'tokenizer.json')) ? path.join(revisionDirectory, 'tokenizer.json') : cached('tokenizer.json')),
  onFallback: error => console.warn(`Native tokenizer unavailable; using JavaScript tokenization: ${error.message}`),
});
await encoder.encode(['query: warmup']);
console.log(JSON.stringify({ stage: 'model-ready', model: modelId, device, dtype, tokenizer: encoder.kind }));
let pending = 0;
let queue = Promise.resolve();
const server = createServer(async (request, response) => {
  response.setHeader('content-type', 'application/json');
  if (request.url === '/health' && request.method === 'GET') {
    response.end(JSON.stringify({ ready: true, model: modelId, revision, device, dtype, tokenizer: encoder.kind, pending })); return;
  }
  if (request.url !== '/v1/embeddings' || request.method !== 'POST') { response.writeHead(404); response.end('{}'); return; }
  if (pending >= 8) { response.writeHead(429); response.end('{"error":{"message":"Inference queue is full"}}'); return; }
  pending++;
  try {
    let size = 0;
    const chunks = [];
    for await (const chunk of request) {
      size += chunk.length;
      if (size > 1_000_000) throw new Error('Request exceeds byte limit');
      chunks.push(chunk);
    }
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (body.model !== modelId) throw new Error('Requested model/revision is not loaded');
    if (!Array.isArray(body.input) || body.input.length < 1 || body.input.length > 16 ||
      body.input.some((text) => typeof text !== 'string' || text.length > 32_000)) throw new Error('Invalid embedding input');
    const vectors = new Array(body.input.length);
    for (const batch of embeddingBatches(body.input)) {
      const task = queue.then(async () => {
        if (response.destroyed) throw new Error('Client disconnected');
        // The model tokenizer already truncates to its token window. Do not
        // truncate by characters or decode/re-encode tokens and change vectors.
        const tensor = await encoder.encode(batch.map(entry => entry.text));
        return tensor.tolist();
      });
      queue = task.then(() => undefined, () => undefined);
      const encoded = await task;
      batch.forEach((entry, i) => { vectors[entry.index] = encoded[i]; });
    }
    if (body.dimensions !== undefined && body.dimensions !== vectors[0].length) throw new Error('Unsupported embedding dimension');
    response.end(JSON.stringify({ model: modelId, data: vectors.map((embedding, index) => ({ index, embedding })) }));
  } catch (error) {
    response.writeHead(400); response.end(JSON.stringify({ error: { message: error.message } }));
  } finally { pending--; }
});
server.requestTimeout = 30_000;
server.listen(port, '127.0.0.1', () => console.log(JSON.stringify({ ready: true, url: `http://127.0.0.1:${port}`, model: modelId, revision, device, dtype })));
process.once('SIGTERM', () => server.close());
process.once('SIGINT', () => server.close());
