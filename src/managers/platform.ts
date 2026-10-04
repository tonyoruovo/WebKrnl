/**
 * @fileoverview
 * @summary The platform: assembles and wires all managers into one drop-in object.
 * @description
 * This is the M6 entry point. It constructs every manager in boot order,
 * wires the load-bearing integrations (the queue's admission gate to Global
 * State, analytics to a consent gate), and returns a
 * single object with a lifecycle. A fresh app calls `createPlatform`, then
 * `markReady`.
 *
 * ```text
 *   Global State -> Queue -> Notification
 *     -> Translation -> Analytics
 *   ```
 *
 * The Logger and Consent managers moved to `@platform/logger` and
 * `@platform/consent` (M4): warnings go to `options.warn`, and analytics asks
 * `options.analyticsConsent`, which denies by default. Crypto and Storage moved
 * to `@platform/crypto` and `@platform/storage` (M6). Network, Auth, Sync and
 * Realtime moved to `@platform/network`, `@platform/auth`, `@platform/sync`
 * and `@platform/realtime` (M7).
 *
 * Optional injectables (the analytics transport and consent) let tests and
 * alternate environments substitute their own implementations.
 *
 * @see {@linkcode createPlatform}
 * @author MathAid
 */

import { AnalyticsManager, type AnalyticsSnapshot } from './analytics/analytics.manager';
import { defaultQueueConfig } from './bus';
import { GlobalState } from './global/global-state.manager';
import { NotificationCenter } from './notification/notification.manager';
import { MessageQueue } from './queue/queue.manager';
import { TranslationManager } from './translation/translation.manager';

/**
 * @summary Options for {@linkcode createPlatform}.
 */
export interface PlatformOptions {
  /** The busy threshold for Global State. Defaults to 50. */
  busyThreshold?: number;
  /** The analytics transport. */
  analyticsTransport?: (snapshot: AnalyticsSnapshot) => Promise<void>;
  /** Whether analytics may collect. Defaults to `() => false`: no consent, no analytics. */
  analyticsConsent?: () => boolean;
}

/**
 * @summary The assembled platform.
 */
export interface Platform {
  readonly globalState: GlobalState;
  readonly queue: MessageQueue;
  readonly notifications: NotificationCenter;
  readonly translation: TranslationManager;
  readonly analytics: AnalyticsManager;
  /** Transitions Global State from INITIALIZING to IDLE. */
  markReady(): void;
  /** Stops the platform and blocks new work. */
  stop(): void;
  /** Tears down resources. */
  dispose(): void;
}

/**
 * @summary Creates and wires the full platform.
 * @description
 * Constructs every manager in boot order and wires the integrations. Optional
 * injectables let callers substitute the analytics transport and consent.
 *
 * @example
 * Example 1: Boot the platform
 * ```ts
 * const platform = await createPlatform({ analyticsConsent: () => consent.isGranted('analytics') });
 * platform.markReady();
 * ```
 *
 * @param {PlatformOptions} [options] The injectables.
 * @returns {Promise<Platform>} The assembled platform.
 */
export async function createPlatform(options: PlatformOptions = {}): Promise<Platform> {
  // 1. Global State
  const globalState = new GlobalState({ busyThreshold: options.busyThreshold });

  // 2. Message Queue, wired to Global State admission.
  const queue = new MessageQueue({
    config: defaultQueueConfig(),
    admission: (importance) => globalState.canAcceptWork(importance),
  });

  // 3. Notification Center
  const notifications = new NotificationCenter();

  // 4. Translation
  const translation = new TranslationManager();

  // 5. Analytics, gated by consent; fails closed.
  const analytics = new AnalyticsManager({
    transport: options.analyticsTransport,
    consent: options.analyticsConsent ?? (() => false),
  });

  return {
    globalState,
    queue,
    notifications,
    translation,
    analytics,
    markReady: () => globalState.markReady(),
    stop: () => globalState.stop(),
    // Nothing holds resources since M7; kept until the platform runs on the kernel (M10).
    dispose: () => {},
  };
}
