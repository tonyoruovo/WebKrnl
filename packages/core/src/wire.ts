/**
 * @fileoverview
 * @summary The Global-scope wire protocol: the versioned JSON form of a packet envelope.
 * @description
 * Implements docs/ARCHITECTURE.md §11.4. This project ships only the protocol
 * (this schema, its documentation and conformance fixtures); servers that
 * carry Global packets implement it. The checks are hand-written (no
 * validation library): each one is a function from a value and its path to a
 * list of {@linkcode WireIssue}s, the same shape `@webkrnl/settings` and
 * `@webkrnl/consent` already use for their own validation.
 *
 * ```json
 * { "v": 1, "eventId": "...", "actionName": "...", "importance": "HIGH",
 *   "payload": {}, "metadata": { "messageId": "...", "...": "..." },
 *   "fingerprints": { "entries": [], "dropped": 0 } }
 * ```
 *
 * Delivery is at least once: receivers deduplicate by `metadata.messageId`.
 * An elevation token (`metadata.authToken`) is never valid on a broadcast.
 *
 * @example
 * Sending a Global packet over a WebSocket
 * ```ts
 * import { encodeWire } from '@webkrnl/core';
 *
 * socket.send(encodeWire(envelope));
 * ```
 *
 * @example
 * Receiving one, rejecting anything malformed
 * ```ts
 * import { WireProtocolError, decodeWire } from '@webkrnl/core';
 *
 * socket.addEventListener('message', ({ data }) => {
 *   try {
 *     deliver(decodeWire(data));
 *   } catch (error) {
 *     if (error instanceof WireProtocolError) console.warn(error.message, error.issues);
 *   }
 * });
 * ```
 *
 * @throws {WireProtocolError} From {@linkcode encodeWire} and {@linkcode decodeWire} for anything that is not a valid version-1 envelope.
 * @see [docs/WIRE-PROTOCOL.md §1](../../../docs/WIRE-PROTOCOL.md#1-the-envelope) for the same schema in Zod, Yup, `@arrirpc/schema` and Joi, for a server written in TypeScript.
 * @author MathAid
 */

import type { PacketEnvelope } from './packet';
import { SCOPES } from './scope';

/**
 * @summary The current wire protocol version: `1`.
 * @description Sent as the `v` field of every wire envelope. A receiver
 * rejects any other version.
 * @constant {1}
 * @public
 */
export const WIRE_PROTOCOL_VERSION = 1;

/**
 * @summary One violation of the wire schema: where, and what is wrong.
 * @public
 */
export interface WireIssue {
  /**
   * @summary The path to the offending value, field names and array indexes in order.
   */
  readonly path: readonly (string | number)[];
  /**
   * @summary What is wrong, in one sentence.
   */
  readonly message: string;
}

/**
 * @summary A successful {@linkcode WireParseResult}.
 * @template T The parsed type.
 * @public
 */
export interface WireParseSuccess<T> {
  /**
   * @summary `true`: `data` is the parsed value.
   */
  readonly success: true;
  /**
   * @summary The parsed value.
   */
  readonly data: T;
}

/**
 * @summary A failed {@linkcode WireParseResult}.
 * @public
 */
export interface WireParseFailure {
  /**
   * @summary `false`: `error.issues` lists what is wrong.
   */
  readonly success: false;
  /**
   * @summary The failure, with the schema violations.
   */
  readonly error: {
    /**
     * @summary The schema violations.
     */
    readonly issues: readonly WireIssue[];
  };
}

/**
 * @summary The result of {@linkcode WireEnvelopeSchema}'s `safeParse`.
 * @template T The parsed type on success.
 * @public
 */
export type WireParseResult<T> = WireParseSuccess<T> | WireParseFailure;

/** @summary A check: given a value and the path to it, returns its violations. @internal */
type Check = (value: unknown, path: readonly (string | number)[]) => WireIssue[];

/** @summary One issue at `path`. @internal */
function issue(path: readonly (string | number)[], message: string): WireIssue[] {
  return [{ path, message }];
}

/** @summary A non-empty string. @internal */
const nonEmptyString: Check = (value, path) =>
  typeof value !== 'string'
    ? issue(path, 'Expected a string.')
    : value.length === 0
      ? issue(path, 'Expected a non-empty string.')
      : [];

/** @summary Any string, including empty. @internal */
const anyString: Check = (value, path) =>
  typeof value === 'string' ? [] : issue(path, 'Expected a string.');

/** @summary A finite number that is not negative. @internal */
const nonnegativeNumber: Check = (value, path) =>
  typeof value !== 'number' || !Number.isFinite(value)
    ? issue(path, 'Expected a number.')
    : value < 0
      ? issue(path, 'Expected a number that is not negative.')
      : [];

/** @summary A whole, positive number. @internal */
const positiveInt: Check = (value, path) =>
  typeof value !== 'number' || !Number.isInteger(value)
    ? issue(path, 'Expected an integer.')
    : value <= 0
      ? issue(path, 'Expected a positive integer.')
      : [];

/** @summary A whole number that is not negative. @internal */
const nonnegativeInt: Check = (value, path) =>
  typeof value !== 'number' || !Number.isInteger(value)
    ? issue(path, 'Expected an integer.')
    : value < 0
      ? issue(path, 'Expected an integer that is not negative.')
      : [];

/** @summary Exactly one value, by `===`. @internal */
function literal(expected: unknown): Check {
  return (value, path) =>
    value === expected ? [] : issue(path, `Expected ${JSON.stringify(expected)}.`);
}

/** @summary One of a fixed list of strings. @internal */
function oneOf(values: readonly string[]): Check {
  return (value, path) =>
    typeof value === 'string' && values.includes(value)
      ? []
      : issue(path, `Expected one of: ${values.join(', ')}.`);
}

/** @summary `check`, or `null`. @internal */
function nullable(check: Check): Check {
  return (value, path) => (value === null ? [] : check(value, path));
}

/** @summary `check`, or the key absent (`undefined`). A present `null` still fails `check`. @internal */
function optional(check: Check): Check {
  return (value, path) => (value === undefined ? [] : check(value, path));
}

/** @summary An object whose own keys each pass their own check; anything else at `value` fails as one issue. @internal */
function object(shape: Readonly<Record<string, Check>>): Check {
  return (value, path) => {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      return issue(path, 'Expected an object.');
    }
    const found: WireIssue[] = [];
    for (const [key, check] of Object.entries(shape)) {
      found.push(...check((value as Record<string, unknown>)[key], [...path, key]));
    }
    return found;
  };
}

/** @summary An array whose every item passes `item`; anything else at `value` fails as one issue. @internal */
function array(item: Check): Check {
  return (value, path) => {
    if (!Array.isArray(value)) return issue(path, 'Expected an array.');
    const found: WireIssue[] = [];
    for (const [index, element] of value.entries()) found.push(...item(element, [...path, index]));
    return found;
  };
}

/** @summary The wire schema of one fingerprint. @internal */
const fingerprintCheck = object({
  actionName: nonEmptyString,
  valueType: anyString,
  timestamp: nonnegativeNumber,
  subsystemId: nonEmptyString,
  componentId: nullable(anyString),
  counter: nullable(nonnegativeInt),
  level: oneOf(['DEBUG', 'INFO', 'WARN', 'ERROR', 'FATAL']),
  message: nullable(anyString),
});

/** @summary The wire schema of packet metadata. @internal */
const metadataCheck = object({
  messageId: nonEmptyString,
  source: nonEmptyString,
  target: nullable(nonEmptyString),
  scope: oneOf(SCOPES),
  timestamp: nonnegativeNumber,
  ttl: optional(positiveInt),
  correlationId: optional(nonEmptyString),
  traceId: nonEmptyString,
  spanId: nonEmptyString,
  parentSpanId: optional(nonEmptyString),
  orderingKey: optional(nonEmptyString),
  authToken: optional(nonEmptyString),
});

/** @summary The structural check: every field of a {@linkcode PacketEnvelope} plus `v`. @internal */
const envelopeCheck = object({
  v: literal(WIRE_PROTOCOL_VERSION),
  eventId: nonEmptyString,
  actionName: nonEmptyString,
  importance: oneOf(['CRITICAL', 'HIGH', 'MEDIUM', 'LOW']),
  payload: () => [], // the event's own schema validates it, not the wire protocol
  metadata: metadataCheck,
  fingerprints: object({
    entries: array(fingerprintCheck),
    dropped: nonnegativeInt,
  }),
});

/**
 * @summary The schema of a version-1 wire envelope.
 *
 * @description
 * Validates every field of a {@linkcode PacketEnvelope} plus the version field
 * `v`, and refuses an `authToken` on a broadcast (`target: null`). The payload
 * itself is not validated: it belongs to the event's own schema.
 *
 * Use it on a server, or in a conformance test, to validate envelopes without
 * this package's encode and decode helpers. It is a plain object with one
 * method, `safeParse`, not a dependency on a validation library — see
 * [docs/WIRE-PROTOCOL.md §1](../../../docs/WIRE-PROTOCOL.md#1-the-envelope)
 * for the same schema written with Zod, Yup, `@arrirpc/schema` or Joi, if
 * your server would rather keep one of those.
 *
 * @example
 * Validating on a Node server
 * ```ts
 * const result = WireEnvelopeSchema.safeParse(JSON.parse(body));
 * if (!result.success) return reply.status(400).send(result.error.issues);
 * ```
 *
 * @public
 */
export const WireEnvelopeSchema: { safeParse(value: unknown): WireParseResult<WireEnvelope> } = {
  safeParse(value) {
    const issues = envelopeCheck(value, []);
    if (
      issues.length === 0 &&
      (value as { metadata: { target: unknown; authToken: unknown } }).metadata.target === null &&
      (value as { metadata: { target: unknown; authToken: unknown } }).metadata.authToken !==
        undefined
    ) {
      issues.push({
        path: ['metadata', 'authToken'],
        message: 'An elevation token must never be attached to a broadcast.',
      });
    }
    return issues.length === 0
      ? { success: true, data: value as WireEnvelope }
      : { success: false, error: { issues } };
  },
};

/**
 * @summary The version field a wire envelope adds to a {@linkcode PacketEnvelope}.
 * @public
 */
export interface WireVersion {
  /**
   * @summary The wire protocol version. Always {@linkcode WIRE_PROTOCOL_VERSION}.
   */
  readonly v: 1;
}

/**
 * @summary A version-1 wire envelope: a {@linkcode PacketEnvelope} plus `v: 1`.
 * @public
 */
export type WireEnvelope = PacketEnvelope & WireVersion;

/**
 * @summary Thrown when data is not a valid wire envelope.
 *
 * @description
 * `issues` lists the schema violations (empty for invalid JSON or an
 * unsupported version).
 *
 * @example
 * Example 1: Reporting what was wrong
 * ```ts
 * catch (error) {
 *   if (error instanceof WireProtocolError) for (const issue of error.issues) console.warn(issue.path, issue.message);
 * }
 * ```
 *
 * @example
 * Example 2: An unsupported version
 * ```ts
 * decodeWire('{"v":2}'); // throws WireProtocolError: Unsupported wire protocol version: 2.
 * ```
 *
 * @public
 */
export class WireProtocolError extends Error {
  /**
   * @summary The name of the error class: `'WireProtocolError'`.
   */
  override readonly name = 'WireProtocolError';

  /**
   * @summary Creates the error for one refused envelope.
   * @param {string} message What went wrong.
   * @param {readonly WireIssue[]} [issues] The schema violations, if any.
   */
  constructor(
    message: string,
    /**
     * @summary The schema violations, if any.
     * @description The list is empty when the input is not JSON or has the wrong version.
     */
    readonly issues: readonly WireIssue[] = [],
  ) {
    super(message);
  }
}

/**
 * @summary Serializes an envelope for the wire.
 *
 * @description
 * Adds `v: 1`, validates the result against {@linkcode WireEnvelopeSchema}
 * and returns it as JSON text. Validating before sending keeps malformed
 * envelopes from ever reaching a server.
 *
 * @example
 * Example 1: Over a WebSocket
 * ```ts
 * socket.send(encodeWire(envelope));
 * ```
 *
 * @example
 * Example 2: Over HTTP
 * ```ts
 * await fetch('/global', { method: 'POST', body: encodeWire(envelope), headers: { 'content-type': 'application/json' } });
 * ```
 *
 * @param {PacketEnvelope} envelope The envelope. Its payload must be JSON-serializable.
 * @returns {string} The JSON text.
 * @throws {WireProtocolError} When the result would not be a valid wire envelope.
 *
 * @public
 */
export function encodeWire(envelope: PacketEnvelope): string {
  const wire = { v: WIRE_PROTOCOL_VERSION, ...envelope };
  const result = WireEnvelopeSchema.safeParse(wire);
  if (!result.success) {
    throw new WireProtocolError('Envelope is not a valid wire envelope.', result.error.issues);
  }
  return JSON.stringify(wire);
}

/**
 * @summary Parses and validates a wire envelope.
 *
 * @description
 * Accepts JSON text or an already-parsed value, checks the version first (so
 * a newer protocol fails with a clear message), validates the rest, and
 * returns the envelope without the `v` field.
 *
 * @example
 * Example 1: From a WebSocket message
 * ```ts
 * socket.addEventListener('message', ({ data }) => deliver(decodeWire(data)));
 * ```
 *
 * @example
 * Example 2: From a parsed HTTP body
 * ```ts
 * const envelope = decodeWire(await response.json());
 * ```
 *
 * @param {string | unknown} input JSON text, or an already-parsed value.
 * @returns {PacketEnvelope} The envelope, without the version field.
 * @throws {WireProtocolError} On invalid JSON, an unsupported version, or a schema violation.
 *
 * @public
 */
export function decodeWire(input: string | unknown): PacketEnvelope {
  let value: unknown = input;
  if (typeof input === 'string') {
    try {
      value = JSON.parse(input);
    } catch {
      throw new WireProtocolError('Wire envelope is not valid JSON.');
    }
  }
  const version = (value as { v?: unknown } | null)?.v;
  if (version !== WIRE_PROTOCOL_VERSION) {
    throw new WireProtocolError(`Unsupported wire protocol version: ${String(version)}.`);
  }
  const result = WireEnvelopeSchema.safeParse(value);
  if (!result.success) {
    throw new WireProtocolError('Invalid wire envelope.', result.error.issues);
  }
  const { v: _version, ...envelope } = result.data;
  return envelope as PacketEnvelope;
}
