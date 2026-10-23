import 'dotenv/config';
import { ModelModuleHierarchyPlanner } from '@forexplore/code-intelligence-service/module-hierarchy-planner';
import { loadConfig } from './config.js';
import { completeWithDeepSeek, completeWithDeepSeekTools } from './deepseek-client.js';
import { deepSeekModelConfig } from './model-config.js';
import { observeAgentModelCall } from './agent-model-observer.js';
import { createHttpServer } from './http-server.js';
import { AdaptationAdapter } from './adaptation-adapter.js';
import { ArchitectAgent } from './architect-agent.js';
import { FileStaticAnalysisSnapshotStore } from './analysis-snapshot-store.js';
import { HttpSemanticQueryPort } from './http-semantic-query-port.js';
import { HttpWorkspaceEvidencePort } from './http-workspace-evidence-port.js';
import { WorkspaceTranslationRuntime } from './workspace-translation-runtime.js';
import { CodexWorkspaceTranslationRuntime } from './codex-workspace-translation-runtime.js';
import { prepareDeepSeekCodexHome } from './codex-experiment-home.js';
import { resolveModelApiKey } from './model-credential.js';
import { createWorkspaceTranslationModelClient } from './workspace-translation-agent.js';
import {
  createDeepSeekToolCallingArchitectClient,
  ToolCallingArchitectRuntime,
} from './tool-calling-architect-runtime.js';

let server: ReturnType<typeof createHttpServer> | undefined;
let workspaceTranslationRuntime: WorkspaceTranslationRuntime | CodexWorkspaceTranslationRuntime | undefined;

async function main(): Promise<void> {
  const config = loadConfig();
  if (config.workspaceTranslation) {
    if (config.workspaceTranslation.agent === 'codex') {
      const translation = config.workspaceTranslation;
      workspaceTranslationRuntime = new CodexWorkspaceTranslationRuntime({
        workspaceRoot: config.projectRoot,
        compileCommand: config.workspaceTranslation.compileCommand,
        verification: config.workspaceTranslation.verification,
        maxModelTurns: config.workspaceTranslation.maxModelTurns,
        timeoutMs: config.workspaceTranslation.timeoutMs,
        codexCommand: config.workspaceTranslation.codexCommand,
        codexModel: config.workspaceTranslation.codexModel,
        prepareCodexHome: () => prepareDeepSeekCodexHome({
          explicitHome: translation.codexHome,
          apiKey: translation.codexHome ? undefined : resolveModelApiKey(() => config.apiKey),
          model: translation.codexModel ?? 'deepseek-v4-pro',
          baseUrl: translation.codexBaseUrl ?? process.env.DEEPSEEK_API_BASE,
        }),
      });
    } else {
      workspaceTranslationRuntime = new WorkspaceTranslationRuntime({
        workspaceRoot: config.projectRoot,
        compileCommand: config.workspaceTranslation.compileCommand,
        verification: config.workspaceTranslation.verification,
        maxModelTurns: config.workspaceTranslation.maxModelTurns,
        timeoutMs: config.workspaceTranslation.timeoutMs,
        // Legacy mode retains bounded on-demand index evidence.
        ...(config.semanticQueryPort ? { evidence: { port: new HttpWorkspaceEvidencePort({
          endpoint: config.semanticQueryPort.endpoint,
          ...(config.semanticQueryPort.bearerToken ? { bearerToken: config.semanticQueryPort.bearerToken } : {}),
        }) } } : {}),
        client: createWorkspaceTranslationModelClient({ apiKey: () => config.apiKey, temperature: 0 }),
      });
    }
  }
  // Legacy /v1/module-plan remains snapshot-compatible. The semantic route is
  // explicitly opt-in and talks only to the VS Code host's read-only HTTP
  // SemanticQueryPort endpoint; this process never creates an index runtime.
  const semanticModel = createDeepSeekToolCallingArchitectClient({ apiKey: () => config.apiKey, temperature: 0 });
  const semanticArchitecturePort = config.semanticQueryPort
    ? new ToolCallingArchitectRuntime({
      queryPort: new HttpSemanticQueryPort(config.semanticQueryPort),
      client: { complete: (messages, tools, signal) => observeAgentModelCall({
        strategy: 'semantic', model: deepSeekModelConfig.model, inputChars: JSON.stringify({ messages, tools }).length,
      }, () => semanticModel.complete(messages, tools, signal), (result) => JSON.stringify(result).length, signal) },
    })
    : undefined;
  const httpServer = createHttpServer({
    adapter: new AdaptationAdapter({
      apiKey: () => config.apiKey,
      skeletonProjectPath: config.skeletonProjectPath,
      projectRoot: config.projectRoot,
    }),
    moduleHierarchyPlanner: new ModelModuleHierarchyPlanner({
      timeoutMs: 45_000,
      maxRepairs: 1,
      complete: (messages, signal) => observeAgentModelCall({
        strategy: 'hierarchy', model: deepSeekModelConfig.model, inputChars: JSON.stringify(messages).length,
      }, () => completeWithDeepSeek(messages, {
        apiKey: () => config.apiKey, temperature: 0, jsonMode: true,
      }, signal), (result) => result.length, signal),
    }),
    architecturePort: new ArchitectAgent({ apiKey: () => config.apiKey }),
    staticAnalysisSnapshots: new FileStaticAnalysisSnapshotStore({
      analysisRoot: config.analysisRoot,
    }),
    ...(semanticArchitecturePort ? { semanticArchitecturePort, semanticQueryUrl: config.semanticQueryPort!.endpoint } : {}),
    ...(workspaceTranslationRuntime && config.workspaceTranslation ? {
      workspaceTranslation: { runtime: workspaceTranslationRuntime, bearerToken: config.workspaceTranslation.bearerToken },
    } : {}),
    ...(config.moduleGeneration ? {
      moduleGeneration: {
        bearerToken: config.moduleGeneration.bearerToken,
        // The trusted host owns the repository, the isolated worktrees and the
        // compiler; this process only performs the credentialed model turn.
        complete: (turn, signal) => observeAgentModelCall({
          strategy: 'module-generation', model: deepSeekModelConfig.model,
          inputChars: JSON.stringify(turn.messages).length + JSON.stringify(turn.tools).length,
        }, () => completeWithDeepSeekTools(turn.messages, turn.tools, {
          apiKey: () => config.apiKey, temperature: 0,
        }, signal), (result) => JSON.stringify(result).length, signal),
      },
    } : {}),
    corsOrigin: config.corsOrigin,
  });
  server = httpServer;

  await new Promise<void>((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(config.port, config.host, () => {
      httpServer.removeListener('error', reject);
      const address = httpServer.address();
      const port = address && typeof address !== 'string' ? address.port : config.port;
      console.log(`Adaptation service listening on http://${config.host}:${port}`);
      process.send?.({ type: 'listening', port });
      console.log(`Target project: ${config.projectRoot}`);
      console.log(`Static analysis snapshots: ${config.analysisRoot}`);
      if (config.workspaceTranslation) console.log(`Workspace translation agent: ${config.workspaceTranslation.agent}${config.workspaceTranslation.codexModel ? ` (${config.workspaceTranslation.codexModel})` : ''}`);
      if (semanticArchitecturePort) console.log('Revision-scoped semantic module planning is enabled.');
      resolve();
    });
  });
}

let shutdownPromise: Promise<void> | undefined;
function shutdown(): Promise<void> { return shutdownPromise ??= closeRuntime(); }
async function closeRuntime(): Promise<void> {
  const activeServer = server;
  const closing = activeServer?.listening ? new Promise<void>((resolve, reject) => {
    activeServer.close((error) => (error ? reject(error) : resolve()));
    activeServer.closeIdleConnections();
  }) : undefined;
  await workspaceTranslationRuntime?.shutdown();
  await closing;
}

function requestShutdown(): void {
  void shutdown().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

process.once('SIGINT', requestShutdown);
process.once('SIGTERM', requestShutdown);
process.once('disconnect', requestShutdown);
process.on('message', message => {
  if (!message || typeof message !== 'object' || !('type' in message)) return;
  if (message.type === 'shutdown') {
    void shutdown().catch(() => { process.exitCode = 1; }).finally(() => { if (process.connected) process.disconnect?.(); });
  } else if (message.type === 'shutdown-if-idle' && 'requestId' in message && typeof message.requestId === 'string') {
    const requestId = message.requestId;
    void (async () => {
      // Runtime closes admission synchronously before yielding. A request that
      // arrives during retirement cannot start a translation after this check.
      const idle = workspaceTranslationRuntime ? await workspaceTranslationRuntime.shutdownIfIdle() : true;
      process.send?.({ type: 'shutdown-if-idle-result', requestId, status: idle ? 'closing' : 'busy' });
      if (!idle) return;
      await shutdown();
      if (process.connected) process.disconnect?.();
    })().catch(() => {
      process.send?.({ type: 'shutdown-if-idle-result', requestId, status: 'error' });
    });
  }
});

void main().catch(async (error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error('Adaptation service failed to start:', message);
  process.exitCode = 1;
  if (process.connected) await new Promise<void>(resolve => {
    process.send?.({ type: 'startup-error', message }, () => resolve());
  });
  try { await shutdown(); }
  finally { if (process.connected) process.disconnect?.(); }
});
