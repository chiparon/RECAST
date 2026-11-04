import { createProjectPipelineGraph, type ProjectPipelineGraphSteps } from '../apps/vscode-extension/src/project-pipeline-graph';

/** Inspect the production topology without creating a project, model, or VS Code host. */
function structureOnly(): never {
  throw new Error('This Studio entry displays the RECAST graph structure only. Start real project runs from the RECAST VS Code workbench.');
}

// Reuse the exact production graph factory; business ports are deliberately unbound.
const steps: ProjectPipelineGraphSteps = {
  prepare: structureOnly,
  moduleCompleted: structureOnly,
  retrieve: structureOnly,
  generate: structureOnly,
  prepareIntegration: structureOnly,
  integrate: structureOnly,
  startValidation: structureOnly,
  validate: structureOnly,
  repair: structureOnly,
  publish: structureOnly,
};

export const graph = createProjectPipelineGraph(steps);
