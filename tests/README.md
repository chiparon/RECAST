# Repository Tests

Run `npm run workspace:check` in the assigned workspace. With the lockfile dependencies installed, `npm exec -- vitest run --root tests` runs all three repository suites. The explicit root limits discovery to this checkout's test directory, including on machines with nested Git worktrees.

| Layer | Behavior under test | Run just this layer |
| --- | --- | --- |
| [Contract](contract/README.md) | Module ownership and limits shared by index producers and consumers | `npm exec -- vitest run --root tests contract` |
| [Integration](integration/README.md) | Revision-pinned evidence across indexing, storage and authenticated HTTP | `npm exec -- vitest run --root tests integration` |
| [Headless E2E](e2e/README.md) | Translate, verify and roll back through the extension host message boundary | `npm exec -- vitest run --root tests e2e` |

Whole-project generation and recovery run through the [production project pipeline tests](../apps/vscode-extension/src/project-pipeline.integration.test.ts) in the extension workspace. Package-local unit and component tests live beside production source. These repository tests use unique temporary directories and kernel-assigned loopback ports. Real SeekDB, Electron and model-provider runs have separate entry points.
