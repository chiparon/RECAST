/** Bind new vectors to the device/precision actually serving the endpoint. */
export async function inferEmbeddingVariant(endpoint, request = fetch) {
  const response = await request(new URL('/health', endpoint), { signal: AbortSignal.timeout(5000) });
  if (!response.ok) throw new Error(`Embedding identity health check returned HTTP ${response.status}.`);
  const health = await response.json();
  if (health.ready !== true || ![health.device, health.dtype].every(value => typeof value === 'string' && /^[a-z0-9_-]{1,40}$/i.test(value))) {
    throw new Error('Embedding service must report its device and dtype; configure CODE_INTELLIGENCE_EMBEDDING_VARIANT explicitly for an external provider.');
  }
  return `${health.device}-${health.dtype}`;
}
