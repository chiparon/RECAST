# Integration Tests

[`revision-evidence.test.ts`](revision-evidence.test.ts) indexes two successive versions of a temporary TypeScript project, then asks the adaptation service's evidence client for each version. It exercises the real indexer, the in-memory index store and the code-intelligence HTTP server, including authorization failure. This suite checks that the user-selected revision controls the returned source.

[`project-http-pipeline.test.ts`](project-http-pipeline.test.ts) exercises project analysis through the extension's planning client, adaptation's HTTP service and the semantic query transport. A deterministic architect model produces a project plan, and the test checks publication of full file coverage and the searchable summary.
