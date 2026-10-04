/**
 * @fileoverview
 * @summary The conformance runner of the Global wire protocol: checks a server against docs/WIRE-PROTOCOL.md.
 *
 * @description
 * A backend team runs it against its own server, for example in CI
 * (docs/ARCHITECTURE.md §20.3). It opens plain sockets, sends raw frames, and
 * checks each rule of the protocol. It does not use the platform, so a pass
 * means that any client of the protocol works.
 *
 * ```text
 *   ping           ping --> pong
 *   ack            publish on 'platform:global' --> { type: 'ack', data: <messageId> }
 *   forward        the other subscribers of the topic get the envelope; the sender does not
 *   window         'platform:window:<id>' reaches only the subscribers of the same id
 *   refuse         an invalid envelope is not forwarded and not acknowledged
 *   http-publish   POST <http>/publish --> { ack } and the subscribers get it      (with \`http\`)
 *   http-poll      GET <http>/poll --> a cursor, then the envelopes after it      (with \`http\`)
 *   ```
 *
 * @example
 * In a test of your server
 * ```ts
 * import { runConformance } from '@platform/realtime/conformance';
 *
 * const results = await runConformance({ url: 'wss://localhost:8443/socket', http: 'https://localhost:8443/global', token });
 * for (const r of results) console.log(r.passed ? 'pass' : 'FAIL', r.rule, r.detail);
 * ```
 *
 * @author MathAid
 */

import { WIRE_PROTOCOL_VERSION } from '@platform/core';

import type { Frame, SocketLike } from './types';

/**
 * @summary Options of {@linkcode runConformance}.
 * @public
 */
export interface ConformanceOptions {
  /**
   * @summary The socket URL of the server.
   */
  readonly url: string;
  /**
   * @summary The base URL of the HTTP endpoints. Without it, the HTTP rules are skipped.
   */
  readonly http?: string;
  /**
   * @summary An access token. Each socket sends it in an \`auth\` frame first.
   */
  readonly token?: string;
  /**
   * @summary Makes a socket. The default is \`new WebSocket(url)\`.
   */
  readonly socket?: (url: string) => SocketLike;
  /**
   * @summary The \`fetch\` function for the HTTP rules. The default is the global \`fetch\`.
   */
  readonly fetch?: typeof fetch;
  /**
   * @summary How long to wait for each expected frame, in milliseconds. The default is 2 000.
   */
  readonly timeoutMs?: number;
}

/**
 * @summary The result of one rule.
 * @example
 * Example 1: A pass
 * ```ts
 * // { rule: 'ack', passed: true, detail: 'The server acknowledged the envelope.' }
 * ```
 * @example
 * Example 2: A failure
 * ```ts
 * // { rule: 'refuse', passed: false, detail: 'The server forwarded an invalid envelope.' }
 * ```
 * @public
 */
export interface ConformanceResult {
  /**
   * @summary The rule: \`ping\`, \`ack\`, \`forward\`, \`window\`, \`refuse\`, \`http-publish\` or \`http-poll\`.
   */
  readonly rule: string;
  /**
   * @summary Tells if the server follows the rule.
   */
  readonly passed: boolean;
  /**
   * @summary What happened.
   */
  readonly detail: string;
}

/**
 * @summary Makes a valid wire envelope (version 1) for a test.
 * @example
 * An envelope
 * ```ts
 * const envelope = testEnvelope('global', 'conformance:ping');
 * ```
 * @param {'global' | 'window'} scope The scope.
 * @param {string} eventId The event id.
 * @returns {Record<string, unknown>} The envelope.
 * @public
 */
export function testEnvelope(scope: 'global' | 'window', eventId: string): Record<string, unknown> {
  const id = () => crypto.randomUUID();
  return {
    v: WIRE_PROTOCOL_VERSION,
    eventId,
    actionName: eventId,
    importance: 'MEDIUM',
    payload: { test: true },
    metadata: {
      messageId: id(),
      source: 'conformance',
      target: null,
      scope,
      timestamp: Date.now(),
      traceId: id(),
      spanId: id(),
    },
    fingerprints: { entries: [], dropped: 0 },
  };
}

/** A test client: one socket with a log of frames. */
class Client {
  readonly frames: Frame[] = [];
  private readonly waiters = new Set<() => void>();
  private constructor(private readonly socket: SocketLike) {
    socket.onmessage = (event) => {
      try {
        this.frames.push(JSON.parse(String(event.data)) as Frame);
      } catch {
        return;
      }
      for (const wake of [...this.waiters]) wake();
    };
  }

  static open(options: ConformanceOptions): Promise<Client> {
    const make = options.socket ?? ((url: string) => new WebSocket(url) as unknown as SocketLike);
    const socket = make(options.url);
    const client = new Client(socket);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('The socket did not open.')),
        options.timeoutMs ?? 2_000,
      );
      socket.onopen = () => {
        clearTimeout(timer);
        if (options.token) client.send({ type: 'auth', data: options.token });
        resolve(client);
      };
      socket.onclose = () => {
        clearTimeout(timer);
        reject(new Error('The socket closed before it opened.'));
      };
    });
  }

  send(frame: Frame): void {
    this.socket.send(JSON.stringify(frame));
  }

  /** Waits for a frame that matches, or returns null after the timeout. */
  wait(match: (frame: Frame) => boolean, timeoutMs: number): Promise<Frame | null> {
    const found = this.frames.find(match);
    if (found) return Promise.resolve(found);
    return new Promise((resolve) => {
      const wake = () => {
        const frame = this.frames.find(match);
        if (!frame) return;
        this.waiters.delete(wake);
        clearTimeout(timer);
        resolve(frame);
      };
      const timer = setTimeout(() => {
        this.waiters.delete(wake);
        resolve(null);
      }, timeoutMs);
      this.waiters.add(wake);
    });
  }

  close(): void {
    this.socket.close(1000);
  }
}

const idOf = (data: unknown) =>
  (data as { metadata?: { messageId?: string } } | null)?.metadata?.messageId;
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * @summary Checks a server against the Global wire protocol and returns one result for each rule.
 * @description It needs a server that forwards Global envelopes between the
 * connections of one test user: give a \`token\` when the server requires one.
 * A rule that cannot run (for example, the socket does not open) fails with
 * the reason.
 * @example
 * Failing a CI job
 * ```ts
 * const failed = (await runConformance({ url })).filter((r) => !r.passed);
 * if (failed.length > 0) throw new Error(failed.map((r) => \`\${r.rule}: \${r.detail}\`).join('\\n'));
 * ```
 * @param {ConformanceOptions} options The server, the token, and the timeouts.
 * @returns {Promise<ConformanceResult[]>} The results.
 * @public
 */
export async function runConformance(options: ConformanceOptions): Promise<ConformanceResult[]> {
  const wait = options.timeoutMs ?? 2_000;
  const quiet = Math.min(500, wait); // how long "nothing arrives" is checked
  const results: ConformanceResult[] = [];
  const record = (rule: string, passed: boolean, detail: string) =>
    results.push({ rule, passed, detail });
  let clients: Client[] = [];
  try {
    clients = await Promise.all([Client.open(options), Client.open(options), Client.open(options)]);
  } catch (error) {
    record('ping', false, `The sockets did not open: ${(error as Error).message}`);
    return results;
  }
  const [a, b, c] = clients as [Client, Client, Client];
  try {
    // ping
    a.send({ type: 'ping' });
    record('ping', (await a.wait((f) => f.type === 'pong', wait)) !== null, 'A ping gets a pong.');

    // ack and forward
    b.send({ type: 'subscribe', topic: 'platform:global' });
    a.send({ type: 'subscribe', topic: 'platform:global' });
    await pause(100);
    const global = testEnvelope('global', 'conformance:global');
    const id = idOf(global)!;
    a.send({ type: 'publish', topic: 'platform:global', data: global });
    const ack = await a.wait((f) => f.type === 'ack' && f.data === id, wait);
    record(
      'ack',
      ack !== null,
      ack ? 'The server acknowledged the envelope.' : 'No ack with the messageId.',
    );
    const got = await b.wait(
      (f) => f.type === 'message' && f.topic === 'platform:global' && idOf(f.data) === id,
      wait,
    );
    await pause(quiet);
    const echoed = a.frames.some((f) => f.type === 'message' && idOf(f.data) === id);
    record(
      'forward',
      got !== null && !echoed,
      got === null
        ? 'Another subscriber did not get the envelope.'
        : echoed
          ? 'The sender got its own envelope back.'
          : 'Another subscriber got the envelope, and the sender did not.',
    );

    // window
    b.send({ type: 'subscribe', topic: 'platform:window:w-conformance-1' });
    c.send({ type: 'subscribe', topic: 'platform:window:w-conformance-2' });
    await pause(100);
    const win = testEnvelope('window', 'conformance:window');
    const winId = idOf(win)!;
    a.send({ type: 'publish', topic: 'platform:window:w-conformance-1', data: win });
    const same = await b.wait((f) => f.type === 'message' && idOf(f.data) === winId, wait);
    await pause(quiet);
    const leaked = c.frames.some((f) => f.type === 'message' && idOf(f.data) === winId);
    record(
      'window',
      same !== null && !leaked,
      same === null
        ? 'The subscriber of the same window id did not get the envelope.'
        : leaked
          ? 'A subscriber of another window id got the envelope.'
          : 'Only the subscriber of the same window id got the envelope.',
    );

    // refuse
    const invalid = { ...testEnvelope('global', 'conformance:invalid'), eventId: '' };
    const invalidId = idOf(invalid)!;
    a.send({ type: 'publish', topic: 'platform:global', data: invalid });
    await pause(quiet);
    const forwarded = b.frames.some((f) => f.type === 'message' && idOf(f.data) === invalidId);
    const acked = a.frames.some((f) => f.type === 'ack' && f.data === invalidId);
    record(
      'refuse',
      !forwarded && !acked,
      forwarded
        ? 'The server forwarded an invalid envelope.'
        : acked
          ? 'The server acknowledged an invalid envelope.'
          : 'The server refused the invalid envelope.',
    );

    if (options.http) {
      const http = options.fetch ?? globalThis.fetch;
      // http-publish
      const viaHttp = testEnvelope('global', 'conformance:http');
      const httpId = idOf(viaHttp)!;
      try {
        const response = await http(`${options.http}/publish`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
          },
          body: JSON.stringify({ channel: 'platform:global', envelope: viaHttp }),
        });
        const body = (await response.json()) as { ack?: string };
        const arrived = await b.wait((f) => f.type === 'message' && idOf(f.data) === httpId, wait);
        record(
          'http-publish',
          body.ack === httpId && arrived !== null,
          body.ack !== httpId
            ? 'The answer has no ack with the messageId.'
            : arrived
              ? 'Acknowledged and forwarded.'
              : 'Acknowledged, but not forwarded.',
        );
      } catch (error) {
        record('http-publish', false, `The request failed: ${(error as Error).message}`);
      }

      // http-poll
      try {
        const headers = options.token ? { authorization: `Bearer ${options.token}` } : undefined;
        const first = (await (
          await http(`${options.http}/poll?channels=platform:global`, { headers })
        ).json()) as { cursor?: string };
        const polled = testEnvelope('global', 'conformance:poll');
        a.send({ type: 'publish', topic: 'platform:global', data: polled });
        const next = (await (
          await http(
            `${options.http}/poll?channels=platform:global&cursor=${encodeURIComponent(first.cursor ?? '')}`,
            { headers },
          )
        ).json()) as { envelopes?: Array<{ envelope: unknown }> };
        const found = (next.envelopes ?? []).some((e) => idOf(e.envelope) === idOf(polled));
        record(
          'http-poll',
          typeof first.cursor === 'string' && found,
          typeof first.cursor !== 'string'
            ? 'The first poll gave no cursor.'
            : found
              ? 'The poll after the cursor got the envelope.'
              : 'The poll after the cursor did not get the envelope.',
        );
      } catch (error) {
        record('http-poll', false, `The request failed: ${(error as Error).message}`);
      }
    }
  } finally {
    for (const client of clients) client.close();
  }
  return results;
}
