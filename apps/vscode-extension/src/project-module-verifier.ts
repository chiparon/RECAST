import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ModuleProtocol, SearchCandidate, WorkspaceHistoryView } from '@forexplore/contracts';
import { buildModuleFunctionMapping, discoverExecutableFunctions, expandClassLevelFunctions } from '../../../scripts/module-function-mapping';




import type { FunctionGroupVerificationInput, RequirementFunctionGroupVerificationInput, FunctionGroupVerificationResult } from '../../../services/translation-verifier/src/types';
import type { ProjectPipelineModule } from './project-pipeline-types';
import type { TestRetention, RetainedTestSuite, VerificationTestEvidence } from '../../../services/translation-verifier/src/types';

// Match the extension's existing runtime bridges: backend implementations are bundled,
// while their independent TypeScript projects retain their own compiler options.
export interface PipelineModel { apiKey: string; apiBase: string; model: string }
export interface PipelineModuleVerification {
  disposition: 'verified' | 'not-applicable' | 'production-defect' | 'test-environment' | 'agent-uncertain';
  mode: 'requirement' | 'translation-fidelity';
  result?: FunctionGroupVerificationResult;
  attempts: FunctionGroupVerificationResult[];
  /** The complete assembled project hash, not just the module's owned files. */
  sourceHash?: string;
  testSuite?: RetainedTestSuite;
}

export function verifierDisposition(result: FunctionGroupVerificationResult): PipelineModuleVerification['disposition'] {
  if (result.status === 'success') return result.testEvidence?.failures.some(item => item.status === 'unresolved') ? 'agent-uncertain' : 'verified';
  if (result.issue?.kind === 'test' || result.issue?.kind === 'environment' || ['test-environment-failure', 'coverage-unavailable'].includes(result.reason ?? '')) return 'test-environment';
  if (result.issue?.kind === 'unknown' || ['agent-timeout', 'model-failure', 'mapping-invalid'].includes(result.reason ?? '')) return 'agent-uncertain';
  return 'production-defect';
}

/** The same function mapping and function-group Host used by the offline pipeline. */
export async function verifyPipelineModule(input: {
  root: string; module: ProjectPipelineModule; requirement: string; model: PipelineModel;
  candidates: SearchCandidate[]; historyView?: WorkspaceHistoryView; protocol?: ModuleProtocol;
  signal: AbortSignal; previous?: PipelineModuleVerification; log(message: string): void;
  retainTests?: TestRetention;
  testEvidence?: VerificationTestEvidence;
}): Promise<PipelineModuleVerification> {
  const { createAgentHost } = require('../../../services/translation-verifier/src/host/runtime') as {
    createAgentHost(options: { modelClient: unknown; signal: AbortSignal; retainTests?: TestRetention; workLogger(event: { event: string }): void }): unknown;
  };
  const { createTranslationVerifierModelClient } = require('../../../services/translation-verifier/src/host/model-client') as {
    createTranslationVerifierModelClient(options: PipelineModel & { maxOutputTokens: number; onOutputLimitRetry(attempt: number, maxRetries: number): void }): unknown;
  };
  const { createFunctionGroupVerifier } = require('../../../services/translation-verifier/src/function-group-verify') as {
    createFunctionGroupVerifier(host: unknown): (input: FunctionGroupVerificationInput | RequirementFunctionGroupVerificationInput, strategy: 'single-agent-function-group' | 'requirement-function-group', phase: 'verify') => Promise<FunctionGroupVerificationResult>;
  };

  input.signal.throwIfAborted();
  const files = [...new Set([...(input.module.target.module?.sourceFiles ?? []), ...(input.module.changedFiles ?? [])])];
  const contents = Object.fromEntries(await Promise.all(files.map(async file => [file, await readFile(join(input.root, file), 'utf8')])));
  const sourceModules = input.candidates.flatMap(candidate => {
    const source = candidate.sourceModule; if (!source) return [];
    const view = input.historyView?.candidates?.find(view => view.repositoryId === source.repositoryId && view.analysisRevision === source.analysisRevision && view.moduleId === source.moduleId);
    return [{ sourceFiles: (source.sourceFiles ?? []).map(file => view?.prefix ? `${view.prefix}/${file}` : file).filter(file => input.historyView?.files.includes(file)), coreApis: source.coreApis ?? [] }];
  });
  const discovered = discoverExecutableFunctions(contents);
  const mapping = buildModuleFunctionMapping({ id: input.module.id, name: input.module.name, kind: 'feature', description: input.module.name, dependsOn: [], evidenceIds: [], symbolKeys: [], sourceFiles: files, coreApis: input.module.target.module?.coreApis ?? [] },
    { sourceFiles: sourceModules.flatMap(module => module.sourceFiles), coreApis: sourceModules.flatMap(module => module.coreApis) }, contents, discovered.length ? discovered : undefined);
  mapping.unmatchedFunctions = expandClassLevelFunctions(mapping.unmatchedFunctions, file => contents[file]);
  const fidelity = Boolean(input.historyView && mapping.functions.length && !mapping.unmatchedFunctions.length && input.candidates.every(candidate => candidate.language === input.candidates[0]?.language));
  const mode = fidelity ? 'translation-fidelity' : 'requirement';
  const functions = [...mapping.unmatchedFunctions, ...mapping.functions.map(item => item.target)];
  const attempts = [...(input.previous?.attempts ?? [])];
  if (!functions.length) return { mode, attempts, disposition: mapping.nonExecutableFunctions.length ? 'not-applicable' : 'agent-uncertain' };
  const host = createAgentHost({
    modelClient: createTranslationVerifierModelClient({ ...input.model, maxOutputTokens: 16_384,
      onOutputLimitRetry: (attempt, maxRetries) => input.log(`Verifier 单次输出达到 Token 上限，已丢弃不完整回复，正在小步重试（${attempt}/${maxRetries}）`),
    }), signal: input.signal,
    retainTests: input.retainTests,
    workLogger: event => { if (event.event === 'run.started' || event.event === 'run.completed') input.log(`Verifier：${event.event}`); },
  });
  const previousEvidence = input.testEvidence ?? input.previous?.result?.testEvidence;
  const common = { schemaVersion: '3.1' as const, targetLanguage: input.module.target.language,
    targetProjectPath: input.root, requirement: input.requirement, moduleProtocol: input.protocol,
    ...(previousEvidence ? { testEvidence: previousEvidence } : {}) };
  let result: FunctionGroupVerificationResult;
  try {
    result = await createFunctionGroupVerifier(host)(fidelity ? {
      ...common, sourceLanguage: input.candidates[0]!.language, sourceProjectPath: join(input.historyView!.root, 'source'), functions: mapping.functions,
    } : { ...common, mode: 'requirement', sourceLanguage: input.module.target.language, functions: functions.map(target => ({ target })) },
    fidelity ? 'single-agent-function-group' : 'requirement-function-group', 'verify');
  } catch (error) {
    input.signal.throwIfAborted();
    const description = error instanceof Error ? error.message : String(error);
    const reason = /budget|exhausted|timeout/i.test(description) ? 'agent-timeout' : /model|completion|api key/i.test(description) ? 'model-failure' : 'test-environment-failure';
    const testEvidence = (error as { testEvidence?: FunctionGroupVerificationResult['testEvidence'] })?.testEvidence ?? common.testEvidence;
    result = { status: 'failure', reason, issue: { kind: reason === 'test-environment-failure' ? 'environment' : 'unknown', description },
      ...(testEvidence ? { testEvidence } : {}), functions: functions.map(target => ({ target, status: 'unverified', executed: false, lineCoverage: null, branchCoverage: null, reason })) };
  }
  input.signal.throwIfAborted();
  attempts.push(result);
  return { mode, result, attempts, disposition: verifierDisposition(result) };
}
