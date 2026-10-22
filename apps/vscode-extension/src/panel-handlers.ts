import type { HostToWebviewMessage, WebviewToHostMessage } from './protocol/messages';
import type { PanelHandlers } from './panel';

/**
 * Webview actions whose reply a user explicitly waits for.  A refusal or a lost
 * answer to one of them leaves the workbench spinning with nothing running, so
 * those are exactly the messages that must never be dropped in silence.
 */
export const awaitedWebviewActions = new Set<unknown>([
  'START_PROJECT_PIPELINE', 'PROJECT_PIPELINE_ACTION',
  'START_ADAPT', 'START_SEARCH', 'APPLY_CURRENT_RUN', 'WORKSPACE_TRANSLATION',
  'SELECT_WORKSPACE_TARGET', 'SELECT_CODE_INTELLIGENCE_PROJECT', 'SAVE_SETTINGS',
]);

/** Host replies a user waits for; dropping one of them stalls the panel. */
export const awaitedHostReplies = new Set<unknown>([
  'PROJECT_PIPELINE_STATE',
  'SEARCH_RESULT', 'ADAPT_RESULT', 'APPLY_RESULT', 'ERROR', 'MODULE_TRANSLATION_READY',
  'MODULE_CHILDREN', 'MODULE_CHILDREN_ERROR',
  'WORKSPACE_TRANSLATION_RESULT', 'WORKSPACE_TRANSLATION_ERROR', 'TARGET_WORKSPACE_RESULT',
]);

export function panelRefusalMessage(reason: string): string {
  return `面板请求未被宿主接受：${reason}`;
}

/** Wording used when an older workbench panel is closed to keep the singleton. */
export const supersededPanelNotice =
  '[forexplore] closed a superseded workbench panel: only one panel receives host replies.';

/**
 * Delivers one host reply.  A reply a user is waiting for must not disappear
 * because the panel that asked for it is gone (or was replaced): that shows up
 * in the RECAST channel instead of nowhere.
 */
export function publishPanelMessage(
  panel: { post(message: HostToWebviewMessage): void } | undefined,
  message: HostToWebviewMessage,
  output?: { appendLine(value: string): void },
): void {
  if (panel) {
    panel.post(message);
    return;
  }
  if (awaitedHostReplies.has(message.type)) {
    output?.appendLine(`[forexplore] dropped ${message.type}: no panel is attached.`);
  }
}

export interface PanelHandlerDependencies {
  output: { appendLine(value: string): void };
  /** The real dispatcher; may reject, and the rejection reaches the user. */
  dispatch(message: WebviewToHostMessage): Promise<void>;
  /** Delivers a host reply, including the answer to a refused action. */
  publish(message: HostToWebviewMessage): void;
}

/**
 * Builds the Webview message handlers.  Kept out of the extension entrypoint so
 * the panel chain can be tested without importing the whole host composition.
 */
export function createPanelHandlers(dependencies: PanelHandlerDependencies): PanelHandlers {
  return {
    onMessage: (message) => {
      // A refused or failed action must reach the user: without this catch the
      // rejection would only surface as an unhandled promise.
      void dependencies.dispatch(message)
        .catch((error) => dependencies.publish({ type: 'ERROR',
          message: `面板操作失败：${error instanceof Error ? error.message : String(error)}` }));
    },
    onInvalidMessage: (message, reason) => {
      dependencies.output.appendLine(`[forexplore] refused an invalid webview message: ${reason}`);
      // Answer anything the panel is waiting on; a dropped request would leave
      // the workbench spinning with nothing running behind it.
      if (awaitedWebviewActions.has((message as { type?: unknown })?.type)) {
        dependencies.publish({ type: 'ERROR', message: panelRefusalMessage(reason) });
      }
    },
    onSupersededPanel: () => dependencies.output.appendLine(supersededPanelNotice),
  };
}
