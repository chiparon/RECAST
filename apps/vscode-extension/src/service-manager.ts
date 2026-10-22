import * as vscode from 'vscode';
import { AdaptationHttpAdapter } from '@forexplore/adaptation-http-adapter';
import type { WorkflowPorts } from '@forexplore/workflow-core';
import { checkServiceHealth } from './service-health';
import { localFetch } from './local-fetch';
import { loadSettings } from './settings';
import type { CodeIntelligencePresentation, ExecutionMode, ServiceStatus } from './ui-types';
import type { BackendProcess } from './backend-process';

export interface RuntimePorts {
  searchProvider: 'SeekDB';
  adaptationProvider: 'DeepSeek';
  executionMode: ExecutionMode;
}

/**
 * Owns the external adaptation runtime. Candidate retrieval is provided by
 * the extension's local code-intelligence runtime over its versioned SeekDB
 * projection, so it does not depend on the legacy retrieval HTTP service.
 */
export class ServiceManager implements vscode.Disposable {
  private status: ServiceStatus = {
    moduleSearch: 'unconfigured',
    adaptation: 'unconfigured',
    executionMode: 'real',
  };

  constructor(private readonly output: vscode.OutputChannel, private readonly backend?: BackendProcess) {}

  get serviceStatus(): ServiceStatus {
    return { ...this.status };
  }

  get adaptationEndpoint(): string { return this.backend?.url ?? loadSettings().adaptationApiUrl; }
  setModuleSearchReady(ready: boolean): void {
    this.status = { ...this.status, moduleSearch: ready ? 'connected' : 'error' };
  }

  setIndexStatus(presentation: CodeIntelligencePresentation): void {
    const state = presentation.runtimeStatus ?? presentation.status;
    this.status = { ...this.status, moduleSearch: state === 'ready' ? 'connected'
      : state === 'initializing' ? 'starting' : 'error' };
  }

  setIndexInitialization(message: string): void {
    this.status = { ...this.status, moduleSearch: 'starting',
      adaptation: this.status.adaptation === 'connected' ? 'connected' : 'starting', message };
  }

  /** Display-only provider labels that do not create or replace any port. */
  getRuntimePresentation(): RuntimePorts {
    return {
      searchProvider: 'SeekDB',
      adaptationProvider: 'DeepSeek',
      executionMode: 'real',
    };
  }

  async refresh(): Promise<ServiceStatus> {
    let adaptation;
    if (this.backend) {
      try {
        await this.backend.ensure();
        adaptation = { healthy: true, detail: 'ok' };
      } catch (error) {
        adaptation = { healthy: false, detail: error instanceof Error ? error.message : String(error) };
      }
    } else {
      adaptation = await checkServiceHealth(loadSettings().adaptationApiUrl, localFetch);
    }
    this.status = {
      moduleSearch: this.status.moduleSearch,
      adaptation: adaptation.healthy ? 'connected' : 'error',
      executionMode: 'real',
      message: !adaptation.healthy ? `翻译：${adaptation.detail}` : this.backend?.healthPending ? '翻译后端暂未响应健康探测，进程仍在运行，稍后重试。' : undefined,
    };
    this.output.appendLine(
      `[forexplore] runtime refreshed: moduleSearch=${this.status.moduleSearch}, adaptation=${this.status.adaptation}`,
    );
    return this.serviceStatus;
  }

  async ensureStarted(): Promise<ServiceStatus> {
    if (this.status.adaptation !== 'connected') this.status = { ...this.status, adaptation: 'starting' };
    try { await this.backend?.ensure(); }
    catch (error) {
      this.status = { ...this.status, adaptation: 'error', message: error instanceof Error ? error.message : String(error) };
      throw error;
    }
    if (!this.backend) return this.refresh();
    this.status = { ...this.status, adaptation: 'connected', message: undefined };
    return this.serviceStatus;
  }

  getAdaptationPort(): WorkflowPorts['adaptation'] {
    if (this.status.adaptation !== 'connected') {
      throw new Error(this.status.message ?? '真实适配服务尚未就绪。');
    }
    return new AdaptationHttpAdapter({
      baseUrl: this.adaptationEndpoint,
      fetch: localFetch,
    });
  }

  dispose(): void {
    this.backend?.dispose();
  }
}
