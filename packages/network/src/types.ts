/**
 * @fileoverview
 * @summary The types of the Network subsystem: requests, responses, interceptors, state and options.
 * @description
 * A caller gives a {@linkcode RequestConfig}. The Network turns it into a
 * {@linkcode PreparedRequest} (full URL, headers, encoded body), runs the
 * request interceptors, fetches, and returns a {@linkcode NetworkResponse}
 * (docs/ARCHITECTURE.md §19.1).
 *
 * @example
 * A request and its response
 * ```ts
 * const config: RequestConfig = { url: '/api/orders', query: { status: 'open' }, cache: 'network-first' };
 * const response: NetworkResponse<Order[]> = await network.commands.request(config);
 * ```
 *
 * @author MathAid
 */

import type { Importance, View } from '@webkrnl/core';

/**
 * @summary The HTTP methods.
 * @public
 */
export type HttpMethod = 'GET' | 'HEAD' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'OPTIONS';

/**
 * @summary Where a request takes its answer from.
 * @description
 * - `network-only`: always the network. The default.
 * - `network-first`: the network; the cache when the network fails or the platform is offline.
 * - `cache-first`: a fresh cache entry; else the network.
 * - `cache-only`: the cache, fresh or not; else an `OfflineError`.
 * @public
 */
export type CacheStrategy = 'network-only' | 'network-first' | 'cache-first' | 'cache-only';

/**
 * @summary How cached responses are kept in Storage, or `false` for memory only.
 * @description Encryption keeps private data private at rest. Compression
 * saves space for large responses. Each step costs time, so a call site can
 * turn either off. An encrypted write that is not possible keeps the
 * response in memory only; it is never stored in plain text instead.
 * @example
 * Example 1: The default
 * ```ts
 * const persist: CachePersistence = { encrypt: true, compress: false };
 * ```
 * @example
 * Example 2: Public, large data: compress, do not encrypt
 * ```ts
 * const persist: CachePersistence = { encrypt: false, compress: true };
 * ```
 * @public
 */
export type CachePersistence =
  | {
      /**
       * @summary Encrypts the stored response with the keys of `@webkrnl/crypto`. The default is `true`.
       */
      readonly encrypt?: boolean;
      /**
       * @summary Compresses the stored response with gzip. The default is `false`.
       */
      readonly compress?: boolean;
    }
  | false;

/**
 * @summary How the Network reads the body of a response.
 * @description `auto` reads JSON for a JSON content type, else text.
 * @public
 */
export type ResponseType = 'auto' | 'json' | 'text' | 'blob' | 'arrayBuffer';

/**
 * @summary What a caller asks for.
 *
 * @example
 * Example 1: A cached GET
 * ```ts
 * const config: RequestConfig = { url: '/api/products', cache: 'cache-first', cacheTtlMs: 60_000 };
 * ```
 *
 * @example
 * Example 2: A POST that is safe to retry
 * ```ts
 * const config: RequestConfig = { url: '/api/orders', method: 'POST', body: order, idempotencyKey: order.id };
 * ```
 *
 * @public
 */
export interface RequestConfig {
  /**
   * @summary The URL, absolute or relative to `baseUrl`.
   */
  readonly url: string;
  /**
   * @summary The method. The default is `GET`.
   */
  readonly method?: HttpMethod;
  /**
   * @summary The query parameters. `undefined` values are left out.
   */
  readonly query?: Readonly<Record<string, string | number | boolean | undefined>>;
  /**
   * @summary The headers.
   */
  readonly headers?: Readonly<Record<string, string>>;
  /**
   * @summary The body. A plain object or an array is sent as JSON.
   */
  readonly body?: unknown;
  /**
   * @summary The timeout, in milliseconds. The default is the `timeoutMs` option.
   */
  readonly timeoutMs?: number;
  /**
   * @summary The largest number of retries. The default is the `retries` option.
   */
  readonly retries?: number;
  /**
   * @summary A key that makes a non-idempotent request safe to retry. It is sent as `Idempotency-Key`.
   */
  readonly idempotencyKey?: string;
  /**
   * @summary The cache strategy. The default is `network-only`.
   */
  readonly cache?: CacheStrategy;
  /**
   * @summary How long a cached response stays fresh, in milliseconds. The default is the `cacheTtlMs` option.
   */
  readonly cacheTtlMs?: number;
  /**
   * @summary How this response is kept in Storage. The default is the `persistCache` option.
   */
  readonly cachePersist?: CachePersistence;
  /**
   * @summary How the body of the response is read. The default is `auto`.
   */
  readonly responseType?: ResponseType;
  /**
   * @summary The importance. Higher importance runs first when requests wait. The default is `MEDIUM`.
   */
  readonly importance?: Importance;
  /**
   * @summary Does not show the request as pending work in Global State.
   */
  readonly background?: boolean;
  /**
   * @summary Returns a response with a failure status instead of throwing an `HttpError`.
   */
  readonly allowErrorStatus?: boolean;
  /**
   * @summary The credentials mode of `fetch`. The default is `same-origin`.
   */
  readonly credentials?: RequestCredentials;
  /**
   * @summary Aborts the request.
   */
  readonly signal?: AbortSignal;
}

/**
 * @summary A request after the Network prepared it. Request interceptors receive and return it.
 *
 * @example
 * Example 1: Adding a header in an interceptor
 * ```ts
 * network.commands.intercept({ request: (r) => ({ ...r, headers: { ...r.headers, 'X-App': 'shop' } }) });
 * ```
 *
 * @example
 * Example 2: Checking the origin
 * ```ts
 * if (new URL(request.url).origin === location.origin) addToken(request);
 * ```
 *
 * @public
 */
export interface PreparedRequest {
  /**
   * @summary The id of the request.
   */
  readonly id: string;
  /**
   * @summary The full URL, with the query.
   */
  readonly url: string;
  /**
   * @summary The method.
   */
  readonly method: HttpMethod;
  /**
   * @summary The headers, with lower-case names.
   */
  readonly headers: Readonly<Record<string, string>>;
  /**
   * @summary The encoded body, or `null`.
   */
  readonly body: BodyInit | null;
  /**
   * @summary The number of the attempt, from 1.
   */
  readonly attempt: number;
}

/**
 * @summary The answer to a request.
 *
 * @example
 * Example 1: From the network
 * ```ts
 * // { id: 'r1', url: 'https://shop.example/api/me', status: 200, ok: true, data: { id: 'u1' }, fromCache: false, attempts: 1, ... }
 * ```
 *
 * @example
 * Example 2: From the cache after a 304
 * ```ts
 * // { status: 200, fromCache: true, revalidated: true, ... }
 * ```
 *
 * @template T The type of the body.
 * @public
 */
export interface NetworkResponse<T = unknown> {
  /**
   * @summary The id of the request.
   */
  readonly id: string;
  /**
   * @summary The full URL.
   */
  readonly url: string;
  /**
   * @summary The HTTP status.
   */
  readonly status: number;
  /**
   * @summary Tells if the status is a success (2xx).
   */
  readonly ok: boolean;
  /**
   * @summary The headers, with lower-case names.
   */
  readonly headers: Readonly<Record<string, string>>;
  /**
   * @summary The parsed body.
   */
  readonly data: T;
  /**
   * @summary Tells if the cache gave the answer.
   */
  readonly fromCache: boolean;
  /**
   * @summary Tells if the server confirmed a cached entry with a `304`.
   */
  readonly revalidated: boolean;
  /**
   * @summary The number of attempts.
   */
  readonly attempts: number;
  /**
   * @summary The time from the first attempt to the answer, in milliseconds.
   */
  readonly durationMs: number;
}

/**
 * @summary Changes requests and reacts to responses. Other subsystems add interceptors, for example Auth.
 *
 * @example
 * Example 1: A token and a refresh on 401
 * ```ts
 * const remove = network.commands.intercept({
 *   request: (r) => ({ ...r, headers: { ...r.headers, authorization: `Bearer ${token}` } }),
 *   response: async (response) => (response.status === 401 && (await refresh()) ? 'retry' : undefined),
 * });
 * ```
 *
 * @example
 * Example 2: Logging slow requests
 * ```ts
 * network.commands.intercept({ response: (r) => void (r.durationMs > 2000 && console.warn('slow', r.url)) });
 * ```
 *
 * @public
 */
export interface Interceptor {
  /**
   * @summary Changes a request before each attempt.
   * @example
   * Adding a header
   * ```ts
   * request: (r) => ({ ...r, headers: { ...r.headers, 'x-trace': traceId } })
   * ```
   * @param {PreparedRequest} request The request.
   * @returns {PreparedRequest | Promise<PreparedRequest>} The request to send.
   */
  request?(request: PreparedRequest): PreparedRequest | Promise<PreparedRequest>;
  /**
   * @summary Sees each response. Returning `retry` sends the request one more time (one time per request).
   * @example
   * Refreshing a token
   * ```ts
   * response: async (r) => (r.status === 401 && (await refresh()) ? 'retry' : undefined)
   * ```
   * @param {NetworkResponse<unknown>} response The response.
   * @param {PreparedRequest} request The request that got it.
   * @returns {'retry' | void | Promise<'retry' | void>} `retry` to send the request again.
   */
  response?(
    response: NetworkResponse<unknown>,
    request: PreparedRequest,
  ): 'retry' | void | Promise<'retry' | void>;
}

/**
 * @summary The state of the circuit breaker of one origin.
 * @public
 */
export interface BreakerState {
  /**
   * @summary `closed` lets requests through. `open` refuses them. `half-open` lets one trial request through.
   */
  readonly state: 'closed' | 'open' | 'half-open';
  /**
   * @summary The number of failures in a row.
   */
  readonly failures: number;
  /**
   * @summary When the breaker allows a trial request, in Unix milliseconds, or `null`.
   */
  readonly retryAt: number | null;
}

/**
 * @summary The state of the Network subsystem.
 * @example
 * Example 1: Busy and online
 * ```ts
 * // { online: true, inFlight: 2, waiting: 0, breakers: {}, requests: 40, failures: 1, cacheHits: 12, cacheMisses: 5 }
 * ```
 * @example
 * Example 2: An origin is down
 * ```ts
 * // { breakers: { 'https://api.example': { state: 'open', failures: 5, retryAt: 1700000030000 } }, ... }
 * ```
 * @public
 */
export interface NetworkData {
  /**
   * @summary Tells if the platform is online.
   */
  online: boolean;
  /**
   * @summary The number of requests that run now.
   */
  inFlight: number;
  /**
   * @summary The number of requests that wait for a free slot.
   */
  waiting: number;
  /**
   * @summary The circuit breakers that are not closed, by origin.
   */
  breakers: Record<string, BreakerState>;
  /**
   * @summary The number of requests.
   */
  requests: number;
  /**
   * @summary The number of requests that failed.
   */
  failures: number;
  /**
   * @summary The number of answers from the cache.
   */
  cacheHits: number;
  /**
   * @summary The number of cache lookups without a usable entry.
   */
  cacheMisses: number;
}

/**
 * @summary Options of {@linkcode createNetwork}.
 * @example
 * Example 1: An API client
 * ```ts
 * createNetwork({ baseUrl: 'https://api.shop.example', timeoutMs: 10_000 });
 * ```
 * @example
 * Example 2: A fake fetch for tests
 * ```ts
 * createNetwork({ fetch: async () => new Response('{}', { headers: { 'content-type': 'application/json' } }) });
 * ```
 * @public
 */
export interface NetworkOptions {
  /**
   * @summary The base of relative URLs. The default is `location.href`, or `http://localhost/` without a location.
   */
  readonly baseUrl?: string;
  /**
   * @summary The default timeout, in milliseconds. The default is 30 000.
   */
  readonly timeoutMs?: number;
  /**
   * @summary The default largest number of retries. The default is 3.
   */
  readonly retries?: number;
  /**
   * @summary The base wait of the backoff, in milliseconds. The default is 300.
   */
  readonly retryBaseMs?: number;
  /**
   * @summary The largest number of requests at the same time. The default is 6.
   */
  readonly maxConcurrent?: number;
  /**
   * @summary The default time to live of cached responses, in milliseconds. The default is 300 000.
   */
  readonly cacheTtlMs?: number;
  /**
   * @summary The largest number of cached responses in memory. The default is 200.
   */
  readonly cacheEntries?: number;
  /**
   * @summary How cached responses are kept in Storage when it runs. The default is `{ encrypt: true, compress: false }`.
   */
  readonly persistCache?: CachePersistence;
  /**
   * @summary The circuit breaker, or `false` to turn it off.
   */
  readonly breaker?:
    | {
        /**
         * @summary The failures in a row that open the breaker. The default is 5.
         */
        readonly threshold?: number;
        /**
         * @summary How long the breaker stays open, in milliseconds. The default is 30 000.
         */
        readonly cooldownMs?: number;
      }
    | false;
  /**
   * @summary The `fetch` function. The default is the global `fetch`.
   */
  readonly fetch?: typeof fetch;
  /**
   * @summary The clock, in Unix milliseconds. The default is `Date.now`.
   */
  readonly now?: () => number;
  /**
   * @summary The random source of the backoff jitter. The default uses `crypto.getRandomValues`.
   */
  readonly random?: () => number;
}

/**
 * @summary The control interface of the Network subsystem.
 * @public
 */
export interface NetworkControl {
  /**
   * @summary The commands.
   */
  readonly commands: {
    /**
     * @summary Sends a request.
     * @example
     * A request
     * ```ts
     * const { data } = await commands.request<Order[]>({ url: '/api/orders' });
     * ```
     * @param {RequestConfig} config The request.
     * @returns {Promise<NetworkResponse<T>>} The response.
     * @throws {NetworkError} When the request fails: `HttpError`, `OfflineError`, `NetworkTimeoutError`, `RequestAbortedError` or `CircuitOpenError`.
     */
    request<T = unknown>(config: RequestConfig): Promise<NetworkResponse<T>>;
    /**
     * @summary Sends a `GET` request.
     * @example
     * Reading
     * ```ts
     * const me = (await commands.get<User>('/api/me')).data;
     * ```
     * @param {string} url The URL.
     * @param {Omit<RequestConfig, 'url' | 'method'>} [config] More options.
     * @returns {Promise<NetworkResponse<T>>} The response.
     * @throws {NetworkError} When the request fails.
     */
    get<T = unknown>(
      url: string,
      config?: Omit<RequestConfig, 'url' | 'method'>,
    ): Promise<NetworkResponse<T>>;
    /**
     * @summary Sends a `POST` request.
     * @example
     * Creating
     * ```ts
     * await commands.post('/api/orders', order, { idempotencyKey: order.id });
     * ```
     * @param {string} url The URL.
     * @param {unknown} body The body.
     * @param {Omit<RequestConfig, 'url' | 'method' | 'body'>} [config] More options.
     * @returns {Promise<NetworkResponse<T>>} The response.
     * @throws {NetworkError} When the request fails.
     */
    post<T = unknown>(
      url: string,
      body: unknown,
      config?: Omit<RequestConfig, 'url' | 'method' | 'body'>,
    ): Promise<NetworkResponse<T>>;
    /**
     * @summary Sends a `PUT` request.
     * @example
     * Replacing
     * ```ts
     * await commands.put(`/api/orders/${id}`, order);
     * ```
     * @param {string} url The URL.
     * @param {unknown} body The body.
     * @param {Omit<RequestConfig, 'url' | 'method' | 'body'>} [config] More options.
     * @returns {Promise<NetworkResponse<T>>} The response.
     * @throws {NetworkError} When the request fails.
     */
    put<T = unknown>(
      url: string,
      body: unknown,
      config?: Omit<RequestConfig, 'url' | 'method' | 'body'>,
    ): Promise<NetworkResponse<T>>;
    /**
     * @summary Sends a `PATCH` request.
     * @example
     * Changing a field
     * ```ts
     * await commands.patch(`/api/orders/${id}`, { status: 'paid' });
     * ```
     * @param {string} url The URL.
     * @param {unknown} body The body.
     * @param {Omit<RequestConfig, 'url' | 'method' | 'body'>} [config] More options.
     * @returns {Promise<NetworkResponse<T>>} The response.
     * @throws {NetworkError} When the request fails.
     */
    patch<T = unknown>(
      url: string,
      body: unknown,
      config?: Omit<RequestConfig, 'url' | 'method' | 'body'>,
    ): Promise<NetworkResponse<T>>;
    /**
     * @summary Sends a `DELETE` request.
     * @example
     * Deleting
     * ```ts
     * await commands.delete(`/api/orders/${id}`);
     * ```
     * @param {string} url The URL.
     * @param {Omit<RequestConfig, 'url' | 'method'>} [config] More options.
     * @returns {Promise<NetworkResponse<T>>} The response.
     * @throws {NetworkError} When the request fails.
     */
    delete<T = unknown>(
      url: string,
      config?: Omit<RequestConfig, 'url' | 'method'>,
    ): Promise<NetworkResponse<T>>;
    /**
     * @summary Aborts one request.
     * @example
     * Cancelling a search
     * ```ts
     * commands.abort(searchId);
     * ```
     * @param {string} requestId The id of the request (from `NetworkResponse.id` or `requestIds()`).
     * @returns {boolean} `true` when a running or waiting request was aborted.
     */
    abort(requestId: string): boolean;
    /**
     * @summary Aborts every running and waiting request.
     * @example
     * At sign-out
     * ```ts
     * commands.abortAll();
     * ```
     * @returns {number} The number of requests aborted.
     */
    abortAll(): number;
    /**
     * @summary Returns the ids of the running and waiting requests.
     * @example
     * Listing
     * ```ts
     * commands.requestIds(); // ['r7', 'r8']
     * ```
     * @returns {string[]} The ids.
     */
    requestIds(): string[];
    /**
     * @summary Deletes cached responses whose URL starts with a prefix, or all cached responses.
     * @example
     * After an order is placed
     * ```ts
     * await commands.invalidate('https://shop.example/api/orders');
     * ```
     * @param {string} [prefix] The prefix of the full URL.
     * @returns {Promise<number>} The number of entries deleted from memory.
     */
    invalidate(prefix?: string): Promise<number>;
    /**
     * @summary Adds an interceptor.
     * @example
     * A header on every request
     * ```ts
     * const remove = commands.intercept({ request: (r) => ({ ...r, headers: { ...r.headers, 'x-app': 'shop' } }) });
     * ```
     * @param {Interceptor} interceptor The interceptor.
     * @returns {() => void} Removes the interceptor.
     */
    intercept(interceptor: Interceptor): () => void;
  };
  /**
   * @summary The views.
   */
  readonly views: {
    /**
     * @summary The state of the subsystem.
     */
    readonly state: View<Partial<NetworkData>>;
  };
}
