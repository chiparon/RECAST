import type { WorkspaceTranslationContext } from '@forexplore/contracts';

/** Decode the bounded transport projection for targeted, ordinary JSON queries.
 * This changes presentation only; all observations retain their original status. */
export function decodeIntegrationFacts(payload: any): any {
  const shared = payload?.format === 'integration-shared-facts-v1' ? payload.sharedRecords : {};
  const expand = (value: any): any => {
    if (Array.isArray(value)) return value.map(expand);
    if (!value || typeof value !== 'object') return value;
    if (Object.keys(value).length === 1 && typeof value.$ref === 'string') {
      if (!Object.hasOwn(shared, value.$ref)) throw new Error('Missing Integration shared fact: ' + value.$ref);
      return expand(shared[value.$ref]);
    }
    if (value.$integrationTable && Object.keys(value).length === 1) {
      const { columns, rows } = expand(value.$integrationTable);
      return rows.map((row: any[]) => Object.fromEntries(columns.flatMap((key: string, index: number) =>
        row[index]?.$integrationMissing === true ? [] : [[key, expand(row[index])]])));
    }
    if (value.$functionGroups && Object.keys(value).length === 1) {
      const functions: any[] = [];
      for (const raw of expand(value.$functionGroups)) {
        const group = expand(raw);
        for (const [index, name, suffix, extra] of group.targets) functions[index] = {
          target: { path: group.path, name, ...(suffix === null ? {} : { signature: group.signaturePrefix + suffix }), ...extra }, ...group.facts,
        };
      }
      return functions;
    }
    return Object.fromEntries(Object.entries(value).map(([key, next]) => [key, expand(next)]));
  };
  return expand(payload?.format === 'integration-shared-facts-v1' ? payload.modules : payload);
}

export function prepareIntegrationHostFacts(context: readonly WorkspaceTranslationContext[]): {
  modules: any[]; failureReview: { failureCount: number; instructions: string; failures: any[] };
} {
  const content = context.find(item => item.id === 'integration-verification-history')?.content;
  let modules: any[] = [];
  if (content) {
    const start = content.search(/(?:^|\n)(?:\{"format":"integration-shared-facts-v1"|\[)/);
    if (start < 0) throw new Error('Integration Host facts have no structured payload.');
    modules = decodeIntegrationFacts(JSON.parse(content.slice(start).trim()));
    if (!Array.isArray(modules)) throw new Error('Integration Host facts must contain a module array.');
  }
  const failures = new Map<string, any>();
  modules.forEach((module, moduleIndex) => {
    const observations = [
      { verification: module.verification ?? (module.testEvidence ? { testEvidence: module.testEvidence } : undefined), location: module.verification ? `/modules/${moduleIndex}/verification` : `/modules/${moduleIndex}`, current: true },
      ...(module.attempts ?? []).map((verification: any, index: number) => ({ verification, location: `/modules/${moduleIndex}/attempts/${index}`, current: false })),
    ];
    for (const observation of observations) {
      (observation.verification?.testEvidence?.failures ?? []).forEach((failure: any, index: number) => {
        const identity = JSON.stringify([module.moduleId, failure.id]);
        let entry = failures.get(identity);
        if (!entry) {
          entry = { moduleId: module.moduleId, failureId: failure.id, testId: failure.testId,
            originalMessage: failure.message, observations: [] };
          failures.set(identity, entry);
        }
        entry.observations.push({ pointer: `${observation.location}/testEvidence/failures/${index}`,
          current: observation.current, runId: failure.runId, status: failure.status });
      });
    }
  });
  const review = [...failures.values()].filter(entry => entry.observations.some((item: any) => item.status === 'unresolved'));
  return { modules, failureReview: { failureCount: review.length,
    instructions: 'Review every retained unresolved failure against public requirements. Historical statuses are observations, not current verdicts. Preserve original expectations and any correction rationale. Agent conclusions require independent Host replay; do not rewrite these facts.', failures: review } };
}
