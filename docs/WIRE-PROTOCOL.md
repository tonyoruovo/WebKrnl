# The Global wire protocol (version 1)

This document is the contract between the platform and **your server**. The platform ships the protocol only: the envelope schema (`@webkrnl/core`), the fixtures, and a conformance runner (`@webkrnl/realtime/conformance`). Your backend team builds the server. The design is in [ARCHITECTURE §11.4 and §20](ARCHITECTURE.md#20-global-scope-m8).

The server has two jobs:

1. **Global scope.** Forward each Global broadcast of a user to the other connections of that user (every device and session).
2. **The Window relay.** Forward each Window envelope to the other connections of the same browser session (the same window id). The platform uses the relay where the browser partitions the hub (Safari and every iOS browser).

## 1. The envelope

Every message is a **wire envelope**, JSON, version 1. `encodeWire` and `decodeWire` of `@webkrnl/core` make and check it; `WireEnvelopeSchema` is the schema.

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

| Field                   | Rule                                                                                                                                                      |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `v`                     | `1`. A receiver refuses another version.                                                                                                                  |
| `eventId`, `actionName` | Not empty.                                                                                                                                                |
| `importance`            | `CRITICAL`, `HIGH`, `MEDIUM` or `LOW`.                                                                                                                    |
| `metadata.messageId`    | Not empty, unique. Receivers drop repeats by it. **The server must not change it.**                                                                       |
| `metadata.scope`        | `global` on `platform:global`, `window` on `platform:window:<id>`.                                                                                        |
| `metadata.target`       | `null` for a broadcast.                                                                                                                                   |
| `metadata.authToken`    | Allowed only with a target. A broadcast with a token is invalid: it would reach every receiver.                                                           |
| `metadata.ttl`          | Optional, in milliseconds after `timestamp`. A client drops an expired envelope before it sends it.                                                       |
| `fingerprints`          | The trail of the sender. **The server must not add or change fingerprints**: a receiver starts its own trail with the same `traceId` (ARCHITECTURE §9.4). |

**Fixtures.** `@webkrnl/core/fixtures/wire/valid/*.json` and `…/invalid/*.json`. Each file has a `description`, the `envelope`, and for an invalid one the `reason` (the field that fails). Your server must accept every valid fixture and refuse every invalid one.

### 1.1 The same schema, in a validation library

`@webkrnl/core`'s own `WireEnvelopeSchema` (`encodeWire`, `decodeWire`) is hand-written, with no dependency. A server written in TypeScript can check the same envelope with a library instead. Each of these refuses the same fixtures `@webkrnl/core/fixtures/wire/invalid/*.json` do, including the broadcast-with-elevation-token rule, which no structural schema expresses on its own: it is a rule across two fields (`metadata.target` and `metadata.authToken`), checked after the rest.

**Zod:**

```ts
import { z } from 'zod';

const nonEmpty = z.string().min(1);
const FingerprintSchema = z.object({
  actionName: nonEmpty,
  valueType: z.string(),
  timestamp: z.number().nonnegative(),
  subsystemId: nonEmpty,
  componentId: z.string().nullable(),
  counter: z.number().int().nonnegative().nullable(),
  level: z.enum(['DEBUG', 'INFO', 'WARN', 'ERROR', 'FATAL']),
  message: z.string().nullable(),
});
const WireEnvelopeSchema = z
  .object({
    v: z.literal(1),
    eventId: nonEmpty,
    actionName: nonEmpty,
    importance: z.enum(['CRITICAL', 'HIGH', 'MEDIUM', 'LOW']),
    payload: z.unknown(),
    metadata: z.object({
      messageId: nonEmpty,
      source: nonEmpty,
      target: nonEmpty.nullable(),
      scope: z.enum(['tab', 'page', 'window', 'global']),
      timestamp: z.number().nonnegative(),
      ttl: z.number().int().positive().optional(),
      traceId: nonEmpty,
      spanId: nonEmpty,
      authToken: nonEmpty.optional(),
    }),
    fingerprints: z.object({
      entries: z.array(FingerprintSchema),
      dropped: z.number().int().nonnegative(),
    }),
  })
  .refine((envelope) => envelope.metadata.target !== null || !envelope.metadata.authToken, {
    message: 'An elevation token must never be attached to a broadcast.',
    path: ['metadata', 'authToken'],
  });

const result = WireEnvelopeSchema.safeParse(JSON.parse(body));
if (!result.success) return reply.status(400).send(result.error.issues);
```

**Yup:**

```ts
import * as yup from 'yup';

const nonEmpty = yup.string().required();
const fingerprintSchema = yup.object({
  actionName: nonEmpty,
  valueType: yup.string().required(),
  timestamp: yup.number().min(0).required(),
  subsystemId: nonEmpty,
  componentId: yup.string().nullable().defined(),
  counter: yup.number().integer().min(0).nullable().defined(),
  level: yup.string().oneOf(['DEBUG', 'INFO', 'WARN', 'ERROR', 'FATAL']).required(),
  message: yup.string().nullable().defined(),
});
const wireEnvelopeSchema = yup
  .object({
    v: yup.number().oneOf([1]).required(),
    eventId: nonEmpty,
    actionName: nonEmpty,
    importance: yup.string().oneOf(['CRITICAL', 'HIGH', 'MEDIUM', 'LOW']).required(),
    payload: yup.mixed(),
    metadata: yup
      .object({
        messageId: nonEmpty,
        source: nonEmpty,
        target: nonEmpty.nullable().defined(),
        scope: yup.string().oneOf(['tab', 'page', 'window', 'global']).required(),
        timestamp: yup.number().min(0).required(),
        ttl: yup.number().integer().positive(),
        traceId: nonEmpty,
        spanId: nonEmpty,
        authToken: nonEmpty,
      })
      .required(),
    fingerprints: yup
      .object({
        entries: yup.array(fingerprintSchema).required(),
        dropped: yup.number().integer().min(0).required(),
      })
      .required(),
  })
  .test(
    'broadcast-no-token',
    'An elevation token must never be attached to a broadcast.',
    (value) => value.metadata.target !== null || !value.metadata.authToken,
  );

try {
  const envelope = await wireEnvelopeSchema.validate(JSON.parse(body));
} catch (error) {
  return reply.status(400).send((error as yup.ValidationError).errors);
}
```

**`@arrirpc/schema`:** the `a` namespace builds a structural schema (`a.object`, `a.string`, `a.enumerator`, `a.nullable`, `a.optional`, `a.int32`). It has no built-in cross-field rule, so the broadcast check runs as a plain function after `a.validate` passes:

```ts
import { a } from '@arrirpc/schema';

const Fingerprint = a.object({
  actionName: a.string(),
  valueType: a.string(),
  timestamp: a.int32(),
  subsystemId: a.string(),
  componentId: a.nullable(a.string()),
  counter: a.nullable(a.int32()),
  level: a.enumerator(['DEBUG', 'INFO', 'WARN', 'ERROR', 'FATAL']),
  message: a.nullable(a.string()),
});
const WireEnvelope = a.object({
  v: a.enumerator(['1']), // arri enumerates strings; compare Number(envelope.v) === 1 yourself
  eventId: a.string(),
  actionName: a.string(),
  importance: a.enumerator(['CRITICAL', 'HIGH', 'MEDIUM', 'LOW']),
  payload: a.any(),
  metadata: a.object({
    messageId: a.string(),
    source: a.string(),
    target: a.nullable(a.string()),
    scope: a.enumerator(['tab', 'page', 'window', 'global']),
    timestamp: a.int32(),
    ttl: a.optional(a.int32()),
    traceId: a.string(),
    spanId: a.string(),
    authToken: a.optional(a.string()),
  }),
  fingerprints: a.object({ entries: a.array(Fingerprint), dropped: a.int32() }),
});

const envelope = JSON.parse(body) as a.infer<typeof WireEnvelope>;
const valid =
  a.validate(WireEnvelope, envelope) &&
  (envelope.metadata.target !== null || !envelope.metadata.authToken);
if (!valid) return reply.status(400).send('Invalid wire envelope.');
```

**Joi:**

```ts
import Joi from 'joi';

const fingerprintSchema = Joi.object({
  actionName: Joi.string().min(1).required(),
  valueType: Joi.string().required(),
  timestamp: Joi.number().min(0).required(),
  subsystemId: Joi.string().min(1).required(),
  componentId: Joi.string().allow(null).required(),
  counter: Joi.number().integer().min(0).allow(null).required(),
  level: Joi.string().valid('DEBUG', 'INFO', 'WARN', 'ERROR', 'FATAL').required(),
  message: Joi.string().allow(null).required(),
});
const wireEnvelopeSchema = Joi.object({
  v: Joi.number().valid(1).required(),
  eventId: Joi.string().min(1).required(),
  actionName: Joi.string().min(1).required(),
  importance: Joi.string().valid('CRITICAL', 'HIGH', 'MEDIUM', 'LOW').required(),
  payload: Joi.any(),
  metadata: Joi.object({
    messageId: Joi.string().min(1).required(),
    source: Joi.string().min(1).required(),
    target: Joi.string().min(1).allow(null).required(),
    scope: Joi.string().valid('tab', 'page', 'window', 'global').required(),
    timestamp: Joi.number().min(0).required(),
    ttl: Joi.number().integer().positive(),
    traceId: Joi.string().min(1).required(),
    spanId: Joi.string().min(1).required(),
    authToken: Joi.string().min(1),
  }).required(),
  fingerprints: Joi.object({
    entries: Joi.array().items(fingerprintSchema).required(),
    dropped: Joi.number().integer().min(0).required(),
  }).required(),
}).custom((envelope, helpers) => {
  if (envelope.metadata.target === null && envelope.metadata.authToken) {
    return helpers.error('any.invalid');
  }
  return envelope;
}, 'An elevation token must never be attached to a broadcast.');

const { value, error } = wireEnvelopeSchema.validate(JSON.parse(body));
if (error) return reply.status(400).send(error.details);
```

## 2. The socket

The socket uses the frames of Realtime: one JSON object for each frame.

| Frame                                            | Direction       | Meaning                                                                                              |
| ------------------------------------------------ | --------------- | ---------------------------------------------------------------------------------------------------- |
| `{ "type": "auth", "data": "<token>" }`          | client → server | The access token, as the first frame. Close a socket that sends no valid token within a few seconds. |
| `{ "type": "subscribe", "topic": "…" }`          | client → server | Receive the messages of a topic.                                                                     |
| `{ "type": "unsubscribe", "topic": "…" }`        | client → server | Stop.                                                                                                |
| `{ "type": "publish", "topic": "…", "data": … }` | client → server | Send.                                                                                                |
| `{ "type": "message", "topic": "…", "data": … }` | server → client | A message of a topic.                                                                                |
| `{ "type": "ack", "data": "<messageId>" }`       | server → client | The server accepted a publish on a reserved topic.                                                   |
| `{ "type": "ping" }` / `{ "type": "pong" }`      | both            | Heartbeat. Answer each `ping` with a `pong`.                                                         |

**Reserved topics:**

| Topic                        | `data`                          | Audience                                                         |
| ---------------------------- | ------------------------------- | ---------------------------------------------------------------- |
| `platform:global`            | A wire envelope, scope `global` | The other connections of the **same user** (from the token).     |
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
import { runConformance } from '@webkrnl/realtime/conformance';

const results = await runConformance({
  url: 'wss://staging.example.com/socket',
  http: 'https://staging.example.com/global', // optional: checks the HTTP endpoints too
  token: testUserToken,
});
const failed = results.filter((r) => !r.passed);
if (failed.length > 0) throw new Error(failed.map((r) => `${r.rule}: ${r.detail}`).join('\n'));
```

It opens three sockets of one test user and checks: `ping`, `ack`, `forward` (other subscribers get it, the sender does not), `window` (only the same window id), `refuse` (an invalid envelope is not forwarded or acknowledged), and with `http`, `http-publish` and `http-poll`.
