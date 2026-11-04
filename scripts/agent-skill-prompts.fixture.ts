// Migration fixture: exercise the real prompt builders without launching a model.
import { createHash } from 'node:crypto';
import { CodexWorkspaceTranslationRuntime } from '../services/adaptation-service/src/codex-workspace-translation-runtime';
import { codexPatchInstructions } from '../services/adaptation-service/src/codex-patch-tool';
import { createFinalReportTask } from '../services/translation-verifier/src/strategies/single-agent/strategy';
import { createFunctionGroupFinalReportTask, createRequirementFunctionGroupFinalReportTask } from '../services/translation-verifier/src/strategies/single-agent-function-group/strategy';
import { withRuntimeInstructions } from '../services/translation-verifier/src/host/agent/langchain-runtime';

export function promptFingerprints(): Record<string, string> {
  const result: Record<string, string> = {};
  const record = (key: string, value: string) => {
    // Host supplies the platform-specific executable; that helper is not migrated.
    result[key] = createHash('sha256').update(value.replace(codexPatchInstructions(), '<host-patch-instructions>')).digest('hex');
  };
  // These private builders are intentionally exercised in isolation from disk/process IO.
  const runtime = Object.assign(Object.create(CodexWorkspaceTranslationRuntime.prototype), {
    files: { root: '/project' }, options: { compileCommand: { executable: 'node', args: ['build.cjs'] }, verification: { protectedFiles: ['secret.test.ts'] } },
  });
  for (const integration of [false, true]) for (const rich of [false, true]) for (const retry of [false, true]) for (const protocol of ['none', 'global', 'module']) {
    const request = {
      spec: '需求：实现 /project/src/main.ts\nPreserve tenant isolation. ' + (rich ? 'Long context 中文\n'.repeat(2500) : ''),
      taskKind: integration ? 'project-integration' : undefined,
      workspaceFiles: rich ? ['src/main.ts', 'src/contracts.ts'] : [], writeFiles: ['src/main.ts'],
      ...(protocol !== 'none' ? { globalProtocol: { rules: ['global rule'] } } : {}),
      ...(protocol === 'module' ? { moduleProtocol: { rules: ['module rule'] } } : {}),
      ...(rich ? { historyView: { candidates: [{ prefix: 'one', moduleId: 'legacy', name: '历史', language: 'C++' }, { prefix: 'two', moduleId: 'other' }] } } : {}),
    };
    const plan = { summary: 'plan', mappings: [], steps: [], dependencies: [], ...(rich ? { markdown: '# Plan\nRead exact symbols.' } : {}) };
    const compilation = retry ? { output: '/project/src/main.ts error secret.test.ts\n' + 'x'.repeat(13000) } : undefined;
    const feedback = retry ? { reason: 'Valid assertion failed', evidence: ['tenant mismatch'] } : undefined;
    const key = `${integration ? 'integration' : 'module'}-${rich ? 'rich' : 'minimal'}-${retry ? 'retry' : 'initial'}-${protocol}`;
    record(`analyzer-${key}`, runtime.analyzerPrompt(request, 'history-view'));
    record(`translator-${key}`, runtime.translatorPrompt(request, 'history-view', plan, compilation, feedback));
    record(`direct-${key}`, runtime.directTranslatorPrompt(request, 'history-view', plan, compilation, feedback));
    record(`integration-${key}`, runtime.integrationPrompt(request, compilation));
  }
  const target = { path: 'src/main.ts', name: 'execute', signature: 'execute(input)' };
  const source = { path: 'legacy/main.cpp', name: 'execute', signature: 'execute(input)' };
  const common = { sourceLanguage: 'C++', targetLanguage: 'TypeScript', sourceProjectPath: '/history', targetProjectPath: '/project', requirement: '保持行为', functions: [{ source, target }], moduleProtocol: { rules: [] } };
  const tasks = {
    single: createFinalReportTask({ ...common, subject: { sourceFunction: source, targetFunction: target, requirement: common.requirement }, analysisReport: {}, migrationPlan: {}, translation: { round: 2 } } as unknown as Parameters<typeof createFinalReportTask>[0]),
    group: createFunctionGroupFinalReportTask(common as unknown as Parameters<typeof createFunctionGroupFinalReportTask>[0]),
    requirement: createRequirementFunctionGroupFinalReportTask(common as unknown as Parameters<typeof createRequirementFunctionGroupFinalReportTask>[0]),
  };
  for (const [mode, task] of Object.entries(tasks)) {
    record(`verifier-${mode}-system`, task.systemPrompt);
    record(`verifier-${mode}-user`, task.userPrompt);
    record(`verifier-${mode}-host`, withRuntimeInstructions(task.systemPrompt, { testRunner: 'vitest', testRoots: ['.recast-tests/module'] } as Parameters<typeof withRuntimeInstructions>[1], ['- Setup: node installed']));
  }
  return result;
}
