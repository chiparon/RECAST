import type { IndexingProgress } from './indexing-progress';
import type { TargetWorkspaceAddMode, TargetWorkspacePhase } from './protocol/messages';

export type TargetImportStage = TargetWorkspacePhase | IndexingProgress['stage'] | 'queued' | 'modeling' | 'complete';
export type TargetImportStatus = 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted';
export interface TargetImportTask {
  id: string;
  mode: TargetWorkspaceAddMode;
  status: TargetImportStatus;
  stage: TargetImportStage;
  createdAt: string;
  updatedAt: string;
  endedAt?: string;
  elapsedMs?: number;
  activeStartedAt?: string;
  /** Existing artifacts can be restored without inventing their original import duration. */
  durationUnknown?: boolean;
  directory?: string;
  displayName: string;
  repositoryId?: string;
  analysisRevision?: string;
  projectId?: string;
  indexReady: boolean;
  modelReady: boolean;
  message: string;
  progress?: { completed: number; total?: number; unit: string };
  events: Array<{ at: string; stage: TargetImportStage; message: string }>;
}

const stages = ['selecting', 'resolving', 'attaching', 'queued', 'indexing', 'snapshot', 'snapshot-verify', 'parse', 'assemble',
  'recover', 'structural-write', 'search-projection', 'activation', 'modeling', 'complete'];
export function isTargetImportTask(value: unknown): value is TargetImportTask {
  if (!value || typeof value !== 'object') return false;
  const task = value as TargetImportTask;
  const text = (value: unknown, max: number) => typeof value === 'string' && value.length <= max;
  const date = (value: unknown) => typeof value === 'string' && Number.isFinite(Date.parse(value));
  const count = (value: unknown) => Number.isSafeInteger(value) && Number(value) >= 0;
  return text(task.id, 128) && task.id.length > 0 && ['browse', 'input', 'workspace'].includes(task.mode)
    && ['running', 'completed', 'failed', 'cancelled', 'interrupted'].includes(task.status) && stages.includes(task.stage)
    && date(task.createdAt) && date(task.updatedAt) && (task.endedAt === undefined || date(task.endedAt))
    && (task.activeStartedAt === undefined || date(task.activeStartedAt)) && (task.elapsedMs === undefined || count(task.elapsedMs))
    && (task.durationUnknown === undefined || typeof task.durationUnknown === 'boolean')
    && text(task.displayName, 512) && text(task.message, 2000)
    && ['directory', 'repositoryId', 'analysisRevision', 'projectId'].every(key => task[key as keyof TargetImportTask] === undefined || text(task[key as keyof TargetImportTask], 4096))
    && typeof task.indexReady === 'boolean' && typeof task.modelReady === 'boolean'
    && (!task.progress || count(task.progress.completed) && (task.progress.total === undefined || count(task.progress.total)) && text(task.progress.unit, 40))
    && Array.isArray(task.events) && task.events.length <= 200 && task.events.every(event => event && date(event.at) && stages.includes(event.stage) && text(event.message, 2000));
}
