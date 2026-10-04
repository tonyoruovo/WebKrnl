# @platform/realtime

> **Pre-alpha (`0.0.2`).** Not published to npm yet. `@platform` is a placeholder scope until milestone M9.

The **Realtime** subsystem (id `realtime`, featurized, Tab scope, no required dependency). It keeps one WebSocket for many topics:

- **A worker socket**: the processor `socket` owns the WebSocket in a **dedicated worker**, then on the main thread (failover). Heartbeats stay on time when the page is busy.
- **Reconnects**: a dropped socket reconnects with backoff while the platform is online. Going online reconnects at once. `maxAttempts` limits the attempts.
- **Heartbeats**: a `ping` every `heartbeatMs`; no `pong` in time closes the socket and reconnects.
- **Topics**: many topics share one socket. Every topic subscribes again after a reconnect.
- **Publish buffer**: messages published while disconnected go out after the next open (bounded).
- **Presence**: `presence` frames keep a map of peers; peers without news become `offline`.
- **Auth**: with `auth: 'message'` (recommended) or `'query'`, the access token of Auth reaches the server, and a new token reconnects.
- **Pluggable protocol**: JSON frames by default; `protocol: { encode, decode }` for another server (portable functions).

Design: [ARCHITECTURE §19.4](../../docs/ARCHITECTURE.md#194-realtime) and the amended [Realtime proposal](../../proposals/realtime_PROPOSAL.md). The Global transport joins Realtime in M8.

## Installation

```json
{
  "peerDependencies": {
    "@platform/core": "workspace:*",
    "@platform/realtime": "workspace:*"
  }
}
```

The package starts its worker with `new Worker(new URL('./socket.worker.ts', import.meta.url), { type: 'module' })`. Vite, webpack 5 and Rollup find the worker file from this expression.

## Entry points

| Import                      | Contents                                                                         |
| --------------------------- | -------------------------------------------------------------------------------- |
| `@platform/realtime`        | `createRealtime`, `createSocketProcessor`, `JSON_PROTOCOL`, and the types         |
| `@platform/realtime/worker` | The worker entry. It serves the socket processor. You do not import it yourself.  |

## Usage

```ts
import { createRealtime, type RealtimeControl } from '@platform/realtime';

const kernel = new Kernel([...centralized, createAuth({ handlers }), createRealtime({ url: 'wss://rt.shop.example/socket', auth: 'message' })], {
  router: queue.router,
});
await kernel.start();

const { commands, views } = kernel.unit<RealtimeControl>('realtime').control!;
const stop = commands.subscribe('orders:u1', (data) => refreshOrders(data));
await commands.publish('chat:42', { text: 'hi' });
commands.presence('u2')?.status; // 'online'
```

## The default protocol

```text
  client --> server   {"type":"subscribe","topic":"chat"}   {"type":"unsubscribe","topic":"chat"}
                      {"type":"publish","topic":"chat","data":...}   {"type":"ping"}   {"type":"auth","data":"<token>"}
  server --> client   {"type":"message","topic":"chat","data":...}   {"type":"pong"}   {"type":"ping"}
                      {"type":"presence","data":{"peer":"u2","status":"away"}}
```

## Recommended flow

1. **Use `wss://` only.**
2. **Authenticate with `auth: 'message'`.** The access token goes in the first frame, `{ "type": "auth", "data": "<token>" }`. With `'query'`, the token is in the URL, and URLs end up in the logs of servers and proxies. The server closes a socket that sends no valid `auth` frame within a few seconds.
3. **Let the token rotate.** When Auth refreshes the token, Realtime opens the socket again with the new one. The server should also close sockets whose token expired, and Realtime reconnects.
4. **Check the topic on the server.** A subscription is a request: the server allows only the topics that the user may read (for example, `orders:<own id>`).
5. **Do not cache socket messages.** Use them to refresh data through Network or Sync, which apply the cache and persistence rules.
6. **Keep the defaults for heartbeats** (25 s, with a 10 s timeout). Mobile networks drop idle sockets without a close frame.

## Behaviour

| Situation                              | Result                                                                          |
| -------------------------------------- | ------------------------------------------------------------------------------- |
| Sign-out, or another user signs in (ARCHITECTURE §5.1) | The buffered publishes and the presence are wiped. The listeners stay (they belong to the app). The socket opens again with the new token |
| The socket drops                       | `reconnecting`, backoff, then `open`; every topic subscribes again             |
| No `pong` within `heartbeatTimeoutMs`  | The socket closes and reconnects                                               |
| The platform goes offline              | The socket closes; no reconnect attempts until online                          |
| `publish` while disconnected           | Buffered; the oldest is dropped when full (`state.dropped`)                    |
| `maxAttempts` reached                  | `closed`, `lastError: 'Gave up after N attempts.'` until `connect()`           |
| The Auth token changes                 | The socket opens again with the new token                                      |
| No `Worker` (or it fails)              | The socket runs on the main thread                                             |

## Options

| Option              | Default                  | Purpose                                                  |
| ------------------- | ------------------------ | -------------------------------------------------------- |
| `url`               | (required)               | The socket server.                                       |
| `hosts`             | `['dedicated', 'virtual']` | The hosts of the socket processor.                     |
| `socket`            | `WebSocket`              | A socket factory on the main thread (tests).             |
| `protocol`          | JSON frames              | `{ encode, decode }`, self-contained functions.          |
| `auth`              | `false`                  | `'query'` or `'message'` sends the token of Auth.        |
| `autoConnect`       | `true`                   | Connect at start.                                        |
| `heartbeatMs`       | `25_000`                 | The time between pings.                                  |
| `heartbeatTimeoutMs`| `10_000`                 | The wait for a pong.                                     |
| `maxAttempts`       | no limit                 | Reconnect attempts before giving up.                     |
| `retryBaseMs`       | `500`                    | The base wait of the reconnect backoff.                  |
| `publishBuffer`     | `100`                    | Messages kept while disconnected.                        |
| `presenceTimeoutMs` | `60_000`                 | When a silent peer becomes `offline`.                    |

## Testing

```bash
pnpm exec vitest run --project node packages/realtime
BROWSERS=chrome,webkit pnpm exec vitest run --project browser packages/realtime
```

The browser tests run the socket in a real dedicated worker against `scripts/test-ws-server.ts`.
