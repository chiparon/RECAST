# Contributing

`main` contains the product and the regression suite. Historical experiments,
vendor snapshots and research documents live on
[`codex/archive-full-20261025`](https://github.com/chiparon/weichai/tree/codex/archive-full-20261025);
see [archive access](docs/archive.md).

Keep changes inside their owning module:

- VS Code interaction and workbench: `apps/vscode-extension`.
- Shared data shapes: `packages/contracts`.
- Workflow sequencing and ports: `packages/workflow-core`.
- Indexing, retrieval, adaptation and verification: the matching service.
- Runtime and maintenance commands: `scripts`.
- Regression inputs: `fixtures` and service-local test fixtures. Keep source
  inputs only; never commit `bin`, `obj`, runtime logs or dependency caches.
- Enterprise instructions: `docs/user-guide` and the root README.

Dependencies point inward: applications and services may depend on the workflow
core and contracts; the workflow core may depend on contracts; contracts must
not depend on another RECAST package. The verifier additionally follows its
local `workflow -> strategy -> host` instructions.

Use the workspace assigned to the current platform, following `AGENTS.md`.
Before handing off a change, run:

```sh
npm run workspace:check
npm run check:hygiene
npm run typecheck --workspace forexplore-vscode
npm run build
npm test
npm run test:scripts
npm run test:verifier
```

Real compiler and online-model tests are opt-in and document their prerequisites.
Passing the offline suite does not imply that an online model or an external
database has been validated.
