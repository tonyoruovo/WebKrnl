/**
 * @fileoverview
 * @summary The types of the Realtime subsystem: frames, protocol, sockets, state, options and the control interface.
 * @description
 * The processor `socket` owns the `WebSocket` and speaks a protocol of
 * {@linkcode Frame} objects. The unit on the main thread keeps the topics,
 * the listeners and the presence map (docs/ARCHITECTURE.md §19.4).
 *
 * @example
 * The default JSON frames
 * ```ts
 * // client --> server  {"type":"subscribe","topic":"chat"}
 * // server --> client  {"type":"message","topic":"chat","data":{"text":"hi"}}
 * ```
 *
 * @author MathAid
 */

import type { HostKind, View } from '@webkrnl/core';

import type { GlobalOptions, GlobalWindowRelay } from './global';

/**
 * @summary One message of the Realtime protocol.
 * @example
 * Example 1: A subscription
 * ```ts
 * const frame: Frame = { type: 'subscribe', topic: 'chat' };
 * ```
 * @example
 * Example 2: Presence
 * ```ts
 * const frame: Frame = { type: 'presence', data: { peer: 'u2', status: 'away' } };
 * ```
 * @public
 */
export interface Frame {
  /**
   * @summary The kind of frame.
   */
  readonly type:
    | 'subscribe'
    | 'unsubscribe'
    | 'publish'
    | 'message'
    | 'ping'
    | 'pong'
    | 'presence'
    | 'auth'
    | 'ack';
  /**
   * @summary The topic, for subscribe, unsubscribe, publish and message.
   */
  readonly topic?: string;
  /**
   * @summary The data: the message, the presence of a peer, or the token for `auth`.
   */
  readonly data?: unknown;
}

/**
 * @summary Turns frames into socket data and back. Both functions run in the processor, so they must be self-contained.
 * @example
 * Example 1: The default
 * ```ts
 * const protocol: RealtimeProtocol = { encode: (frame) => JSON.stringify(frame), decode: (raw) => JSON.parse(String(raw)) };
 * ```
 * @example
 * Example 2: A server with another shape
 * ```ts
 * const protocol: RealtimeProtocol = {
 *   encode: (f) => JSON.stringify({ op: f.type, ch: f.topic, d: f.data }),
 *   decode: (raw) => { const m = JSON.parse(String(raw)); return { type: m.op, topic: m.ch, data: m.d }; },
 * };
 * ```
 * @public
 */
export interface RealtimeProtocol {
  /**
   * @summary Turns a frame into socket data.
   * @example
   * Encoding
   * ```ts
   * encode: (frame) => JSON.stringify(frame)
   * ```
   * @param {Frame} frame The frame.
   * @returns {string | ArrayBuffer} The data to send.
   */
  encode(frame: Frame): string | ArrayBuffer;
  /**
   * @summary Turns socket data into a frame, or `null` to ignore it.
   * @example
   * Decoding
   * ```ts
   * decode: (raw) => JSON.parse(String(raw))
   * ```
   * @param {string | ArrayBuffer} raw The data that arrived.
   * @returns {Frame | null} The frame.
   */
  decode(raw: string | ArrayBuffer): Frame | null;
}

/**
 * @summary The part of a `WebSocket` that the processor uses. Tests give a fake.
 * @public
 */
export interface SocketLike {
  /**
   * @summary The state: 0 connecting, 1 open, 2 closing, 3 closed.
   */
  readonly readyState: number;
  /**
   * @summary Sends data.
   * @example
   * Sending
   * ```ts
   * socket.send('{"type":"ping"}');
   * ```
   * @param {string | ArrayBuffer} data The data.
   * @returns {void}
   */
  send(data: string | ArrayBuffer): void;
  /**
   * @summary Closes the socket.
   * @example
   * Closing
   * ```ts
   * socket.close(1000, 'bye');
   * ```
   * @param {number} [code] The close code.
   * @param {string} [reason] The reason.
   * @returns {void}
   */
  close(code?: number, reason?: string): void;
  /**
   * @summary Called when the socket opens.
   */
  onopen: ((event: unknown) => void) | null;
  /**
   * @summary Called with each message.
   */
  onmessage: ((event: { readonly data: unknown }) => void) | null;
  /**
   * @summary Called when the socket closes.
   */
  onclose: ((event: { readonly code?: number; readonly reason?: string }) => void) | null;
  /**
   * @summary Called on an error.
   */
  onerror: ((event: unknown) => void) | null;
}

/**
 * @summary Makes a socket. The default is `new WebSocket(url, protocols)`.
 * @public
 */
export type SocketFactory = (url: string, protocols?: string | string[]) => SocketLike;

/**
 * @summary The status of the socket.
 * @public
 */
export type RealtimeStatus = 'connecting' | 'open' | 'closing' | 'closed' | 'reconnecting';

/**
 * @summary The presence of one peer.
 * @public
 */
export interface Presence {
  /**
   * @summary `online`, `away` or `offline`.
   */
  readonly status: 'online' | 'away' | 'offline';
  /**
   * @summary When the peer last sent news, in Unix milliseconds.
   */
  readonly lastSeen: number;
}

/**
 * @summary The state of Realtime.
 * @example
 * Example 1: Open
 * ```ts
 * // { host: 'dedicated', status: 'open', attempts: 0, lastError: null, topics: ['chat'], presence: { u2: { status: 'online', lastSeen: 1700000000000 } }, dropped: 0 }
 * ```
 * @example
 * Example 2: Reconnecting
 * ```ts
 * // { status: 'reconnecting', attempts: 3, lastError: 'The socket closed (1006).', ... }
 * ```
 * @public
 */
export interface RealtimeData {
  /**
   * @summary The host of the socket processor, or `null` before it starts.
   */
  host: HostKind | null;
  /**
   * @summary The status of the socket.
   */
  status: RealtimeStatus;
  /**
   * @summary The reconnect attempts since the last open.
   */
  attempts: number;
  /**
   * @summary The last error, or `null`.
   */
  lastError: string | null;
  /**
   * @summary The topics with at least one listener.
   */
  topics: string[];
  /**
   * @summary The peers, by id.
   */
  presence: Record<string, Presence>;
  /**
   * @summary The published messages that the full buffer dropped.
   */
  dropped: number;
}

/**
 * @summary The payload of `realtime:connection-changed`.
 * @public
 */
export interface ConnectionChanged {
  /**
   * @summary The status before.
   */
  readonly from: RealtimeStatus;
  /**
   * @summary The status now.
   */
  readonly to: RealtimeStatus;
  /**
   * @summary The reconnect attempts.
   */
  readonly attempts: number;
}

/**
 * @summary The payload of `realtime:message`, for topics subscribed with `broadcast: true`.
 * @public
 */
export interface RealtimeMessage {
  /**
   * @summary The topic.
   */
  readonly topic: string;
  /**
   * @summary The data.
   */
  readonly data: unknown;
  /**
   * @summary When it arrived, in Unix milliseconds.
   */
  readonly receivedAt: number;
}

/**
 * @summary Options of {@linkcode createRealtime}.
 * @example
 * Example 1: An app
 * ```ts
 * createRealtime({ url: 'wss://rt.shop.example/socket', auth: 'message' });
 * ```
 * @example
 * Example 2: A test with a fake socket, on the main thread
 * ```ts
 * createRealtime({ url: 'ws://test', hosts: ['virtual'], socket: (url) => new FakeSocket(url) });
 * ```
 * @public
 */
export interface RealtimeOptions {
  /**
   * @summary The URL of the socket server.
   */
  readonly url: string;
  /**
   * @summary The WebSocket subprotocols.
   */
  readonly protocols?: string | string[];
  /**
   * @summary The hosts to try, in order. The default is `['dedicated', 'virtual']`.
   */
  readonly hosts?: readonly HostKind[];
  /**
   * @summary Makes the socket on the main thread. A worker always uses `WebSocket`.
   */
  readonly socket?: SocketFactory;
  /**
   * @summary The protocol. The default is JSON frames.
   */
  readonly protocol?: RealtimeProtocol;
  /**
   * @summary How the access token of Auth reaches the server: in the first frame, in the URL, or not at all (the default).
   * @description Prefer `message`: a URL can end up in the logs of servers and proxies, and a frame does not.
   */
  readonly auth?: 'query' | 'message' | false;
  /**
   * @summary Connects at start. The default is `true`.
   */
  readonly autoConnect?: boolean;
  /**
   * @summary The time between pings, in milliseconds. The default is 25 000.
   */
  readonly heartbeatMs?: number;
  /**
   * @summary How long to wait for a pong, in milliseconds. The default is 10 000.
   */
  readonly heartbeatTimeoutMs?: number;
  /**
   * @summary The reconnect attempts before Realtime gives up. The default is no limit.
   */
  readonly maxAttempts?: number;
  /**
   * @summary The base wait of the reconnect backoff, in milliseconds. The default is 500.
   */
  readonly retryBaseMs?: number;
  /**
   * @summary The published messages kept while disconnected. The default is 100.
   */
  readonly publishBuffer?: number;
  /**
   * @summary How long a peer without news stays present, in milliseconds. The default is 60 000.
   */
  readonly presenceTimeoutMs?: number;
  /**
   * @summary Turns on the Global transport: Global broadcasts and the Window relay through the server (docs/ARCHITECTURE.md §20).
   */
  readonly global?: GlobalOptions;
}

/**
 * @summary The control interface of Realtime.
 * @public
 */
export interface RealtimeControl {
  /**
   * @summary The commands.
   */
  readonly commands: {
    /**
     * @summary Opens the socket, or opens it again with the current token.
     * @example
     * After a sign-in
     * ```ts
     * await commands.connect();
     * ```
     * @returns {Promise<void>} Resolves when the processor started to connect.
     */
    connect(): Promise<void>;
    /**
     * @summary Closes the socket. It does not reconnect until `connect`.
     * @example
     * At sign-out
     * ```ts
     * await commands.disconnect();
     * ```
     * @returns {Promise<void>} Resolves when the processor closed the socket.
     */
    disconnect(): Promise<void>;
    /**
     * @summary Listens to a topic. The first listener subscribes on the server.
     * @example
     * A chat room
     * ```ts
     * const stop = commands.subscribe('chat:42', (data) => render(data));
     * ```
     * @param {string} topic The topic.
     * @param {Function} listener Gets the data of each message.
     * @param {object} [options] `broadcast: true` also sends each message as `realtime:message`.
     * @returns {() => void} Stops listening. The last one unsubscribes on the server.
     */
    subscribe(
      topic: string,
      listener: (data: unknown) => void,
      options?: { readonly broadcast?: boolean },
    ): () => void;
    /**
     * @summary Sends data to a topic. While disconnected, it waits in a bounded buffer.
     * @example
     * Sending a chat message
     * ```ts
     * await commands.publish('chat:42', { text: 'hi' });
     * ```
     * @param {string} topic The topic.
     * @param {unknown} data The data. It must be structured-cloneable.
     * @returns {Promise<void>} Resolves when the processor sent or buffered it.
     */
    publish(topic: string, data: unknown): Promise<void>;
    /**
     * @summary Returns the presence of one peer, or `undefined`.
     * @example
     * A status dot
     * ```ts
     * commands.presence('u2')?.status; // 'online'
     * ```
     * @param {string} peer The id of the peer.
     * @returns {Presence | undefined} The presence.
     */
    presence(peer: string): Presence | undefined;
    /**
     * @summary Returns the Window relay of the Global transport, or `null` without the option `global`.
     * @description The window transport of `@webkrnl/hub` uses it (docs/ARCHITECTURE.md §20.2).
     * @example
     * In the hub
     * ```ts
     * client.setRelay(realtime.commands.windowRelay());
     * ```
     * @returns {GlobalWindowRelay | null} The relay.
     */
    windowRelay(): GlobalWindowRelay | null;
  };
  /**
   * @summary The views.
   */
  readonly views: {
    /**
     * @summary The state of Realtime.
     */
    readonly state: View<Partial<RealtimeData>>;
  };
}
