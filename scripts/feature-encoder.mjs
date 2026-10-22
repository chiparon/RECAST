const options = Object.freeze({ pooling: 'mean', normalize: true });
const probes = ['', 'query: warmup', 'passage: 中文需求、订单重试 😀 café e\u0301',
  '<s> <pad> </s> <unk> <mask>', 'passage: public void work() { return; }\n', ' x'.repeat(700)];

function tensors(encodings, Tensor, tokenizer) {
  const sequences = encodings.map(encoding => ({ ids: encoding.getIds(), mask: encoding.getAttentionMask() }));
  const width = Math.min(tokenizer.model_max_length, Math.max(...sequences.map(sequence => sequence.ids.length)));
  if (!width || sequences.some(sequence => sequence.ids.length !== sequence.mask.length)) throw new Error('Invalid native token sequence.');
  const ids = [], masks = [];
  for (const sequence of sequences) {
    // Transformers.js 3.8 truncates the fully postprocessed sequence by prefix,
    // including special tokens. Native truncation instead preserves EOS, so do
    // the same prefix slicing here before applying batch padding.
    const input = sequence.ids.slice(0, width), mask = sequence.mask.slice(0, width);
    const count = width - input.length;
    const padding = Array(count).fill(tokenizer.pad_token_id), zeros = Array(count).fill(0);
    ids.push(...(tokenizer.padding_side === 'left' ? [...padding, ...input] : [...input, ...padding]));
    masks.push(...(tokenizer.padding_side === 'left' ? [...zeros, ...mask] : [...mask, ...zeros]));
  }
  return { input_ids: new Tensor('int64', BigInt64Array.from(ids, BigInt), [encodings.length, width]),
    attention_mask: new Tensor('int64', BigInt64Array.from(masks, BigInt), [encodings.length, width]) };
}

/** Optional native tokenization; retain the same tokenizer JSON, window, masks,
 * ONNX model and pooling. A missing/incompatible native runtime stays usable. */
export async function createFeatureEncoder({ extractor, runtime, loadTokenizer, enabled = true, onFallback = () => {} }) {
  const fallback = { kind: 'javascript', encode: texts => extractor(texts, options) };
  if (!enabled) return fallback;
  let native;
  try {
    const tokenizer = extractor.tokenizer;
    if (!Number.isInteger(tokenizer.model_max_length) || tokenizer.model_max_length > 32_000 || tokenizer.model_max_length < 2) {
      throw new Error('Tokenizer has no bounded model window.');
    }
    native = await loadTokenizer();
    native.disableTruncation();
    native.disablePadding();
    const expected = tokenizer(probes, { padding: true, truncation: true });
    const actual = tensors(await native.encodeBatch(probes), runtime.Tensor, tokenizer);
    const names = Object.keys(expected);
    if (names.length !== 2 || names.some(name => !actual[name] ||
        expected[name].dims.some((dimension, i) => dimension !== actual[name].dims[i]) ||
        expected[name].data.length !== actual[name].data.length ||
        expected[name].data.some((value, i) => value !== actual[name].data[i]))) {
      throw new Error('Native tokenizer differs from the configured tokenizer.');
    }
  } catch (error) {
    onFallback(error);
    return fallback;
  }
  return { kind: 'native', async encode(texts) {
    let inputs;
    try { inputs = tensors(await native.encodeBatch(texts), runtime.Tensor, extractor.tokenizer); }
    catch (error) { onFallback(error); return fallback.encode(texts); }
    const outputs = await extractor.model(inputs);
    const hidden = outputs.last_hidden_state ?? outputs.logits ?? outputs.token_embeddings;
    return runtime.mean_pooling(hidden, inputs.attention_mask).normalize(2, -1);
  } };
}
