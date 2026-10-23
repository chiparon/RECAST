import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { access, realpath } from 'node:fs/promises';
import path from 'node:path';
import { localFetch } from './local-fetch';

export interface BackendLaunchConfiguration {
  url: string; extensionPath: string; workspaceRoot: string; trusted: boolean; autoStart: boolean;
  semanticPort: number;
  /** Owned IDE backends ask the OS for a free port; external endpoints stay fixed. */
  dynamicPort?: boolean;
  /** A service-only bootstrap can serve planning before a target is selected. */
  workspaceTranslation?: boolean;
  compileCommand?: { executable: string; args: string[]; timeoutMs?: number };
  verification?: { command: { executable: string; args: string[]; timeoutMs?: number }; protectedFiles: string[] };
}
export interface BackendCapabilities {
  service: string; version: number; retrievalRerank: boolean; semanticPlanning: boolean;
  workspaceTranslation: boolean; workspaceRoot?: string; semanticQueryUrl?: string; workspaceAgent?: 'codex' | 'legacy';
}
class BackendProbeUnavailable extends Error {}

/** One owned child per extension host. Only an idle owned child can be replaced. */
export class BackendProcess {
  private child?: ChildProcess;
  private pending?: Promise<BackendCapabilities>;
  private ownedRoot?: string;
  private ownedOrigin?: string;
  private verified?: BackendCapabilities;
  private endpoint?: string;
  private lastProbeAt = 0;
  private probePending = false;
  private disposed = false;
  readonly translationToken = process.env.ADAPTATION_WORKSPACE_TRANSLATION_TOKEN || randomBytes(32).toString('hex');
  readonly moduleGenerationToken = process.env.ADAPTATION_MODULE_GENERATION_TOKEN || randomBytes(32).toString('hex');
  constructor(private readonly configuration: () => BackendLaunchConfiguration | Promise<BackendLaunchConfiguration>,
    private readonly log: (message: string) => void,
    private readonly launch: typeof spawn = spawn,
    private readonly transport: typeof localFetch = localFetch) {}

  get url(): string | undefined { return this.endpoint; }
  get healthPending(): boolean { return this.probePending; }

  private async probe(url: string): Promise<{ value?: BackendCapabilities; transient: boolean }> {
    try {
      const response = await this.transport(`${url.replace(/\/+$/, '')}/v1/capabilities`, { signal: AbortSignal.timeout(1500) });
      if (!response.ok) return { transient: response.status >= 500 || response.status === 408 || response.status === 429 };
      let value: BackendCapabilities;
      try { value = await response.json() as BackendCapabilities; } catch { return { transient: false }; }
      return { value: value.service === 'recast-adaptation' && value.version === 1 ? value : undefined, transient: false };
    } catch { return { transient: true }; }
  }

  async capabilities(url: string): Promise<BackendCapabilities | undefined> {
    return (await this.probe(url)).value;
  }

  private async validateEndpoint(config: BackendLaunchConfiguration, root: string, capabilities: BackendCapabilities): Promise<void> {
    if (!capabilities.retrievalRerank || !capabilities.semanticPlanning ||
        (config.workspaceTranslation !== false && !capabilities.workspaceTranslation)) {
      throw new Error('现有后端缺少重排、语义规划或工作区翻译能力，请更新后端。');
    }
    if (capabilities.semanticQueryUrl?.replace(/\/+$/, '') !== `http://127.0.0.1:${config.semanticPort}`) {
      throw new Error('现有后端绑定了另一窗口的语义查询端口；请为本窗口配置另一 adaptationApiUrl，或由本窗口自动启动后端。');
    }
    if (config.workspaceTranslation === false) {
      if (capabilities.workspaceTranslation) throw new Error('启动服务不应绑定目标工程。');
      return;
    }
    if (!capabilities.workspaceRoot || !sameWorkspace(await realpath(capabilities.workspaceRoot), root)) {
      throw new Error(`后端 ${new URL(config.url).origin} 绑定了其他目标工程或未声明目标；请为本窗口配置另一 adaptationApiUrl。`);
    }
    let authorized: Response;
    try {
      authorized = await this.transport(`${config.url.replace(/\/+$/, '')}/v1/workspace-translations/configuration`, {
        headers: { authorization: `Bearer ${this.translationToken}` }, signal: AbortSignal.timeout(1500),
      });
    } catch { throw new BackendProbeUnavailable('后端鉴权探测暂未响应。'); }
    if (!authorized.ok) {
      throw new Error(`后端鉴权失败（HTTP ${authorized.status}）：翻译令牌与本窗口不一致；请配置匹配的令牌或另一 adaptationApiUrl。`);
    }
    const configuration = await authorized.json() as { workspaceRoot?: string };
    if (!configuration.workspaceRoot || !sameWorkspace(await realpath(configuration.workspaceRoot), root)) {
      throw new Error('后端已鉴权的目标工程与本窗口不一致。');
    }
  }

  ensure(): Promise<BackendCapabilities> {
    if (this.disposed) return Promise.reject(new Error('Backend manager is disposed'));
    this.pending ??= this.start().finally(() => { this.pending = undefined; });
    return this.pending;
  }

  private async releaseIdleChild(): Promise<void> {
    const child = this.child;
    if (!child) return;
    if (!child.connected) throw new Error('后端控制连接暂不可用，保留现有任务；稍后会重试切换。');
    const requestId = randomBytes(16).toString('hex');
    await new Promise<void>((resolve, reject) => {
      const finish = (error?: Error) => {
        clearTimeout(timer);
        child.removeListener('exit', exited);
        child.removeListener('message', replied);
        if (error) reject(error); else resolve();
      };
      const exited = () => finish();
      const replied = (message: unknown) => {
        if (!message || typeof message !== 'object' || !('type' in message) || message.type !== 'shutdown-if-idle-result' ||
            !('requestId' in message) || message.requestId !== requestId || !('status' in message)) return;
        if (message.status === 'busy') finish(new Error('当前后端仍有翻译任务执行，完成或取消后会自动切换目标，无需关闭窗口。'));
        else if (message.status !== 'closing') finish(new Error('后端暂未完成空闲检查，保留现有任务；稍后会重试切换。'));
        // An accepted request still owns its port until the child has exited.
      };
      const timer = setTimeout(() => finish(new Error('后端正在完成原有请求，稍后会重试切换；现有任务已保留。')), 10_000);
      child.once('exit', exited);
      child.on('message', replied);
      try {
        child.send({ type: 'shutdown-if-idle', requestId }, error => { if (error) finish(new Error('后端控制连接暂不可用，保留现有任务；稍后会重试切换。')); });
      } catch { finish(new Error('后端控制连接暂不可用，保留现有任务；稍后会重试切换。')); }
    });
    this.log('原后端已空闲退出，正在应用当前目标与端口配置。');
  }

  private async start(): Promise<BackendCapabilities> {
    const config = await this.configuration();
    const url = new URL(config.url);
    if (!config.trusted) throw new Error('请先信任工作区，再启动模型后端。');
    const root = await realpath(config.workspaceRoot);
    const endpointOrigin = this.endpoint ? new URL(this.endpoint).origin : undefined;
    const originChanged = this.ownedOrigin !== url.origin && !(config.dynamicPort && endpointOrigin === url.origin);
    if (this.child && (!this.ownedRoot || !sameWorkspace(this.ownedRoot, root) || originChanged ||
        this.verified && (this.verified.workspaceTranslation !== (config.workspaceTranslation !== false) ||
          this.verified.semanticQueryUrl?.replace(/\/+$/, '') !== `http://127.0.0.1:${config.semanticPort}`))) {
      if (!config.autoStart) throw new Error('后端配置已变化，请启用自动启动以切换到当前目标与端口。');
      // The child checks and closes admission atomically. Never infer idleness
      // from a missed health probe or force-kill a target-bound process.
      await this.releaseIdleChild();
    }
    if (this.child && this.verified && this.endpoint) {
      if (Date.now() - this.lastProbeAt < 30_000) return this.verified;
      const child = this.child;
      let probe = await this.probe(this.endpoint);
      if (probe.transient) {
        await new Promise(resolve => setTimeout(resolve, 250));
        probe = await this.probe(this.endpoint);
      }
      if (this.disposed || this.child !== child || !this.verified) throw new Error('后端进程已退出。');
      if (!probe.value) {
        if (!probe.transient) throw new Error('模型后端返回了不兼容的能力信息。');
        // Previously authenticated, still-owned process: a missed probe is
        // unknown health, not evidence that it died. Try again in five seconds.
        this.probePending = true; this.lastProbeAt = Date.now() - 25_000;
        return this.verified;
      }
      if (JSON.stringify(probe.value) !== JSON.stringify(this.verified)) {
        await this.validateEndpoint({ ...config, url: this.endpoint }, root, probe.value);
      }
      this.probePending = false; this.lastProbeAt = Date.now();
      return this.verified = probe.value;
    }
    // A bootstrap has no workspace-authentication route. Only trust a child
    // this host starts; never attach it to an unverified external process.
    const existing = config.workspaceTranslation === false ? undefined : await this.capabilities(config.url);
    if (existing) {
      try {
        await this.validateEndpoint(config, root, existing);
        this.endpoint = config.url;
        return existing;
      } catch (error) {
        if (!config.autoStart || !config.dynamicPort) throw error;
        // Another window owns this address. Start our own isolated child.
      }
    }
    if (!config.autoStart) throw new Error('模型后端不可用，自动启动已关闭。');
    if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.username || url.password ||
        url.pathname !== '/' || url.search || url.hash) throw new Error('自动启动只支持本机 HTTP 根地址，例如 http://127.0.0.1:8788。');
    if (this.child) throw new Error('已启动的后端未通过能力检查，请查看 RECAST 输出后重启扩展。');
    const bundle = path.join(config.extensionPath, 'dist/extension/adaptation-server.cjs');
    await access(bundle);
    if (this.disposed) throw new Error('Backend manager is disposed');
    const compile = config.compileCommand ?? { executable: process.execPath,
      args: [path.join(config.extensionPath, 'dist/extension/workspace-compile.cjs')], timeoutMs: 120000 };
    const child = this.launch(process.execPath, [bundle], { cwd: root, shell: false, windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'], env: { ...process.env, ELECTRON_RUN_AS_NODE: '1',
        DOTENV_CONFIG_PATH: path.join(config.extensionPath, '.backend-no-env'),
        ADAPTATION_HOST: url.hostname === '[::1]' ? '::1' : '127.0.0.1', ADAPTATION_PORT: config.dynamicPort ? '0' : url.port || '80',
        ADAPTATION_PROJECT_ROOT: root, ADAPTATION_SKELETON_PROJECT_PATH: root,
        ADAPTATION_SEMANTIC_INDEX_ENABLED: 'true', SEMANTIC_QUERY_PORT_URL: `http://127.0.0.1:${config.semanticPort}`,
        ADAPTATION_WORKSPACE_TRANSLATION_ENABLED: config.workspaceTranslation === false ? 'false' : 'true', ADAPTATION_WORKSPACE_TRANSLATION_TOKEN: this.translationToken,
        ADAPTATION_MODULE_GENERATION_ENABLED: 'true', ADAPTATION_MODULE_GENERATION_TOKEN: this.moduleGenerationToken,
        ADAPTATION_WORKSPACE_COMPILE_COMMAND: JSON.stringify(compile),
        ADAPTATION_WORKSPACE_VERIFICATION: config.verification ? JSON.stringify(config.verification) : '',
      } });
    this.child = child; this.ownedRoot = root; this.ownedOrigin = url.origin;
    let failure: string | undefined;
    let listeningUrl = config.dynamicPort ? undefined : config.url;
    const clear = () => {
      if (this.child !== child) return;
      this.child = undefined; this.ownedRoot = undefined; this.ownedOrigin = undefined;
      this.verified = undefined; this.endpoint = undefined; this.probePending = false;
      this.lastProbeAt = 0;
    };
    child.once('error', error => {
      failure = `后端进程启动失败：${error.message}`;
      clear();
    });
    child.on('message', message => {
      if (config.dynamicPort && message && typeof message === 'object' && 'type' in message && message.type === 'listening' &&
          'port' in message && typeof message.port === 'number' && Number.isInteger(message.port) && message.port > 0 && message.port <= 65535) {
        const endpoint = new URL(config.url); endpoint.port = String(message.port); listeningUrl = endpoint.origin;
      }
      if (message && typeof message === 'object' && 'type' in message && message.type === 'startup-error' &&
          'message' in message && typeof message.message === 'string') {
        failure = `后端 ${url.origin} 启动失败：${message.message}`;
      }
    });
    child.once('exit', (code, signal) => {
      failure ??= `后端进程已退出（${signal ?? code}）`;
      clear();
      this.log(failure);
    });
    // Drain pipes without copying model requests/responses or credentials into IDE logs.
    child.stdout?.resume(); child.stderr?.resume();
    this.log(`正在启动模型后端：${url.origin}；目标：${root}`);
    const deadline = Date.now() + 20000;
    try {
    while (Date.now() < deadline) {
      if (this.disposed) throw new Error('Backend manager is disposed');
      if (failure) throw new Error(failure);
      const ready = listeningUrl ? await this.capabilities(listeningUrl) : undefined;
      if (ready) {
        try {
          await this.validateEndpoint({ ...config, url: listeningUrl! }, root, ready);
          if (this.disposed || this.child !== child) throw new Error('后端进程已退出。');
          this.endpoint = listeningUrl; this.verified = ready; this.lastProbeAt = Date.now();
          this.log(`模型后端已就绪：${this.endpoint}；${config.workspaceTranslation === false ? '分析、模型重排；导入目标工程后启用翻译' : '分析、模型重排、翻译'}。`);
          return ready;
        } catch (error) { if (!(error instanceof BackendProbeUnavailable)) throw error; }
      }
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    throw new Error('模型后端在 20 秒内未就绪，请检查端口和构建产物。');
    } catch (error) {
      child.kill();
      clear();
      throw error;
    }
  }

  dispose(): void {
    this.disposed = true;
    const child = this.child;
    if (!child) return;
    if (child.connected) child.send({ type: 'shutdown' }, error => { if (error) child.kill(); });
    const timer = setTimeout(() => { if (this.child === child) child.kill(); }, 5000);
    timer.unref();
  }
}

function sameWorkspace(left: string, right: string): boolean {
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
}
