import { createHash } from 'node:crypto';

/** Shared values are exact facts, not a newer verdict replacing old observations. */
export function encodeIntegrationFacts(value: unknown): string {
  const table = (item: unknown): unknown => {
    if (Array.isArray(item)) {
      if (item.length >= 16 && item.every(row => row && typeof row === 'object' && !Array.isArray(row))) {
        const columns = [...new Set(item.flatMap(row => Object.keys(row)))];
        return { $integrationTable: { columns, rows: item.map(row => columns.map(key =>
          Object.hasOwn(row, key) ? table(row[key]) : { $integrationMissing: true })) } };
      }
      return item.map(table);
    }
    if (item && typeof item === 'object') return Object.fromEntries(Object.entries(item).map(([key, next]) => [key, table(next)]));
    return item;
  };
  value = table(value);
  const counts = new Map<string, number>();
  const keyOf = (item: unknown): string | undefined => {
    if (typeof item === 'string' && item.length > 80) return JSON.stringify(item);
    if (item && typeof item === 'object' && !Array.isArray(item)) {
      const key = JSON.stringify(item);
      if (key.length > 96) return key;
    }
    return undefined;
  };
  const count = (item: unknown): void => {
    const key = keyOf(item);
    if (key) counts.set(key, (counts.get(key) ?? 0) + 1);
    if (Array.isArray(item)) item.forEach(count);
    else if (item && typeof item === 'object') Object.values(item).forEach(count);
  };
  count(value);
  const ids = new Map<string, string>();
  const sharedRecords: Record<string, unknown> = {};
  const project = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(intern);
    if (item && typeof item === 'object') return Object.fromEntries(Object.entries(item).map(([key, next]) => [key, intern(next)]));
    return item;
  };
  const intern = (item: unknown): unknown => {
    const key = keyOf(item);
    if (key && (counts.get(key) ?? 0) > 1) {
      let id = ids.get(key);
      if (!id) {
        id = `r${ids.size + 1}`;
        ids.set(key, id);
        sharedRecords[id] = project(item);
      }
      return { $ref: id };
    }
    return project(item);
  };
  const modules = intern(value);
  return JSON.stringify({ format: 'integration-shared-facts-v1', modules, sharedRecords });
}

/** Execution transcripts stay in the Host archive. Coverage, failures, cases,
 * revision reasons and public evidence are never treated as transcript fields. */
export function omitIntegrationTranscripts(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(omitIntegrationTranscripts);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => {
    if ((key === 'stdout' || key === 'stderr') && typeof item === 'string') {
      return [key, { hostArchiveOnly: true, bytes: Buffer.byteLength(item), sha256: createHash('sha256').update(item).digest('hex') }];
    }
    return [key, omitIntegrationTranscripts(item)];
  }));
}


/** Group identical execution facts by source file; every member retains its
 * original index, identity and full signature (prefix plus suffix). */
export function compactIntegrationCoverage(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(compactIntegrationCoverage);
  if (!value || typeof value !== 'object') return value;
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (key === 'functions' && Array.isArray(item) && item.length && item.every(row =>
      row && typeof row === 'object' && row.target && typeof row.target.path === 'string' && typeof row.target.name === 'string')) {
      const prefixes = new Map<string, string>();
      for (const row of item) {
        const path = row.target.path;
        const signature = typeof row.target.signature === 'string' ? row.target.signature : '';
        let prefix = prefixes.get(path);
        if (prefix === undefined) prefix = signature;
        else { let length = 0; while (length < prefix.length && length < signature.length && prefix[length] === signature[length]) length++; prefix = prefix.slice(0, length); }
        prefixes.set(path, prefix ?? '');
      }
      const groups = new Map<string, { path: string; signaturePrefix: string; facts: unknown; targets: unknown[][] }>();
      item.forEach((row, index) => {
        const { target, ...facts } = row;
        const signaturePrefix = prefixes.get(target.path)!;
        const identity = JSON.stringify([target.path, signaturePrefix, facts]);
        let group = groups.get(identity);
        if (!group) { group = { path: target.path, signaturePrefix, facts: compactIntegrationCoverage(facts), targets: [] }; groups.set(identity, group); }
        const extra = Object.fromEntries(Object.entries(target).filter(([field]) => !['path', 'name', 'signature'].includes(field)));
        group.targets.push([index, target.name, typeof target.signature === 'string' ? target.signature.slice(signaturePrefix.length) : null,
          ...(Object.keys(extra).length ? [extra] : [])]);
      });
      result[key] = { $functionGroups: [...groups.values()] };
    } else if (key === 'message' && typeof item === 'string' && /\n\s+at /.test(item)) {
      result[key] = item.split('\n').filter(line => !/^\s+at /.test(line)).join('\n');
      result.hostTrace = { sha256: createHash('sha256').update(item).digest('hex'), bytes: Buffer.byteLength(item),
        note: 'Full original message and stack retained in the Host archive.' };
    } else result[key] = compactIntegrationCoverage(item);
  }
  return result;
}


/** Mapping gaps refer to already-preserved verifier identities instead of
 * repeating every path and qualified signature a second time. */
export function compactIntegrationMappings(value: unknown): unknown {
  if (!Array.isArray(value)) return value;
  return value.map(module => {
    const functions = module.verification?.functions;
    const mapping = module.functionMapping;
    if (!Array.isArray(functions) || !mapping) return module;
    const identities = new Map(functions.map((entry: any, index: number) => [JSON.stringify(entry.target), index]));
    const signatures = new Map(functions.map((entry: any, index: number) => [entry.target?.signature, index]));
    const diagnosticGroups = new Map<string, { facts: unknown; references: number[][] }>();
    const otherDiagnostics: Array<{ index: number; diagnostic: unknown }> = [];
    (mapping.diagnostics ?? []).forEach((diagnostic: any, originalIndex: number) => {
      const index = signatures.get(diagnostic.targetApi);
      if (index === undefined) { otherDiagnostics.push({ index: originalIndex, diagnostic }); return; }
      const { targetApi, ...facts } = diagnostic;
      const key = JSON.stringify(facts);
      let group = diagnosticGroups.get(key);
      if (!group) { group = { facts, references: [] }; diagnosticGroups.set(key, group); }
      group.references.push([originalIndex, index as number]);
    });
    return { ...module, functionMapping: {
      format: 'verification-identity-references-v1',
      unmatchedFunctions: (mapping.unmatchedFunctions ?? []).map((target: unknown) => {
        const index = identities.get(JSON.stringify(target));
        return index === undefined ? { target } : index;
      }),
      diagnosticGroups: [...diagnosticGroups.values()], otherDiagnostics,
    } };
  });
}
