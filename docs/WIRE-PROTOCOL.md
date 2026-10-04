# The Global wire protocol (version 1)

This document is the contract between the platform and **your server**. The platform ships the protocol only: the envelope schema (`@platform/core`), the fixtures, and a conformance runner (`@platform/realtime/conformance`). Your backend team builds the server. The design is in [ARCHITECTURE §11.4 and §20](ARCHITECTURE.md#20-global-scope-m8).

The server has two jobs:

1. **Global scope.** Forward each Global broadcast of a user to the other connections of that user (every device and session).
2. **The Window relay.** Forward each Window envelope to the other connections of the same browser session (the same window id). The platform uses the relay where the browser partitions the hub (Safari and every iOS browser).

## 1. The envelope

Every message is a **wire envelope**, JSON, version 1. `encodeWire` and `decodeWire` of `@platform/core` make and check it; `WireEnvelopeSchema` is the schema.

```json
{
  "v": 1,
  "eventId": "note:saved",
  "actionName": "note:saved",
  "importance": "MEDIUM",
  "payload": { "id": "n1" },
  "metadata": {
    "messageId": "6f1c2a9e-…",
    "source": "notes",
    "target": null,
    "scope": "global",
    "timestamp": 1767225600000,
    "traceId": "0b8f3c1d-…",
    "spanId": "a1b2c3d4-…",
    "ttl": 30000
  },
  "fingerprints": { "entries": [], "dropped": 0 }
}
```

| Field | Rule |
|---|---|
| `v` | `1`. A receiver refuses another version. |
| `eventId`, `actionName` | Not empty. |
| `importance` | `CRITICAL`, `HIGH`, `MEDIUM` or `LOW`. |
| `metadata.messageId` | Not empty, unique. Receivers drop repeats by it. **The server must not change it.** |
| `metadata.scope` | `global` on `platform:global`, `window` on `platform:window:<id>`. |
| `metadata.target` | `null` for a broadcast. |
| `metadata.authToken` | Allowed only with a target. A broadcast with a token is invalid: it would reach every receiver. |
| `metadata.ttl` | Optional, in milliseconds after `timestamp`. A client drops an expired envelope before it sends it. |
| `fingerprints` | The trail of the sender. **The server must not add or change fingerprints**: a receiver starts its own trail with the same `traceId` (ARCHITECTURE §9.4). |

**Fixtures.** `@platform/core/fixtures/wire/valid/*.json` and `…/invalid/*.json`. Each file has a `description`, the `envelope`, and for an invalid one the `reason` (the field that fails). Your server must accept every valid fixture and refuse every invalid one.

## 2. The socket

The socket uses the frames of Realtime: one JSON object for each frame.

| Frame | Direction | Meaning |
|---|---|---|
| `{ "type": "auth", "data": "<token>" }` | client → server | The access token, as the first frame. Close a socket that sends no valid token within a few seconds. |
| `{ "type": "subscribe", "topic": "…" }` | client → server | Receive the messages of a topic. |
| `{ "type": "unsubscribe", "topic": "…" }` | client → server | Stop. |
| `{ "type": "publish", "topic": "…", "data": … }` | client → server | Send. |
| `{ "type": "message", "topic": "…", "data": … }` | server → client | A message of a topic. |
| `{ "type": "ack", "data": "<messageId>" }` | server → client | The server accepted a publish on a reserved topic. |
| `{ "type": "ping" }` / `{ "type": "pong" }` | both | Heartbeat. Answer each `ping` with a `pong`. |

**Reserved topics:**

| Topic | `data` | Audience |
|---|---|---|
| `platform:global` | A wire envelope, scope `global` | The other connections of the **same user** (from the token). |
| `platform:window:<windowId>` | A wire envelope, scope `window` | The other connections that subscribed to the **same window id**. |

For a `publish` on a reserved topic, the server must, in this order:

1. **Check the envelope** with the schema. Refuse an invalid one: do not forward it, and do not acknowledge it.
2. **Check the audience.** Only an authenticated connection can publish on `platform:global`. A window id is a random value of one browser session; the server must not forward it to another user.
3. **Forward** it as a `message` to every other connection of the audience. **Do not send it back to the sender.**
4. **Acknowledge** it to the sender: `{ "type": "ack", "data": "<messageId>" }`. The client keeps the envelope in its outbox until the ack arrives, and sends it again after a timeout or a reconnect. So the same envelope can arrive more than once: forward it again, and acknowledge it again. Receivers drop repeats.

## 3. HTTP (optional fallback)

A client uses HTTP while its socket cannot open. Both endpoints take the same `Authorization: Bearer <token>` as your API.

**`POST <base>/publish`**, body `{ "channel": "platform:global" | "platform:window:<id>", "envelope": … }`. The same rules as a socket publish. Answer `200` with `{ "ack": "<messageId>" }`, or `400` for an invalid envelope.

**`GET <base>/poll?channels=<comma-separated>&cursor=<cursor>`**, a long poll:

- Without `cursor`: answer at once with `{ "envelopes": [], "cursor": "<now>" }`. The client starts from here.
- With `cursor`: answer with the envelopes of the channels after the cursor, `{ "envelopes": [{ "channel", "envelope" }], "cursor": "<new>" }`. When there are none, hold the request for up to 25 seconds, then answer with an empty list and the same cursor.
- The server cannot leave out the sender's own envelopes here. The client drops them.

## 4. Delivery

- **At least once** from the server, and **exactly once** for each receiver: the client outbox, the ack and the resend give at least once; deduplication by `messageId` in the receiver gives exactly once.
- **Order** is not guaranteed between envelopes. Use `metadata.orderingKey` if your app needs an order within a key.
- **Offline clients** keep their outbox (in Storage) and send it when they are online again. The server does not keep messages for offline receivers: a Global broadcast is for the receivers that are connected. Use Sync for data that every device must get.

## 5. Conformance

Run the conformance runner against your server, for example in CI:

```ts
import { runConformance } from '@platform/realtime/conformance';

const results = await runConformance({
  url: 'wss://staging.example.com/socket',
  http: 'https://staging.example.com/global', // optional: checks the HTTP endpoints too
  token: testUserToken,
});
const failed = results.filter((r) => !r.passed);
if (failed.length > 0) throw new Error(failed.map((r) => `${r.rule}: ${r.detail}`).join('\n'));
```

It opens three sockets of one test user and checks: `ping`, `ack`, `forward` (other subscribers get it, the sender does not), `window` (only the same window id), `refuse` (an invalid envelope is not forwarded or acknowledged), and with `http`, `http-publish` and `http-poll`.
