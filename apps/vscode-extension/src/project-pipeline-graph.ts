import { Annotation, END, START, StateGraph } from '@langchain/langgraph';
import { AsyncLocalStorageProviderSingleton } from '@langchain/core/singletons';

/** Existing host operations; the graph owns only their order and loop cursors. */
export interface ProjectPipelineGraphSteps {
  prepare(): Promise<number>;
  moduleCompleted(index: number): boolean;
  retrieve(index: number): Promise<void>;
  generate(index: number): Promise<void>;
  prepareIntegration(): number;
  integrate(index: number): Promise<void>;
  startValidation(): void;
  validate(): Promise<boolean>;
  repair(attempt: number): Promise<void>;
  publish(): Promise<void>;
}

const ExecutionState = Annotation.Root({
  moduleCount: Annotation<number>(),
  moduleIndex: Annotation<number>(),
  integrationCount: Annotation<number>(),
  integrationIndex: Annotation<number>(),
  validationAttempt: Annotation<number>(),
  validationPassed: Annotation<boolean>(),
});

type Execution = typeof ExecutionState.State;
function node(action: (state: Execution) => Partial<Execution> | Promise<Partial<Execution>>) {
  return async (state: Execution) => {
    try {
      // Existing capabilities are independent graph roots. Inheriting this
      // node's checkpoint namespace would split Verifier's feedback thread.
      return await AsyncLocalStorageProviderSingleton.runWithConfig({}, () => action(state));
    }
    catch (cause) {
      // LangGraph annotates thrown errors. Ports may throw strings or frozen
      // errors; keep their original user-facing message in a writable Error.
      throw new Error(cause instanceof Error ? cause.message : String(cause), { cause });
    }
  };
}

export function createProjectPipelineGraph(steps: ProjectPipelineGraphSteps) {
  return new StateGraph(ExecutionState)
    .addNode('prepareOrRestore', node(async () => ({ moduleCount: await steps.prepare(), moduleIndex: 0, validationAttempt: 0 })))
    .addNode('selectModule', node(state => {
      let moduleIndex = state.moduleIndex;
      while (moduleIndex < state.moduleCount && steps.moduleCompleted(moduleIndex)) moduleIndex++;
      return { moduleIndex };
    }))
    .addNode('retrieve', node(async state => { await steps.retrieve(state.moduleIndex); return {}; }))
    .addNode('generateModule', node(async state => {
      await steps.generate(state.moduleIndex);
      return { moduleIndex: state.moduleIndex + 1 };
    }))
    .addNode('prepareIntegration', node(() => ({ integrationCount: steps.prepareIntegration(), integrationIndex: 0 })))
    .addNode('integrate', node(async state => {
      await steps.integrate(state.integrationIndex);
      return { integrationIndex: state.integrationIndex + 1 };
    }))
    .addNode('startValidation', node(() => { steps.startValidation(); return {}; }))
    .addNode('validate', node(async () => ({ validationPassed: await steps.validate() })))
    .addNode('repairIntegration', node(async state => {
      await steps.repair(state.validationAttempt);
      return { validationAttempt: state.validationAttempt + 1 };
    }))
    .addNode('publish', node(async () => { await steps.publish(); return {}; }))
    .addEdge(START, 'prepareOrRestore')
    .addEdge('prepareOrRestore', 'selectModule')
    .addConditionalEdges('selectModule', state => state.moduleIndex < state.moduleCount ? 'retrieve' : 'prepareIntegration', ['retrieve', 'prepareIntegration'])
    .addEdge('retrieve', 'generateModule')
    .addEdge('generateModule', 'selectModule')
    .addConditionalEdges('prepareIntegration', state => state.integrationCount ? 'integrate' : 'startValidation', ['integrate', 'startValidation'])
    .addConditionalEdges('integrate', state => state.integrationIndex < state.integrationCount ? 'integrate' : 'startValidation', ['integrate', 'startValidation'])
    .addEdge('startValidation', 'validate')
    .addConditionalEdges('validate', state => state.validationPassed ? 'publish' : 'repairIntegration', ['publish', 'repairIntegration'])
    .addEdge('repairIntegration', 'validate')
    .addEdge('publish', END)
    // run.json remains the durable record; the existing resume path rebuilds this graph.
    .compile({ checkpointer: false });
}
