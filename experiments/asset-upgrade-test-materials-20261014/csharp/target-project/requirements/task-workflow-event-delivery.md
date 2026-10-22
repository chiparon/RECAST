# Workflow event delivery

Dispatch an approved asset event to a workflow. Transport failure must leave
the event retryable. A successful retry may advance the workflow only once.
The event identity and final state must appear in the audit record.

Use the target ports and preserve tenant boundaries. The implementation should
not depend directly on a historical project API.
