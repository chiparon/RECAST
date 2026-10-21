import type { PipelineModuleVerification } from './project-module-verifier';
import type { ImplementationReferenceSelection } from '../../../services/adaptation-service/src/reference-selection-policy';
import type { ModuleTarget, SearchCandidate, WorkspaceCompilation, WorkspaceCompileCommand, WorkspaceTranslationPlan, WorkspaceTranslationRun } from '@forexplore/contracts';

export type ProjectPipelineStage = 'modeling' | 'retrieving' | 'analyzing' | 'generating' | 'verifying' | 'publishing' | 'complete';
export interface ProjectPipelineModule {
  id: string;
  name: string;
  target: ModuleTarget;
  dependsOn: string[];
  status: 'pending' | 'running' | 'completed' | 'failed';
  candidates: SearchCandidate[];
  selectedCandidateId?: string;
  selectedCandidateIds?: string[];
  referenceSelection?: ImplementationReferenceSelection;
  taskKind?: 'project-integration';
  authorizedFiles?: string[];
  moduleVerification?: PipelineModuleVerification;
  plan?: WorkspaceTranslationPlan;
  translation?: Pick<WorkspaceTranslationRun, 'id' | 'status' | 'compilations' | 'verification' | 'acceptance' | 'modelTurns' | 'error' | 'events' | 'evidenceQueries' | 'agent' | 'verificationRepairs'>;
  changedFiles?: string[];
  repairDiagnostics?: string;
  attemptHistory?: Array<Pick<ProjectPipelineModule, 'plan' | 'translation' | 'moduleVerification' | 'changedFiles'> & { at: string; status: ProjectPipelineModule['status'] }>;
}
export interface ProjectPipelineCheckpoint {
  sourceHash: string;
  files: Record<string, string>;
  activeModuleId?: string;
}
export interface ProjectPipelineValidation {
  compilation: WorkspaceCompilation; verification?: WorkspaceCompilation; protectedFilesUnchanged: boolean; sourceHash: string; coverage: null;
  modules?: Array<{ id: string; verification: PipelineModuleVerification }>;
}
export interface ProjectPipelineRun {
  id: string;
  repositoryId: string;
  projectId: string;
  analysisRevision: string;
  analysisHash?: string;
  projectName: string;
  requirement: string;
  topK?: number;
  resumeCount?: number;
  checkpoint?: ProjectPipelineCheckpoint;
  configuration?: { compileCommand: WorkspaceCompileCommand; verification?: { command: WorkspaceCompileCommand; protectedFiles: string[] } };
  stage: ProjectPipelineStage;
  status: 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted';
  createdAt: string;
  updatedAt: string;
  modules: ProjectPipelineModule[];
  currentModuleId?: string;
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
  repositoryId: string; projectId: string; requirement: string; topK: number;
}
