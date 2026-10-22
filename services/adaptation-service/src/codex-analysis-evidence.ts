import { createHash } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import { join } from 'node:path';

export const analysisEvidenceFile = 'CODEX_ANALYSIS_EVIDENCE.json';
const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
export interface AnalysisEvidence {
  version: 1;
  planSha256: string;
  entries: Array<{ path: string; sourceSha256: string; startLine: number; endLine: number; symbols: string[]; excerpt: string }>;
  omissions: string[];
}

/** Citations select context; all quoted bytes and versions are supplied by the host. */
export async function captureAnalysisEvidence(root: string, plan: string, allowed: ReadonlySet<string>): Promise<AnalysisEvidence> {
  const result: AnalysisEvidence = { version: 1, planSha256: digest(plan), entries: [], omissions: [] };
  const citations = /((?:target\/|history-view\/source\/)[^`\r\n|<>"()]*?\.[A-Za-z0-9]+):L?(\d+)(?:[-–]L?(\d+))?/g;
  const seen = new Set<string>();
  let remaining = 12000;
  for (const match of plan.matchAll(citations)) {
    if (result.omissions.length >= 20) break;
    const [path, first, last] = match.slice(1);
    const startLine = Number(first), requestedEnd = Number(last ?? first);
    const identity = `${path}:${startLine}-${requestedEnd}`;
    if (seen.has(identity)) continue;
    seen.add(identity);
    if (!allowed.has(path) || path.split('/').some(part => !part || part === '..' || part === '.') || path.includes('\\')) {
      result.omissions.push(`Unavailable citation: ${identity}`); continue;
    }
    if (!Number.isSafeInteger(startLine) || !Number.isSafeInteger(requestedEnd) || startLine < 1 || requestedEnd < startLine) {
      result.omissions.push(`Invalid line range: ${identity}`); continue;
    }
    if (result.entries.length >= 16 || remaining <= 0) { result.omissions.push('Evidence excerpt budget reached; read further sources on demand.'); break; }
    const bytes = await readFile(join(root, path));
    const text = bytes.toString('utf8');
    if (!Buffer.from(text, 'utf8').equals(bytes) || text.includes('\0')) { result.omissions.push(`Not UTF-8 source: ${path}`); continue; }
    const lines = text.split(/\r?\n/);
    if (startLine > lines.length) { result.omissions.push(`Line not found: ${identity}`); continue; }
    let endLine = Math.min(requestedEnd, startLine + 79, lines.length);
    let excerpt = lines.slice(startLine - 1, endLine).join('\n');
    while (excerpt.length > remaining && endLine > startLine) { endLine--; excerpt = lines.slice(startLine - 1, endLine).join('\n'); }
    if (excerpt.length > remaining) { result.omissions.push(`Excerpt too large: ${identity}`); continue; }
    if (endLine < requestedEnd) result.omissions.push(`Partial citation ${identity}; supplied through line ${endLine}. Read remaining lines when needed.`);
    const symbols = [...new Set([...excerpt.matchAll(/\b(?:class|interface|record|struct|enum|function|def)\s+([A-Za-z_]\w*)|\b([A-Z][A-Za-z0-9_]*)\s*\(/g)].map(value => value[1] ?? value[2]))];
    result.entries.push({ path, sourceSha256: digest(bytes), startLine, endLine, symbols, excerpt });
    remaining -= excerpt.length;
  }
  return result;
}

/** Compilation repairs and resumed work must not reuse excerpts from older source bytes. */
export async function refreshAnalysisEvidence(root: string, plan: string, evidence: AnalysisEvidence): Promise<AnalysisEvidence & { stalePaths: string[] }> {
  if (evidence.version !== 1 || evidence.planSha256 !== digest(plan) || !Array.isArray(evidence.entries) || !Array.isArray(evidence.omissions)) {
    throw new Error('Analysis evidence does not match the implementation plan.');
  }
  const result = { ...evidence, entries: [] as AnalysisEvidence['entries'], stalePaths: [] as string[] };
  for (const entry of evidence.entries) {
    if (!/^(?:target\/|history-view\/source\/)/.test(entry.path) || entry.path.split('/').some(part => !part || part === '.' || part === '..') || /[\\:\x00-\x1f]/.test(entry.path)) {
      throw new Error('Invalid analysis evidence path.');
    }
    let bytes: Buffer;
    try {
      const file = join(root, entry.path);
      if (!(await lstat(file)).isFile()) throw new Error('Evidence source is not a file.');
      bytes = await readFile(file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      result.stalePaths.push(entry.path); continue;
    }
    const excerpt = bytes.toString('utf8').split(/\r?\n/).slice(entry.startLine - 1, entry.endLine).join('\n');
    if (digest(bytes) !== entry.sourceSha256 || excerpt !== entry.excerpt) result.stalePaths.push(entry.path);
    else result.entries.push(entry);
  }
  return result;
}

export const analysisEvidenceInstructions = `Read ${analysisEvidenceFile} for host-checked source excerpts, line ranges, symbols and SHA-256 versions selected by the Analyzer. Start from these excerpts and read the current target files before editing. Expand source reads only for missing context or to verify a relevant call chain. Excerpts are source observations, not proof that the Analyzer's interpretation is correct. An empty packet or omitted/stale path requires a fresh source read. Full source access and cross-module verification remain available.`;
