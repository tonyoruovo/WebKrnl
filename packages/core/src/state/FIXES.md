# Fixes: core/state

> Temporary record of fixes. Delete it when the pull request merges.

| File         | Problem                                                                                                                                                                                                                                           | Fix                                                                               |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `signout.ts` | `watchSignOut` read `views.state` of any unit with the target id. A unit with the id `auth` that is not Auth (the test double of the M3 flows test) has no state view, and the watch reported a `TypeError`. Found by the browser test run of M8. | `watchSignOut` ignores a unit without a state view, as it ignores a stopped Auth. |
