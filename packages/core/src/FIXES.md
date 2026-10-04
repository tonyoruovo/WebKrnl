# Fixes: core

> Temporary record of fixes. Delete it when the pull request merges.

| File | Problem | Fix |
|---|---|---|
| `scheduler.ts` | In Node, the `message-channel` scheduler called `unref()` on its port one time, at creation. A task queued while nothing else kept the process alive never ran: Node exited first. A processor on the virtual host in a Node script did not finish. The `core/processor` example in `EXAMPLES.md` found it. | The port is referenced while tasks wait and released when the queue is empty. The `unref()` call now comes after `onmessage` is set, because setting `onmessage` references a Node port. A test in `test/processors.spec.ts` checks the order of the calls. |
| `host.ts` | `VirtualHost.stop` ran the teardown of the processor at once, while calls that it had accepted still waited in the scheduler. Those calls then ran on a stopped processor. A write to Storage just before a reload was lost. Found by the M8 gate test (a Global envelope in the outbox, then an immediate reload). | `stop` waits for the accepted calls (`Promise.allSettled`), then runs the teardown. The Storage coordinator also waits for its own request queue in `teardown` (`packages/storage/src/FIXES.md`). |
| `signout.ts` | `watchSignOut` read `views.state` of any unit with the target id. A unit with the id `auth` that is not Auth (the test double of the M3 flows test) has no state view, and the watch reported a `TypeError`. Found by the browser test run of M8. | `watchSignOut` ignores a unit without a state view, as it ignores a stopped Auth. |
