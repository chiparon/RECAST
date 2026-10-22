import { readFile } from 'node:fs/promises';

/** A successful CLI launch is not proof that the extension's services started. */
export async function waitForExtensionStartup(reportPath, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    let report;
    try { report = JSON.parse(await readFile(reportPath, 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error; }
    if (report?.status === 'ready') return report;
    if (report?.status === 'error') throw new Error(`RECAST services failed: ${report.message}`);
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error('VS Code opened but RECAST did not confirm service readiness. Close the previous Extension Development Host and retry; see Output > RECAST.');
}
