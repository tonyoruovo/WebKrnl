/**
 * @fileoverview
 * @summary The circuit breakers of the Network: one for each origin.
 * @description
 * A breaker counts the failures in a row of one origin. At the threshold it
 * opens, and requests to that origin fail at once. After the cool-down, one
 * trial request goes through (half-open). A success closes the breaker, and a
 * failure opens it again (docs/ARCHITECTURE.md §19.1).
 *
 * ```text
 *   closed --(threshold failures)--> open --(cool-down)--> half-open --success--> closed
 *                                      ^                       |
 *                                      +-------failure---------+
 *   ```
 *
 * @example
 * Guarding a request
 * ```ts
 * const breakers = new Breakers({ threshold: 5, cooldownMs: 30_000 }, Date.now);
 * if (!breakers.allow(origin)) throw new CircuitOpenError(id, origin, breakers.state(origin).retryAt!);
 * ```
 *
 * @author MathAid
 */

import type { BreakerState } from './types';

interface Entry {
  failures: number;
  openedAt: number | null;
  trial: boolean;
}

/**
 * @summary The circuit breakers of all origins.
 * @example
 * Example 1: Recording results
 * ```ts
 * breakers.success(origin);
 * breakers.failure(origin);
 * ```
 * @example
 * Example 2: Reading a state
 * ```ts
 * breakers.state('https://api.example'); // { state: 'open', failures: 5, retryAt: 1700000030000 }
 * ```
 * @public
 */
export class Breakers {
  readonly #entries = new Map<string, Entry>();

  /**
   * @summary Makes the breakers.
   * @param {object} options The threshold and the cool-down.
   * @param {Function} now The clock, in Unix milliseconds.
   */
  constructor(
    private readonly options: { readonly threshold: number; readonly cooldownMs: number },
    private readonly now: () => number,
  ) {}

  /**
   * @summary Tells if a request to an origin may go out now.
   * @description When the cool-down is over, it lets one trial request through.
   * @example
   * Checking
   * ```ts
   * if (breakers.allow(origin)) send();
   * ```
   * @param {string} origin The origin.
   * @returns {boolean} `true` when the request may go out.
   */
  allow(origin: string): boolean {
    const entry = this.#entries.get(origin);
    if (!entry || entry.openedAt === null) return true;
    if (this.now() - entry.openedAt < this.options.cooldownMs || entry.trial) return false;
    entry.trial = true;
    return true;
  }

  /**
   * @summary Records a success: the breaker closes.
   * @example
   * After a response
   * ```ts
   * breakers.success(origin);
   * ```
   * @param {string} origin The origin.
   * @returns {void}
   */
  success(origin: string): void {
    this.#entries.delete(origin);
  }

  /**
   * @summary Records a failure: the breaker opens at the threshold, or again after a failed trial.
   * @example
   * After a network error
   * ```ts
   * breakers.failure(origin);
   * ```
   * @param {string} origin The origin.
   * @returns {void}
   */
  failure(origin: string): void {
    const entry = this.#entries.get(origin) ?? { failures: 0, openedAt: null, trial: false };
    entry.failures++;
    if (entry.trial || entry.failures >= this.options.threshold) {
      entry.openedAt = this.now();
      entry.trial = false;
    }
    this.#entries.set(origin, entry);
  }

  /**
   * @summary Returns the state of the breaker of an origin.
   * @example
   * Reading
   * ```ts
   * breakers.state(origin).state; // 'closed'
   * ```
   * @param {string} origin The origin.
   * @returns {BreakerState} The state.
   */
  state(origin: string): BreakerState {
    const entry = this.#entries.get(origin);
    if (!entry) return { state: 'closed', failures: 0, retryAt: null };
    if (entry.openedAt === null)
      return { state: 'closed', failures: entry.failures, retryAt: null };
    const retryAt = entry.openedAt + this.options.cooldownMs;
    return {
      state: entry.trial || this.now() >= retryAt ? 'half-open' : 'open',
      failures: entry.failures,
      retryAt,
    };
  }

  /**
   * @summary Returns the states of the breakers that are not closed.
   * @example
   * For the state view
   * ```ts
   * breakers.snapshot(); // { 'https://api.example': { state: 'open', ... } }
   * ```
   * @returns {Record<string, BreakerState>} The states, by origin.
   */
  snapshot(): Record<string, BreakerState> {
    const out: Record<string, BreakerState> = {};
    for (const origin of this.#entries.keys()) {
      const state = this.state(origin);
      if (state.state !== 'closed') out[origin] = state;
    }
    return out;
  }
}
