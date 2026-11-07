import { once } from 'node:events';
import type { Server } from 'node:http';

/** Exercise the production HTTP transport on a kernel-assigned loopback port. */
export async function withLocalServer(server: Server, run: (url: string) => Promise<void>): Promise<void> {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Expected a TCP port.');
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve());
      server.closeAllConnections();
    });
  }
}
