import type { ModuleTarget, SearchCandidate, WorkspaceCompilation, WorkspaceTranslationPlan, WorkspaceTranslationRun } from '@forexplore/contracts';

export type ProjectPipelineStage = 'modeling' | 'retrieving' | 'analyzing' | 'generating' | 'verifying' | 'publishing' | 'complete';
export type ProjectReviewKind = 'model' | 'candidate' | 'plan' | 'acceptance';
export interface ProjectPipelineModule {
  id: string;
  name: string;
  target: ModuleTarget;
  dependsOn: string[];
  status: 'pending' | 'running' | 'completed' | 'failed';
  candidates: SearchCandidate[];
  selectedCandidateId?: string;
  plan?: WorkspaceTranslationPlan;
  translation?: Pick<WorkspaceTranslationRun, 'id' | 'status' | 'compilations' | 'verification' | 'acceptance' | 'modelTurns' | 'error' | 'events' | 'evidenceQueries'>;
  changedFiles?: string[];
}
export interface ProjectPipelineReview {
  id: string;
  kind: ProjectReviewKind;
  evidenceHash: string;
  moduleId?: string;
  summary: string;
}
export interface ProjectPipelineValidation {
  compilation: WorkspaceCompilation; verification?: WorkspaceCompilation; protectedFilesUnchanged: boolean; sourceHash: string; coverage: null;
}
export interface ProjectPipelineRun {
  id: string;
  repositoryId: string;
  projectId: string;
  analysisRevision: string;
  analysisHash?: string;
  projectName: string;
  mode: 'automatic' | 'assisted';
  requirement: string;
  stage: ProjectPipelineStage;
  status: 'running' | 'waiting-review' | 'completed' | 'failed' | 'cancelled' | 'rejected' | 'interrupted';
  createdAt: string;
  updatedAt: string;
  modules: ProjectPipelineModule[];
  currentModuleId?: string;
  review?: ProjectPipelineReview;
  decisions: Array<{ reviewId: string; kind: ProjectReviewKind; evidenceHash: string; decision: 'approved' | 'rejected' | 'automatic'; notes: string; at: string }>;
  events: Array<{ id: string; at: string; stage: ProjectPipelineStage; moduleId?: string; message: string }>;
  outputRoot?: string;
  baselineCommit?: string;
  commit?: string;
  validation?: ProjectPipelineValidation;
  validationHistory?: ProjectPipelineValidation[];
  acceptance: 'unverified' | 'compilation-only' | 'behavior-verified';
  reportAvailable: boolean;
  error?: string;
}
export interface ProjectPipelineStart {
  repositoryId: string; projectId: string; requirement: string; mode: 'automatic' | 'assisted'; topK: number;
}
export interface ProjectPipelineDecision {
  reviewId: string; evidenceHash: string; decision: 'approve' | 'reject'; candidateId?: string | null; notes: string;
}
export const projectReviewLabels: Record<ProjectReviewKind, string> = {
  model: '入库与建模审阅', candidate: '候选与范围确认', plan: '修改计划审阅', acceptance: '验收报告审核',
};
