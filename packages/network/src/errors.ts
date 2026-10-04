/**
 * @fileoverview
 * @summary The errors of the Network subsystem.
 * @description
 * Every error extends {@linkcode NetworkError}, so a caller can catch all
 * network failures at once, or one kind at a time.
 *
 * ```text
 *   NetworkError            a fetch failed (no response)
 *   ├─ OfflineError         the platform is offline and the cache cannot answer
 *   ├─ NetworkTimeoutError  no response within the timeout
 *   ├─ RequestAbortedError  abort(), abortAll() or the caller's signal
 *   ├─ CircuitOpenError     the origin failed too often; wait for the cool-down
 *   └─ HttpError            a response with a status that is not 2xx (or 304 with a cache entry)
 *   ```
 *
 * @example
 * Telling the kinds apart
 * ```ts
 * try { await network.commands.get('/api/me'); }
 * catch (error) { if (error instanceof HttpError && error.status === 404) showNotFound(); }
 * ```
 *
 * @author MathAid
 */

import type { NetworkResponse } from './types';

/**
 * @summary A request failed. The base class of every Network error.
 * @example
 * Catching every network failure
 * ```ts
 * catch (error) { if (error instanceof NetworkError) showOfflineBanner(); }
 * ```
 * @public
 */
export class NetworkError extends Error {
  /**
   * @summary The name of the error: `NetworkError`.
   */
  override readonly name: string = 'NetworkError';

  /**
   * @summary Makes the error.
   * @param {string} message The message.
   * @param {string} requestId The id of the request.
   * @param {ErrorOptions} [options] The cause.
   */
  constructor(
    message: string,
    /**
     * @summary The id of the request.
     */
    readonly requestId: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

/**
 * @summary The platform is offline, and the cache cannot answer.
 * @example
 * Waiting for the network
 * ```ts
 * catch (error) { if (error instanceof OfflineError) await sync.commands.syncNow(); }
 * ```
 * @public
 */
export class OfflineError extends NetworkError {
  /**
   * @summary The name of the error: `OfflineError`.
   */
  override readonly name = 'OfflineError';
}

/**
 * @summary No response came within the timeout of the request.
 * @example
 * A longer timeout for a report
 * ```ts
 * catch (error) { if (error instanceof NetworkTimeoutError) retryWith({ timeoutMs: 120_000 }); }
 * ```
 * @public
 */
export class NetworkTimeoutError extends NetworkError {
  /**
   * @summary The name of the error: `NetworkTimeoutError`.
   */
  override readonly name = 'NetworkTimeoutError';
}

/**
 * @summary The request was aborted by `abort`, `abortAll` or the caller's signal.
 * @example
 * Ignoring a cancelled search
 * ```ts
 * catch (error) { if (error instanceof RequestAbortedError) return; }
 * ```
 * @public
 */
export class RequestAbortedError extends NetworkError {
  /**
   * @summary The name of the error: `RequestAbortedError`.
   */
  override readonly name = 'RequestAbortedError';
}

/**
 * @summary The origin failed too many times in a row, so the circuit breaker refuses requests for a while.
 * @example
 * Showing a degraded state
 * ```ts
 * catch (error) { if (error instanceof CircuitOpenError) showServiceDown(error.origin); }
 * ```
 * @public
 */
export class CircuitOpenError extends NetworkError {
  /**
   * @summary The name of the error: `CircuitOpenError`.
   */
  override readonly name = 'CircuitOpenError';

  /**
   * @summary Makes the error.
   * @param {string} requestId The id of the request.
   * @param {string} origin The origin whose breaker is open.
   * @param {number} retryAt When a trial request is allowed again, in Unix milliseconds.
   */
  constructor(
    requestId: string,
    /**
     * @summary The origin whose breaker is open.
     */
    readonly origin: string,
    /**
     * @summary When a trial request is allowed again, in Unix milliseconds.
     */
    readonly retryAt: number,
  ) {
    super(`[network] The circuit breaker of ${origin} is open.`, requestId);
  }
}

/**
 * @summary The server answered with a status that is not a success.
 * @example
 * Reading the body of an error
 * ```ts
 * catch (error) { if (error instanceof HttpError) console.warn(error.status, error.response.data); }
 * ```
 * @public
 */
export class HttpError extends NetworkError {
  /**
   * @summary The name of the error: `HttpError`.
   */
  override readonly name = 'HttpError';

  /**
   * @summary Makes the error.
   * @param {NetworkResponse<unknown>} response The response.
   */
  constructor(
    /**
     * @summary The response, with its status, headers and parsed body.
     */
    readonly response: NetworkResponse<unknown>,
  ) {
    super(`[network] ${response.status} for ${response.url}`, response.id);
  }

  /**
   * @summary The HTTP status of the response.
   * @returns {number} The status.
   */
  get status(): number {
    return this.response.status;
  }
}
