/**
 * @fileoverview
 * @summary The tab count: how many tabs of this origin have the platform open and shown.
 * @description
 * Implements docs/ARCHITECTURE.md §21.5. Each tab holds the Web Lock
 * `platform:tab:<tabId>` while its page is shown, and the count is the
 * number of these locks. The browser releases the lock of a tab that closes
 * or crashes, so the count never keeps a dead tab. A tab whose lock changes
 * tells the others on a `BroadcastChannel`, and they count again.
 *
 * ```text
 *   start, pageshow   --> take the lock 'platform:tab:<id>' --> post 'changed'
 *   pagehide          --> release it (a page in the back-forward cache does not count) --> post 'changed'
 *   'changed', visible again, every intervalMs while visible --> navigator.locks.query() --> count
 *
 *   without Web Locks: 'hello' / 'here' / 'bye' on the channel (a crashed tab stays counted)
 *   without both: 1
 *   ```
 *
 * @example
 * On its own
 * ```ts
 * const counter = createTabCounter('tab_1');
 * counter.count.subscribe(() => (badge.textContent = String(counter.count.getSnapshot())));
 * ```
 *
 * @author MathAid
 */

import { createStore, type View } from '@webkrnl/core';

import type { TabChannel } from './tab-identity';

/** @summary The prefix of the lock of each tab. @internal */
const LOCK_PREFIX = 'platform:tab:';

/** @summary The channel tabs tell each other about changes on. @internal */
const CHANNEL_NAME = 'platform:tabs';

/**
 * @summary The parts of `navigator.locks` that the tab count needs.
 * @public
 */
export interface TabLocks {
  /**
   * @summary Takes a lock and holds it until the callback's promise settles.
   * @param {string} name The name of the lock.
   * @param {() => Promise<void>} callback Runs when the lock is held.
   * @returns {Promise<void>} Settles when the lock is released.
   */
  request(name: string, callback: () => Promise<void>): Promise<void>;
  /**
   * @summary Lists the held and waiting locks of this origin.
   * @returns {Promise<{ held?: ReadonlyArray<{ name?: string }> }>} The locks.
   */
  query(): Promise<{ held?: ReadonlyArray<{ name?: string }> }>;
}

/**
 * @summary The page events that the tab count follows.
 * @public
 */
export interface TabPage {
  /**
   * @summary Adds a listener.
   * @param {'pagehide' | 'pageshow' | 'visibilitychange'} type The event.
   * @param {() => void} listener The listener.
   * @returns {void}
   */
  addEventListener(type: 'pagehide' | 'pageshow' | 'visibilitychange', listener: () => void): void;
  /**
   * @summary Removes a listener.
   * @param {'pagehide' | 'pageshow' | 'visibilitychange'} type The event.
   * @param {() => void} listener The listener.
   * @returns {void}
   */
  removeEventListener(
    type: 'pagehide' | 'pageshow' | 'visibilitychange',
    listener: () => void,
  ): void;
}

/**
 * @summary Options for {@linkcode createTabCounter}. Every option replaces a browser API, for tests.
 *
 * @example
 * Example 1: Without Web Locks
 * ```ts
 * createTabCounter('tab_1', { locks: null });
 * ```
 *
 * @example
 * Example 2: Counting more often
 * ```ts
 * createTabCounter('tab_1', { intervalMs: 5000 });
 * ```
 *
 * @public
 */
export interface TabCountOptions {
  /**
   * @summary The Web Locks. The default is `navigator.locks`; `null` uses the channel only.
   */
  readonly locks?: TabLocks | null;
  /**
   * @summary Opens the channel. The default opens a `BroadcastChannel`; returning `null` disables it.
   * @returns {TabChannel | null} The channel.
   */
  channel?(): TabChannel | null;
  /**
   * @summary The page events. The default is `globalThis` when it has `addEventListener`.
   */
  readonly page?: TabPage | null;
  /**
   * @summary Tells if the page is visible. The default reads `document.visibilityState`.
   * @returns {boolean} `true` when visible.
   */
  visible?(): boolean;
  /**
   * @summary The time between counts while the page is visible, in milliseconds. The default is 30 000.
   * @description It finds tabs that crashed. Messages on the channel make the other counts at once.
   */
  readonly intervalMs?: number;
}

/**
 * @summary A running tab count.
 * @public
 */
export interface TabCounter {
  /**
   * @summary The number of tabs of this origin with the platform open and shown, this tab included.
   */
  readonly count: View<number>;
  /**
   * @summary Releases the lock, tells the other tabs, and stops.
   * @returns {void}
   */
  close(): void;
}

/** A message on the channel. */
type Message =
  { readonly type: 'changed' } | { readonly type: 'hello' | 'here' | 'bye'; readonly id: string };

/**
 * @summary Starts counting the tabs of this origin.
 *
 * @example
 * Example 1: A badge
 * ```ts
 * const counter = createTabCounter(tabId);
 * counter.count.subscribe(() => (badge.textContent = `${counter.count.getSnapshot()} tabs`));
 * ```
 *
 * @example
 * Example 2: Stopping
 * ```ts
 * counter.close();
 * ```
 *
 * @param {string} tabId The id of this tab (unique among open tabs).
 * @param {TabCountOptions} [options] Replacements of the browser APIs.
 * @returns {TabCounter} The counter.
 *
 * @public
 */
export function createTabCounter(tabId: string, options: TabCountOptions = {}): TabCounter {
  const locks =
    options.locks !== undefined
      ? options.locks
      : typeof navigator !== 'undefined' && navigator.locks
        ? (navigator.locks as unknown as TabLocks)
        : null;
  const channel = (
    options.channel ??
    (() => (typeof BroadcastChannel === 'function' ? new BroadcastChannel(CHANNEL_NAME) : null))
  )();
  const page =
    options.page !== undefined
      ? options.page
      : typeof globalThis.addEventListener === 'function'
        ? (globalThis as unknown as TabPage)
        : null;
  const visible =
    options.visible ??
    (() => typeof document === 'undefined' || document.visibilityState !== 'hidden');
  const count = createStore(1);
  const set = (n: number) => {
    if (!closed && count.view.getSnapshot() !== n) count.set(n);
  };
  const post = (message: Message) => {
    try {
      channel?.postMessage(message);
    } catch {
      // A closed channel: nothing to tell.
    }
  };

  let closed = false;
  let shown = false;
  let release: (() => void) | null = null;
  const peers = new Set<string>(); // without Web Locks

  /** Counts the locks of the tabs. */
  const recount = async () => {
    if (!locks || closed) return;
    try {
      const { held = [] } = await locks.query();
      const names = new Set(held.map((l) => l.name ?? '').filter((n) => n.startsWith(LOCK_PREFIX)));
      set(Math.max(names.size, shown ? 1 : 0));
    } catch {
      // The query failed: keep the last count.
    }
  };

  const show = () => {
    if (closed || shown) return;
    shown = true;
    if (locks) {
      void locks
        .request(LOCK_PREFIX + tabId, () => {
          // The lock is held until `release` runs.
          const held = new Promise<void>((resolve) => (release = resolve));
          void recount().then(() => post({ type: 'changed' }));
          return held;
        })
        .catch(() => {});
    } else {
      set(peers.size + 1);
      post({ type: 'hello', id: tabId });
    }
  };

  const hide = () => {
    if (!shown) return;
    shown = false;
    if (locks) {
      const done = release;
      release = null;
      done?.();
      // The release is asynchronous: count after it.
      void Promise.resolve().then(() => post({ type: 'changed' }));
    } else {
      post({ type: 'bye', id: tabId });
    }
  };

  const onMessage = (event: MessageEvent) => {
    const message = event.data as Message;
    if (!message || typeof message !== 'object') return;
    if (message.type === 'changed') return void recount();
    if (locks || message.id === tabId) return;
    if (message.type === 'hello') {
      peers.add(message.id);
      if (shown) post({ type: 'here', id: tabId });
    } else if (message.type === 'here') {
      peers.add(message.id);
    } else if (message.type === 'bye') {
      peers.delete(message.id);
    }
    set(peers.size + (shown ? 1 : 0));
  };
  channel?.addEventListener('message', onMessage);

  const onVisibility = () => {
    if (visible()) void recount();
  };
  page?.addEventListener('pagehide', hide);
  page?.addEventListener('pageshow', show);
  page?.addEventListener('visibilitychange', onVisibility);
  const timer = locks
    ? setInterval(() => {
        if (visible()) void recount();
      }, options.intervalMs ?? 30_000)
    : undefined;
  (timer as { unref?: () => void } | undefined)?.unref?.();

  show();

  return {
    count: count.view,
    close() {
      if (closed) return;
      hide();
      closed = true;
      clearInterval(timer);
      page?.removeEventListener('pagehide', hide);
      page?.removeEventListener('pageshow', show);
      page?.removeEventListener('visibilitychange', onVisibility);
      channel?.removeEventListener('message', onMessage);
      // Let the last message leave before the channel closes.
      setTimeout(() => channel?.close(), 0);
    },
  };
}
