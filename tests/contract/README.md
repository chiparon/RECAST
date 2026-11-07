# Contract Tests

[`module-hierarchy.test.ts`](module-hierarchy.test.ts) tests the shared `indexModuleHierarchy` function. It checks legacy flat proposals, distinct file limits and rejection of unsafe trees. Producers and consumers use this contract to decide which files belong to a selected module.
