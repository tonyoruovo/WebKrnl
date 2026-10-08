/**
 * @fileoverview
 * @summary The socket module (ARCHITECTURE §19.4, M7): the socket processor that `realtime.ts` runs on a worker host.
 * @description
 * `socket.worker.ts` is not re-exported here: it is the `@webkrnl/realtime/worker`
 * entry point, imported only from a worker file.
 * @author MathAid
 */

export * from './processor';
