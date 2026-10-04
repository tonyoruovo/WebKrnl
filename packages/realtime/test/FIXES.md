# Fixes: realtime tests

> Temporary record of fixes. Delete it when the pull request merges.

| File | Problem | Fix |
|---|---|---|
| `realtime.browser.spec.ts` | The test waited 100 ms for the `subscribe` of tab b to reach the server, then tab a published one time. Under the load of the full browser run, the subscribe came later, and b got nothing. All browser projects also shared the topic `room` on one server. Found by the full browser run of M8 (Edge and Chromium). | Tab a publishes again until b gets the message. Each run uses its own topic. |
