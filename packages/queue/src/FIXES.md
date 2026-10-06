# Fixes: queue

> Temporary record of fixes. Delete it when the pull request merges.

| File       | Problem                                                                                                                                                                                                                                                 | Fix                                                                                     |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `queue.ts` | The Queue called `commands.collection` on any unit with the id `storage`. A unit with that id that is not Storage (the test double of the M3 flows test) has no collections, and the watch reported a `TypeError`. Found by the browser test run of M8. | The Queue keeps dead letters in memory only when the unit has no `collection` command.  |
| `queue.ts` | The router of the Queue could not tell the kernel when nothing was being delivered, so the kernel could stop the Notification Center during a delivery.                                                                                                 | The router has `idle()`: it resolves when nothing waits or runs (retries do not count). |
