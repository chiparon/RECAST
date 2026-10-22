import { describe, expect, it } from 'vitest';
import { isHostToWebviewMessage, isWebviewToHostMessage, webviewMessageRejectionReason } from './messages';

describe('Project pipeline intent boundary', () => {
  const input = { repositoryId: 'repo', projectId: 'project', requirement: 'Implement gateway', topK: 4 };
  it('accepts project intent while refusing page-supplied paths, commands and oversized documents', () => {
    expect(isWebviewToHostMessage({ type: 'START_PROJECT_PIPELINE', input })).toBe(true);
    for (const extra of [{ workspaceRoot: 'C:/other' }, { command: 'arbitrary' }, { requirement: 'x'.repeat(8001) }, { mode: 'unknown' }]) {
      expect(isWebviewToHostMessage({ type: 'START_PROJECT_PIPELINE', input: { ...input, ...extra } })).toBe(false);
    }
  });
  it('only accepts supported actions and opaque action targets', () => {
    const action = { type: 'PROJECT_PIPELINE_ACTION', action: 'read', runId: '11111111-2222-3333-4444-555555555555' };
    expect(isWebviewToHostMessage(action)).toBe(true);
    expect(isWebviewToHostMessage({ ...action, action: 'unknown' })).toBe(false);
    expect(isWebviewToHostMessage({ ...action, action: 'export-report', destination: 'C:/arbitrary' })).toBe(false);
    expect(isWebviewToHostMessage({ ...action, action: 'resume' })).toBe(true);
    expect(isWebviewToHostMessage({ ...action, action: 'retry-module', moduleId: 'module-domain' })).toBe(true);
    expect(isWebviewToHostMessage({ ...action, action: 'retry-module' })).toBe(false);
    expect(isWebviewToHostMessage({ ...action, action: 'resume', moduleId: 'module-domain' })).toBe(false);
    expect(isWebviewToHostMessage({ ...action, action: 'retry-module', moduleId: '../output' })).toBe(false);
  });
});

describe('Module translation handoff boundary', () => {
  it('accepts the module target id the explorer actually produces', () => {
    // A module target id is a module:// URI (project-explorer.ts). Validating it
    // as an opaque id made the Webview drop every handoff, so the panel waited
    // with nothing running; this id is copied from a real host log line.
    const targetId = 'module://%5B%22repo-48af198d-3145-4df1-8c95-4ecf8a3da11b%22%2C%22analysis-32790094-a671-4360-9c11-2b1079534f77%22%2C%22project-a61821301eaff059b0967198%22%2C%22module-container-integration%22%5D';
    expect(isHostToWebviewMessage({ type: 'MODULE_TRANSLATION_READY', targetId,
      candidateId: 'module-b3f8374b0328a1c93bf058bc6dc27dedfb722e151820c69cb044d1523952dfa4',
      moduleScopeId: '591bc8318d7d6def2478fc7cd041c24ae81ad4ec8138880aa45bd236aaaa414d' })).toBe(true);
    // The same selection must stay acceptable in the other direction.
    expect(isWebviewToHostMessage({ type: 'SELECT_WORKSPACE_TARGET', targetId })).toBe(true);
  });

  it('still refuses an unusable correlation id or scope', () => {
    const base = { type: 'MODULE_TRANSLATION_READY', targetId: 'module://x', candidateId: 'c',
      moduleScopeId: 'a'.repeat(64) };
    expect(isHostToWebviewMessage(base)).toBe(true);
    expect(isHostToWebviewMessage({ ...base, targetId: '' })).toBe(false);
    expect(isHostToWebviewMessage({ ...base, targetId: 'module://x\u0000' })).toBe(false);
    expect(isHostToWebviewMessage({ ...base, candidateId: 'x'.repeat(513) })).toBe(false);
    expect(isHostToWebviewMessage({ ...base, moduleScopeId: 'not-a-scope' })).toBe(false);
  });
});

describe('Webview refusal reasons', () => {
  it('names the field that stopped a translation request instead of dropping it', () => {
    // A silent refusal left the workbench waiting for a reply nobody owed it.
    expect(isWebviewToHostMessage({ type: 'START_ADAPT', decisionNotes: 'ok' })).toBe(true);
    expect(webviewMessageRejectionReason({ type: 'START_ADAPT', decisionNotes: 'x'.repeat(8_001) }))
      .toBe('START_ADAPT 的决策说明 8001 字，超过 8000 字上限。');
    expect(webviewMessageRejectionReason({ type: 'START_ADAPT', decisionNotes: undefined }))
      .toBe('START_ADAPT 的决策说明必须是字符串。');
    expect(webviewMessageRejectionReason({ type: 'START_ADAPT', decisionNotes: 'ok', force: true }))
      .toBe('START_ADAPT 含未知字段：force。');
    expect(webviewMessageRejectionReason({ type: 'START_SEARCH', requirement: 'x' }))
      .toBe('START_SEARCH 的需求或 topK 无效。');
    expect(webviewMessageRejectionReason({ type: 'UNKNOWN_ACTION' }))
      .toBe('宿主不接受该 UNKNOWN_ACTION 消息。');
    expect(webviewMessageRejectionReason(null)).toBe('消息不是对象。');
  });
});

describe('Host message boundary', () => {
  it('accepts only known target-selection phases and outcomes', () => {
    expect(isHostToWebviewMessage({ type: 'TARGET_WORKSPACE_PROGRESS', phase: 'indexing', message: '正在建立索引…' })).toBe(true);
    expect(isHostToWebviewMessage({ type: 'TARGET_WORKSPACE_PROGRESS', phase: 'queued', message: 'x' })).toBe(false);
    expect(isHostToWebviewMessage({ type: 'TARGET_WORKSPACE_PROGRESS', phase: 'indexing' })).toBe(false);
    expect(isHostToWebviewMessage({ type: 'TARGET_WORKSPACE_RESULT', outcome: 'failed', mode: 'input', message: '失败' })).toBe(true);
    expect(isHostToWebviewMessage({ type: 'TARGET_WORKSPACE_RESULT', outcome: 'failed', mode: 'input' })).toBe(true);
    expect(isHostToWebviewMessage({ type: 'TARGET_WORKSPACE_RESULT', outcome: 'unknown', mode: 'input' })).toBe(false);
    expect(isHostToWebviewMessage({ type: 'TARGET_WORKSPACE_RESULT', outcome: 'failed', mode: 'elsewhere' })).toBe(false);
    expect(isHostToWebviewMessage({ type: 'TARGET_WORKSPACE_RESULT', outcome: 'failed', mode: 'input', message: 'x'.repeat(401) })).toBe(false);
  });
});

describe('Webview message boundary', () => {
  it('allows key configuration intent but never accepts a key or backend address from the Webview', () => {
    for (const type of ['CONFIGURE_MODEL_KEY', 'CLEAR_MODEL_KEY']) {
      expect(isWebviewToHostMessage({ type })).toBe(true);
      expect(isWebviewToHostMessage({ type, apiKey: 'secret' })).toBe(false);
      expect(isWebviewToHostMessage({ type, endpoint: 'https://external.example' })).toBe(false);
    }
  });
  it('accepts only scoped bounded module page intent without filesystem overrides', () => {
    const message = { type: 'LOAD_MODULE_CHILDREN', requestId: 'page-1', request: {
      repositoryId: 'repo-1', analysisRevision: 'revision-1', projectId: 'project-1', nodeId: 'file:src/index.ts', offset: 80,
    } };
    expect(isWebviewToHostMessage(message)).toBe(true);
    expect(isWebviewToHostMessage({ ...message, request: { ...message.request, nodeId: '$search', query: 'run', status: 'all' } })).toBe(true);
    expect(isWebviewToHostMessage({ ...message, request: { ...message.request, path: '/private' } })).toBe(false);
    expect(isWebviewToHostMessage({ ...message, request: { ...message.request, offset: -1 } })).toBe(false);
    expect(isWebviewToHostMessage({ ...message, request: { ...message.request, query: 'x'.repeat(201) } })).toBe(false);
    expect(isWebviewToHostMessage({ ...message, request: { ...message.request, status: 'unsupported' } })).toBe(false);
  });

  it('accepts bounded intent messages', () => {
    expect(isWebviewToHostMessage({ type: 'ADD_TARGET_WORKSPACE', mode: 'browse' })).toBe(true);
    expect(isWebviewToHostMessage({ type: 'ADD_TARGET_WORKSPACE', mode: 'input' })).toBe(true);
    expect(isWebviewToHostMessage({ type: 'ADD_TARGET_WORKSPACE', mode: 'workspace' })).toBe(true);
    expect(isWebviewToHostMessage({ type: 'ADD_TARGET_WORKSPACE', mode: ['workspace'] })).toBe(false);
    expect(isWebviewToHostMessage({ type: 'ADD_TARGET_WORKSPACE', mode: 'input', path: '/tmp' })).toBe(false);
    expect(
      isWebviewToHostMessage({
        type: 'START_SEARCH',
        requirement: '迁移报价缓存',
        topK: 4,
      }),
    ).toBe(true);
    expect(isWebviewToHostMessage({ type: 'SELECT_CANDIDATE', candidateId: 'java-quote-cache' })).toBe(true);
    expect(isWebviewToHostMessage({ type: 'APPLY_CURRENT_RUN' })).toBe(true);
    expect(isWebviewToHostMessage({ type: 'REFRESH_MODULE_EXPLORER' })).toBe(true);
    expect(isWebviewToHostMessage({ type: 'COPY_TARGET_PATH' })).toBe(true);
    expect(isWebviewToHostMessage({ type: 'REVEAL_TARGET_IN_EXPLORER' })).toBe(true);
    expect(
      isWebviewToHostMessage({
        type: 'SAVE_SETTINGS',
        settings: { topK: 6, repositoryPaths: ['D:/history/one', 'D:/history/two'] },
      }),
    ).toBe(true);
    expect(
      isWebviewToHostMessage({
        type: 'SELECT_WORKSPACE_TARGET',
        targetId: 'workspace://src/PaymentService.cs#L42',
      }),
    ).toBe(true);
    expect(
      isWebviewToHostMessage({
        type: 'SELECT_CODE_INTELLIGENCE_REVISION',
        repositoryId: 'repo-2dd9d4a2',
        analysisRevision: 'revision-33b87b6a',
      }),
    ).toBe(true);
  });

  it('rejects a Webview-supplied target, patch, file path, or old protocol action', () => {
    expect(
      isWebviewToHostMessage({
        type: 'START_SEARCH',
        requirement: '',
        topK: 4,
        request: { target: { path: '../../outside.cs' } },
      }),
    ).toBe(false);
    expect(isWebviewToHostMessage({ type: 'APPLY_PATCHES', files: [] })).toBe(false);
    expect(isWebviewToHostMessage({ type: 'OPEN_FILE', path: '/tmp/secret', line: 1 })).toBe(false);
    expect(isWebviewToHostMessage({ type: 'COPY_TARGET_PATH', path: '../../outside.cs' })).toBe(false);
    expect(isWebviewToHostMessage({ type: 'REVEAL_TARGET_IN_EXPLORER', path: '../../outside.cs' })).toBe(false);
    expect(
      isWebviewToHostMessage({
        type: 'SELECT_WORKSPACE_TARGET',
        targetId: 'workspace://safe.cs#L1',
        path: '../../outside.cs',
      }),
    ).toBe(false);
    expect(
      isWebviewToHostMessage({
        type: 'SELECT_CODE_INTELLIGENCE_REVISION',
        repositoryId: 'repo-2dd9d4a2',
        analysisRevision: 'revision-33b87b6a',
        localPath: 'C:\\private\\repository',
      }),
    ).toBe(false);
    expect(
      isWebviewToHostMessage({
        type: 'SELECT_CODE_INTELLIGENCE_REVISION',
        repositoryId: 'C:\\private\\repository',
        analysisRevision: 'revision-33b87b6a',
      }),
    ).toBe(false);
  });

  it('rejects unbounded or malformed intent payloads', () => {
    expect(
      isWebviewToHostMessage({
        type: 'START_SEARCH',
        requirement: 'x'.repeat(8_001),
        topK: 4,
      }),
    ).toBe(false);
    expect(
      isWebviewToHostMessage({
        type: 'START_SEARCH',
        requirement: '',
        topK: 11,
      }),
    ).toBe(false);
    expect(isWebviewToHostMessage({ type: 'SELECT_CANDIDATE', candidateId: '' })).toBe(false);
    expect(isWebviewToHostMessage({ type: 'SELECT_WORKSPACE_TARGET', targetId: '' })).toBe(false);
    expect(
      isWebviewToHostMessage({
        type: 'SELECT_CODE_INTELLIGENCE_REVISION',
        repositoryId: 'repo-2dd9d4a2',
        analysisRevision: '',
      }),
    ).toBe(false);
    expect(
      isWebviewToHostMessage({
        type: 'SELECT_CODE_INTELLIGENCE_REVISION',
        repositoryId: 'repo-2dd9d4a2',
        analysisRevision: '../revision',
      }),
    ).toBe(false);
    expect(isWebviewToHostMessage({ type: 'OPEN_REPOSITORY_SETTINGS' })).toBe(false);
    expect(
      isWebviewToHostMessage({
        type: 'SAVE_SETTINGS',
        settings: { topK: 0, repositoryPaths: [] },
      }),
    ).toBe(false);
    expect(
      isWebviewToHostMessage({
        type: 'SAVE_SETTINGS',
        settings: { topK: 4, repositoryPaths: Array.from({ length: 21 }, (_, index) => `D:/repo-${index}`) },
      }),
    ).toBe(false);
    expect(
      isWebviewToHostMessage({
        type: 'SAVE_SETTINGS',
        settings: { topK: 4, repositoryPaths: [''] },
      }),
    // An emptied draft row is ordinary input: the host drops it while saving
    // instead of discarding the user's whole edit at the boundary.
    ).toBe(true);
    expect(
      isWebviewToHostMessage({
        type: 'SAVE_SETTINGS',
        settings: { topK: 4, repositoryPaths: ['D:/ok', 'D:/bad\u0000'] },
      }),
    ).toBe(false);
  });
});
