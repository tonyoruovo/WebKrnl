# Fixes: `@webkrnl/storage`

> Temporary record of fixes. Delete when the PR is merged.

| File             | Problem                                                                                                                                                                                                                                                                                            | Fix                                                              |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| `coordinator.ts` | `teardown` closed the backend at once. A write that was still in the request queue when the kernel stopped then ran on a closed coordinator ("The Storage coordinator is not set up") and was lost. Found by the M8 gate test: the Global outbox wrote an envelope, and the page reloaded at once. | `teardown` waits for the request queue, then closes the backend. |
