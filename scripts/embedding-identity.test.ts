import { expect, it, vi } from 'vitest';
import { inferEmbeddingVariant } from './embedding-identity.mjs';

it.each([['dml', 'fp16'], ['cuda', 'fp16'], ['cpu', 'fp32']])('reads %s/%s identity from the actual endpoint', async (device, dtype) => {
  const request = vi.fn(async () => Response.json({ ready: true, device, dtype }));
  expect(await inferEmbeddingVariant('http://127.0.0.1:4021/v1/embeddings', request)).toBe(`${device}-${dtype}`);
  expect(String(request.mock.calls[0]![0])).toBe('http://127.0.0.1:4021/health');
});

it('refuses an unknown identity before vectors can be mislabeled', async () => {
  await expect(inferEmbeddingVariant('http://localhost:4021/v1/embeddings', async () => Response.json({ ready: true })))
    .rejects.toThrow('device and dtype');
});
