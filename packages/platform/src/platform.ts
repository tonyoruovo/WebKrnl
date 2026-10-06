/**
 * @fileoverview
 * @summary The orchestrator: one call that boots a chosen set of WebKrnl subsystems, wired together.
 * @description
 * Implements docs/ARCHITECTURE.md §22.2. Each subsystem package leaves some
 * wiring to the app: the Queue router, the fan-out of the Notification
 * Center, the kernel persistence, the appearance settings. The platform does
 * it once, with the defaults of the design.
 *
 * ```text
 *   createPlatform({ appName, storage, settings, translation: {...}, auth: {...}, units })
 *     always    Global State, Queue + Notification Center (router, fan-out), Logger
 *     default   window (hub), crypto, storage, consent, settings, network, sync, translation, design-system
 *     on demand auth (handlers), realtime (url), analytics (endpoint or send)
 *     wiring    persistence = createStatePersistence('<appName>-state'), APPEARANCE_SETTINGS in Settings,
 *               onError, the route source; then the units of the app
 *   platform.start() --> kernel.start(); platform.unit('settings') --> SettingsControl
 *   ```
 *
 * @example
 * A shop
 * ```ts
 * const platform = createPlatform({ appName: 'shop', translation: { supportedLocales: ['en', 'fr'] } });
 * await platform.start();
 * platform.unit('settings')?.commands.set('dataSaver', true);
 * ```
 *
 * @author MathAid
 */

import {
  ANALYTICS_ID,
  createAnalytics,
  type AnalyticsControl,
  type AnalyticsOptions,
} from '@webkrnl/analytics';
import { AUTH_ID, createAuth, type AuthControl, type AuthOptions } from '@webkrnl/auth';
import {
  CONSENT_ID,
  createConsent,
  type ConsentControl,
  type ConsentOptions,
} from '@webkrnl/consent';
import {
  Kernel,
  type KernelOptions,
  type RouteSource,
  type StatePersistence,
  type SubsystemDefinition,
} from '@webkrnl/core';
import { CRYPTO_ID, createCrypto, type CryptoControl, type CryptoOptions } from '@webkrnl/crypto';
import {
  APPEARANCE_SETTINGS,
  DESIGN_SYSTEM_ID,
  createDesignSystem,
  type DesignSystemControl,
  type DesignSystemOptions,
} from '@webkrnl/design-system';
import {
  GLOBAL_STATE_ID,
  createGlobalState,
  type GlobalStateControl,
  type GlobalStateOptions,
} from '@webkrnl/global-state';
import {
  WINDOW_TRANSPORT_ID,
  createWindowTransport,
  type WindowClientOptions,
  type WindowTransportControl,
} from '@webkrnl/hub';
import { LOGGER_ID, createLogger, type LoggerControl, type LoggerOptions } from '@webkrnl/logger';
import {
  NETWORK_ID,
  createNetwork,
  type NetworkControl,
  type NetworkOptions,
} from '@webkrnl/network';
import {
  NOTIFICATION_ID,
  createNotificationCenter,
  type NotificationControl,
  type NotificationOptions,
} from '@webkrnl/notification';
import { QUEUE_ID, createQueue, type QueueControl, type QueueOptions } from '@webkrnl/queue';
import {
  REALTIME_ID,
  createRealtime,
  type RealtimeControl,
  type RealtimeOptions,
} from '@webkrnl/realtime';
import {
  SETTINGS_ID,
  createSettings,
  type SettingsControl,
  type SettingsOptions,
} from '@webkrnl/settings';
import {
  STORAGE_ID,
  createStatePersistence,
  createStorage,
  type StorageControl,
  type StorageOptions,
} from '@webkrnl/storage';
import { SYNC_ID, createSync, type SyncControl, type SyncOptions } from '@webkrnl/sync';
import {
  TRANSLATION_ID,
  createTranslation,
  type TranslationControl,
  type TranslationOptions,
} from '@webkrnl/translation';

/**
 * @summary The control interface of each subsystem of the catalogue, by id.
 *
 * @example
 * A typed lookup
 * ```ts
 * const settings: PlatformControls['settings'] | undefined = platform.unit('settings');
 * ```
 *
 * @public
 */
export interface PlatformControls {
  /**
   * @summary Global State.
   */
  readonly 'global-state': GlobalStateControl;
  /**
   * @summary The Queue.
   */
  readonly queue: QueueControl;
  /**
   * @summary The Notification Center.
   */
  readonly notification: NotificationControl;
  /**
   * @summary The Logger.
   */
  readonly logger: LoggerControl;
  /**
   * @summary The Window transport (`@webkrnl/hub`).
   */
  readonly window: WindowTransportControl;
  /**
   * @summary Crypto.
   */
  readonly crypto: CryptoControl;
  /**
   * @summary Storage.
   */
  readonly storage: StorageControl;
  /**
   * @summary Consent.
   */
  readonly consent: ConsentControl;
  /**
   * @summary Settings.
   */
  readonly settings: SettingsControl;
  /**
   * @summary Network.
   */
  readonly network: NetworkControl;
  /**
   * @summary Auth.
   */
  readonly auth: AuthControl;
  /**
   * @summary Sync.
   */
  readonly sync: SyncControl;
  /**
   * @summary Realtime.
   */
  readonly realtime: RealtimeControl;
  /**
   * @summary Translation.
   */
  readonly translation: TranslationControl;
  /**
   * @summary Analytics.
   */
  readonly analytics: AnalyticsControl;
  /**
   * @summary The Design System.
   */
  readonly 'design-system': DesignSystemControl;
}

/**
 * @summary Options for {@linkcode createPlatform}.
 *
 * @description
 * For each optional subsystem, `true` or its options turns it on, and `false`
 * turns it off. The default is on for `hub`, `crypto`, `storage`, `consent`,
 * `settings`, `network`, `sync`, `translation` and `designSystem`. `auth`,
 * `realtime` and `analytics` are on only when their options are given.
 *
 * @example
 * Example 1: The defaults, with a name
 * ```ts
 * createPlatform({ appName: 'notes' });
 * ```
 *
 * @example
 * Example 2: A site on subdomains, with sign-in and telemetry
 * ```ts
 * createPlatform({ appName: 'shop', hub: { hubUrl: 'https://shop.example/__platform/hub.html' }, auth: { handlers }, analytics: { endpoint: '/t' } });
 * ```
 *
 * @public
 */
export interface PlatformOptions {
  /**
   * @summary The name of the app. It names the databases (`<appName>-state`, `<appName>-data`). The default is `app`.
   */
  readonly appName?: string;
  /**
   * @summary The options of Global State.
   */
  readonly globalState?: GlobalStateOptions;
  /**
   * @summary The options of the Queue (the fan-out comes from the Notification Center).
   */
  readonly queue?: Omit<QueueOptions, 'fanOut'>;
  /**
   * @summary The options of the Notification Center.
   */
  readonly notification?: NotificationOptions;
  /**
   * @summary The options of the Logger.
   */
  readonly logger?: LoggerOptions;
  /**
   * @summary The Window transport. Without `hubUrl`, Window scope covers one origin.
   * @description On by default in a browser. Where there is no `location` (Node), it is on only with options that give an `origin`.
   */
  readonly hub?: boolean | WindowClientOptions;
  /**
   * @summary Crypto.
   */
  readonly crypto?: boolean | CryptoOptions;
  /**
   * @summary Storage. The default database is `<appName>-data`.
   */
  readonly storage?: boolean | StorageOptions;
  /**
   * @summary Consent.
   */
  readonly consent?: boolean | ConsentOptions;
  /**
   * @summary Settings. With the Design System, its appearance settings are added.
   */
  readonly settings?: boolean | SettingsOptions;
  /**
   * @summary Network.
   */
  readonly network?: boolean | NetworkOptions;
  /**
   * @summary Auth. Off unless its options (with the handlers) are given.
   */
  readonly auth?: false | AuthOptions<never>;
  /**
   * @summary Sync.
   */
  readonly sync?: boolean | SyncOptions;
  /**
   * @summary Realtime. Off unless its options (with the URL) are given.
   */
  readonly realtime?: false | RealtimeOptions;
  /**
   * @summary Translation.
   */
  readonly translation?: boolean | TranslationOptions;
  /**
   * @summary Analytics. Off unless its options (with an endpoint or a send function) are given.
   */
  readonly analytics?: false | AnalyticsOptions;
  /**
   * @summary The Design System.
   */
  readonly designSystem?: boolean | DesignSystemOptions;
  /**
   * @summary The units of the app. Their ids must not be the ids of the catalogue.
   */
  readonly units?: readonly SubsystemDefinition[];
  /**
   * @summary The kernel persistence. The default is `createStatePersistence({ database: '<appName>-state' })`; `false` keeps no state.
   */
  readonly persistence?: StatePersistence | false;
  /**
   * @summary The route source of Page scope. The default is the browser source; a router adapter gives its own.
   */
  readonly routes?: RouteSource | null;
  /**
   * @summary Receives the errors that have no caller. The default sends them to the Logger, and to `console.error`.
   * @param {unknown} error The error.
   * @param {string} unitId The unit that reported it.
   * @returns {void}
   */
  onError?(error: unknown, unitId: string): void;
  /**
   * @summary More kernel options, for tests: ids, the clock, view scheduling, processors.
   */
  readonly kernel?: Pick<KernelOptions, 'ids' | 'now' | 'schedule' | 'processors'>;
}

/**
 * @summary A booted (or bootable) set of subsystems.
 *
 * @example
 * Example 1: Starting
 * ```ts
 * const platform = createPlatform({ appName: 'notes' });
 * await platform.start();
 * ```
 *
 * @example
 * Example 2: A unit of the app
 * ```ts
 * platform.unit<CartControl>('cart')?.commands.add(item);
 * ```
 *
 * @public
 */
export interface Platform {
  /**
   * @summary The kernel, for what the platform does not wrap.
   */
  readonly kernel: Kernel;
  /**
   * @summary The ids of the subsystems that the platform registered, in boot order of the catalogue.
   */
  readonly ids: readonly string[];
  /**
   * @summary Resolves after `start` ends.
   */
  readonly ready: Promise<void>;
  /**
   * @summary Starts every subsystem. A second call does nothing.
   * @returns {Promise<void>} Resolves when every subsystem has started or failed.
   */
  start(): Promise<void>;
  /**
   * @summary Stops every subsystem, in reverse order.
   * @returns {Promise<void>} Resolves when every subsystem is destroyed.
   */
  stop(): Promise<void>;
  /**
   * @summary Returns the control interface of a running unit.
   * @template K The id, for a subsystem of the catalogue.
   * @param {K} id The id.
   * @returns {PlatformControls[K] | undefined} The control interface, or `undefined` while it does not run.
   */
  unit<K extends keyof PlatformControls>(id: K): PlatformControls[K] | undefined;
  /**
   * @summary Returns the control interface of a running unit of the app.
   * @template C The control interface.
   * @param {string} id The id.
   * @returns {C | undefined} The control interface, or `undefined` while it does not run.
   */
  unit<C>(id: string): C | undefined;
}

/** The ids of the catalogue, which the units of the app must not use. */
const CATALOG_IDS: readonly string[] = [
  GLOBAL_STATE_ID,
  QUEUE_ID,
  NOTIFICATION_ID,
  LOGGER_ID,
  WINDOW_TRANSPORT_ID,
  CRYPTO_ID,
  STORAGE_ID,
  CONSENT_ID,
  SETTINGS_ID,
  NETWORK_ID,
  AUTH_ID,
  SYNC_ID,
  REALTIME_ID,
  TRANSLATION_ID,
  ANALYTICS_ID,
  DESIGN_SYSTEM_ID,
];

/** The options of a subsystem that is on by default: `undefined` and `true` mean the defaults. */
function on<T extends object>(value: boolean | T | undefined): T | null {
  if (value === false) return null;
  return value === true || value === undefined ? ({} as T) : value;
}

/**
 * @summary Creates a platform: a kernel with the chosen subsystems, wired together.
 *
 * @description
 * Nothing starts until `start()`. The subsystems start in the order of the
 * design (ARCHITECTURE §12): the centralized ones first, then the others in
 * dependency order.
 *
 * @example
 * Example 1: The defaults
 * ```ts
 * const platform = createPlatform({ appName: 'notes' });
 * await platform.start();
 * ```
 *
 * @example
 * Example 2: Tests in Node, without persistence or a route source
 * ```ts
 * createPlatform({ persistence: false, routes: null, crypto: false, storage: { hosts: ['virtual'], keys: null } });
 * ```
 *
 * @param {PlatformOptions} [options] The subsystems and their options, and the units of the app.
 * @returns {Platform} The platform.
 * @throws {RangeError} When a unit of the app has the id of a subsystem of the catalogue.
 *
 * @public
 */
export function createPlatform(options: PlatformOptions = {}): Platform {
  const appName = options.appName ?? 'app';
  for (const unit of options.units ?? []) {
    if (CATALOG_IDS.includes(unit.id)) {
      throw new RangeError(`The unit "${unit.id}" has the id of a WebKrnl subsystem.`);
    }
  }

  const notification = createNotificationCenter(options.notification);
  const queue = createQueue({ ...options.queue, fanOut: notification.fanOut });
  const units: SubsystemDefinition[] = [
    createGlobalState(options.globalState) as SubsystemDefinition,
    queue.subsystem as SubsystemDefinition,
    notification.subsystem as SubsystemDefinition,
    createLogger(options.logger) as SubsystemDefinition,
  ];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const add = (unit: SubsystemDefinition<any, any> | null) => {
    if (unit) units.push(unit as unknown as SubsystemDefinition);
  };

  const designSystem = on(options.designSystem);
  // The Window transport needs an origin: the page's, or one in the options (Node).
  const hub = options.hub === undefined && typeof location === 'undefined' ? null : on(options.hub);
  const crypto = on(options.crypto);
  const storage = on(options.storage);
  const consent = on(options.consent);
  const settings = on(options.settings);
  const network = on(options.network);
  const sync = on(options.sync);
  const translation = on(options.translation);

  add(hub && createWindowTransport(hub));
  // Storage encrypts with the keys of Crypto: the same source and the same key store (§18.1).
  // Without IndexedDB (Node), keys live in memory and cannot be shared: Storage does not encrypt.
  const keys = !crypto
    ? undefined
    : typeof indexedDB === 'undefined'
      ? null
      : {
          source: crypto.keys ?? { kind: 'device' as const },
          database: crypto.database ?? `${appName}-keys`,
        };
  add(crypto && createCrypto({ database: `${appName}-keys`, ...crypto }));
  add(storage && createStorage({ database: `${appName}-data`, keys, ...storage }));
  add(consent && createConsent(consent));
  add(
    settings &&
      createSettings({
        ...settings,
        definitions: { ...(designSystem ? APPEARANCE_SETTINGS : {}), ...settings.definitions },
      }),
  );
  add(network && createNetwork(network));
  add(options.auth ? createAuth(options.auth) : null);
  add(sync && createSync(sync));
  add(options.realtime ? createRealtime(options.realtime) : null);
  add(translation && createTranslation(translation));
  add(options.analytics ? createAnalytics(options.analytics) : null);
  add(designSystem && createDesignSystem(designSystem));
  units.push(...(options.units ?? []));

  const onError =
    options.onError ??
    ((error: unknown, unitId: string) => {
      console.error(`[webkrnl] ${unitId}:`, error);
      if (unitId === LOGGER_ID) return;
      try {
        kernel
          .unit<LoggerControl>(LOGGER_ID)
          .control?.commands.log('ERROR', String((error as Error)?.message ?? error), {
            subsystemId: unitId,
          });
      } catch {
        // No kernel or no Logger yet, or the Logger cannot take it: the console has it.
      }
    });
  const persistence =
    options.persistence === false
      ? undefined
      : (options.persistence ?? createStatePersistence({ database: `${appName}-state` }));
  const kernel: Kernel = new Kernel(units, {
    ...options.kernel,
    router: queue.router,
    persistence,
    onError,
    ...(options.routes !== undefined ? { routes: options.routes } : {}),
  });

  const ids = new Set(units.map((unit) => unit.id));
  let started: Promise<void> | null = null;
  let markReady: () => void = () => {};
  const ready = new Promise<void>((resolve) => (markReady = resolve));
  return {
    kernel,
    ids: [...ids],
    ready,
    start() {
      started ??= kernel.start().then(markReady);
      return started;
    },
    stop: () => kernel.stop(),
    unit: <C>(id: string) => (ids.has(id) ? (kernel.unit(id).control as C | undefined) : undefined),
  } as Platform;
}
