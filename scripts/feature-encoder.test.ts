import { expect, it, vi } from 'vitest';
import { createFeatureEncoder } from './feature-encoder.mjs';

class Tensor {
  constructor(public type: string, public data: BigInt64Array, public dims: number[]) {}
}

function fixture() {
  const encode = (texts: string[]) => texts.map(text => {
    const ids = text ? [0, text.length, 2] : [0, 2];
    return { getIds: () => ids, getAttentionMask: () => ids.map(() => 1) };
  });
  const tokenize = (texts: string[]) => {
    const width = Math.min(extractor.tokenizer.model_max_length, Math.max(...encode(texts).map(x => x.getIds().length)));
    const values = encode(texts).map(x => {
      const ids = x.getIds().slice(0, width), mask = ids.map(() => 1), missing = width - ids.length;
      return extractor.tokenizer.padding_side === 'left' ? { ids: [...Array(missing).fill(1), ...ids], mask: [...Array(missing).fill(0), ...mask] }
        : { ids: [...ids, ...Array(missing).fill(1)], mask: [...mask, ...Array(missing).fill(0)] };
    });
    return { input_ids: new Tensor('int64', BigInt64Array.from(values.flatMap(x => x.ids), BigInt), [texts.length, width]),
      attention_mask: new Tensor('int64', BigInt64Array.from(values.flatMap(x => x.mask), BigInt), [texts.length, width]) };
  };
  const extractor = Object.assign(vi.fn(async () => 'original-output'), {
    tokenizer: Object.assign(vi.fn(tokenize), { model_max_length: 512, pad_token_id: 1, pad_token: '<pad>', padding_side: 'right' }),
    model: vi.fn(async (_inputs: unknown) => ({ last_hidden_state: 'same-model-output' })),
  });
  const normalize = vi.fn(() => 'native-output');
  const runtime = { Tensor, mean_pooling: vi.fn(() => ({ normalize })) };
  const native = { disableTruncation: vi.fn(), disablePadding: vi.fn(), encodeBatch: vi.fn(async (texts: string[]) => encode(texts)) };
  const loadTokenizer = vi.fn(async () => native);
  const onFallback = vi.fn();
  return { extractor, runtime, native, loadTokenizer, onFallback, normalize };
}

it('keeps token order, int64 masks, model and pooling on the validated native path', async () => {
  const f = fixture();
  const encoder = await createFeatureEncoder(f);
  expect(encoder.kind).toBe('native');
  expect(f.native.disableTruncation).toHaveBeenCalledOnce();
  expect(f.native.disablePadding).toHaveBeenCalledOnce();
  expect(await encoder.encode(['first', '第二个'])).toBe('native-output');
  const inputs = f.extractor.model.mock.calls[0]![0] as unknown as { input_ids: Tensor; attention_mask: Tensor };
  expect([...inputs.input_ids.data]).toEqual([0n, 5n, 2n, 0n, 3n, 2n]);
  expect([...inputs.attention_mask.data]).toEqual([1n, 1n, 1n, 1n, 1n, 1n]);
  expect(inputs.input_ids.dims).toEqual([2, 3]);
  expect(f.runtime.mean_pooling).toHaveBeenCalledWith('same-model-output', inputs.attention_mask);
  expect(f.normalize).toHaveBeenCalledWith(2, -1);
  expect(f.extractor).not.toHaveBeenCalled();
});

it('uses the original tokenizer if native loading or equivalence checking fails', async () => {
  for (const failure of ['missing', 'incompatible']) {
    const f = fixture();
    if (failure === 'missing') f.loadTokenizer.mockRejectedValue(new Error('unsupported native architecture'));
    else f.native.encodeBatch.mockResolvedValue([{ getIds: () => [99], getAttentionMask: () => [1] }]);
    const encoder = await createFeatureEncoder(f);
    expect(encoder.kind).toBe('javascript');
    expect(await encoder.encode(['input'])).toBe('original-output');
    expect(f.onFallback).toHaveBeenCalledOnce();
    expect(f.extractor.model).not.toHaveBeenCalled();
  }
});

it('preserves legacy prefix truncation and left padding instead of native EOS retention', async () => {
  const f = fixture();
  f.extractor.tokenizer.model_max_length = 2;
  const encoder = await createFeatureEncoder(f);
  expect(encoder.kind).toBe('native');
  await encoder.encode(['long']);
  expect([...(f.extractor.model.mock.calls[0]![0] as { input_ids: Tensor }).input_ids.data]).toEqual([0n, 4n]);
  const left = fixture();
  left.extractor.tokenizer.padding_side = 'left';
  const leftEncoder = await createFeatureEncoder(left);
  await leftEncoder.encode(['long', '']);
  const inputs = left.extractor.model.mock.calls[0]![0] as { input_ids: Tensor; attention_mask: Tensor };
  expect([...inputs.input_ids.data]).toEqual([0n, 4n, 2n, 1n, 0n, 2n]);
  expect([...inputs.attention_mask.data]).toEqual([1n, 1n, 1n, 0n, 1n, 1n]);
});

it('falls back for a failed native batch and preserves model failures', async () => {
  const f = fixture();
  const encoder = await createFeatureEncoder(f);
  f.native.encodeBatch.mockRejectedValueOnce(new Error('native cannot encode input'));
  expect(await encoder.encode(['input'])).toBe('original-output');
  const failure = new Error('model runtime unavailable');
  f.extractor.model.mockRejectedValueOnce(failure);
  await expect(encoder.encode(['input'])).rejects.toBe(failure);
  expect(f.extractor).toHaveBeenCalledOnce();
});

it('keeps custom model encoders usable without loading the optional native runtime', async () => {
  const f = fixture();
  const encoder = await createFeatureEncoder({ ...f, enabled: false });
  expect(await encoder.encode(['input'])).toBe('original-output');
  expect(f.loadTokenizer).not.toHaveBeenCalled();
});
