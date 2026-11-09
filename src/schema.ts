export interface RetrievalMetrics {
  scenario: string;
  mode: string;
  unit: string;
  anchorHit1: number | null;
  anchorHit4: number | null;
  recall4: number | null;
  allRequiredHit4: number | null;
  mrr: number | null;
  ndcg4: number | null;
  collaboratorRecall4: number | null;
  hop2Discovery: number | null;
  responsibilityCoverage: number | null;
  contextCompleteness: number | null;
  distractorRejection: number | null;
  earlyExit: number | null;
  retrievalMs: number | null;
}
export interface DevelopmentVelocityMetrics {
  scenario: string;
  mode: string;
  delivered: number;
  elapsedMs: number;
  e2eDeliveryMs: number | null;
  retrievalMs: number | null;
  scopePrepMs: number;
  agentLoopMs: number;
  compileAndVerifyMs: number;
  modelTurns: number;
  toolCallCount: number;
  evidenceQueryCount: number;
  evidenceCharsPulled: number;
  planRevisions: number;
  compileAttempts: number;
  testAttempts: number;
  firstPassCompileSuccess: number | null;
  firstPassVerifySuccess: number | null;
  integrationRepairCount: number;
  agentInputTokens: number;
  agentOutputTokens: number;
  judgeInputTokens: number;
  judgeOutputTokens: number;
  contextChars: number;
  timeSpeedupVsDirect: number | null;
  timeSpeedupVsStandard: number | null;
  turnsSpeedupVsDirect: number | null;
  turnsSpeedupVsStandard: number | null;
}
