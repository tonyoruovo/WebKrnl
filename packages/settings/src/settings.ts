/**
 * @fileoverview
 * @summary The Settings subsystem: the preferences of the user and of the device, shared by every tab of the site.
 * @description
 * Implements docs/ARCHITECTURE.md §21.1 (amended proposal:
 * `proposals/settings_PROPOSAL.md`). A setting is a definition (a default, a
 * check, a kind) and, after a change, a record (the value and the time of the
 * change). The records are persisted state, so they survive a reload.
 *
 * ```text
 *   set / update / reset
 *     --> check every value (RangeError)
 *     --> records (persisted) --> views.values, at once
 *     --> 'settings:changed' (Window) --> the Settings of every other tab: the newer record wins
 *     --> user settings: handlers.save(changes); a failure rolls the change back
 *
 *   a user signs in   --> handlers.load() --> the user settings of the server
 *   the user signs out --> the user settings go back to their defaults (ARCHITECTURE §5.1)
 *   this tab starts   --> 'settings:sync' --> other tabs answer 'settings:state' with their records
 *   ```
 *
 * @example
 * A data saver switch
 * ```ts
 * const { commands, views } = kernel.unit<SettingsControl>('settings').control!;
 * saver.checked = views.values.getSnapshot().dataSaver as boolean;
 * saver.onchange = () => void commands.set('dataSaver', saver.checked);
 * ```
 *
 * @author MathAid
 */

import {
  defineSubsystem,
  deriveView,
  watchSignOut,
  type ControlInterface,
  type SubsystemDefinition,
  type View,
} from '@webkrnl/core';

import { optimisticUpdate } from './optimistic';

/**
 * @summary The id the Settings subsystem registers under.
 * @constant {'settings'}
 * @public
 */
export const SETTINGS_ID = 'settings';

/**
 * @summary The event broadcast (Window scope) after each change, with the changed {@linkcode SettingRecord}s.
 * @constant {'settings:changed'}
 * @public
 */
export const SETTINGS_CHANGED = 'settings:changed';

/**
 * @summary The event a starting Settings broadcasts to ask the other tabs for their records.
 * @constant {'settings:sync'}
 * @public
 */
export const SETTINGS_SYNC = 'settings:sync';

/**
 * @summary The event other tabs answer `settings:sync` with: their records.
 * @constant {'settings:state'}
 * @public
 */
export const SETTINGS_STATE = 'settings:state';

/**
 * @summary A value that a setting can have: JSON data.
 * @public
 */
export type SettingValue =
  | null
  | boolean
  | number
  | string
  | readonly SettingValue[]
  | { readonly [key: string]: SettingValue };

/**
 * @summary How much data the app may use: all of it, less, or as little as possible.
 * @public
 */
export type BandwidthMode = 'FULL' | 'CONSERVATIVE' | 'MINIMAL';

/**
 * @summary The definition of one setting.
 *
 * @description
 * A `device` setting belongs to the device, and stays after sign-out. A
 * `user` setting belongs to the signed-in user: it goes to the server through
 * `handlers.save`, comes back through `handlers.load`, and returns to its
 * default at sign-out.
 *
 * @example
 * Example 1: A theme
 * ```ts
 * const theme: SettingDefinition<string> = {
 *   default: 'system',
 *   validate: (value) => value === 'system' || value === 'light' || value === 'dark',
 * };
 * ```
 *
 * @example
 * Example 2: A preference of the user
 * ```ts
 * const digest: SettingDefinition<boolean> = { default: true, kind: 'user' };
 * ```
 *
 * @template T The type of the value.
 * @public
 */
export interface SettingDefinition<T extends SettingValue = SettingValue> {
  /**
   * @summary The value before the first change, and after a reset.
   */
  readonly default: T;
  /**
   * @summary Tells if a value is allowed.
   * @description Without it, a value must have the same JSON type as the
   * default (or be `null` when the default is `null`).
   * @param {unknown} value The value to check.
   * @returns {boolean} `true` when the value is allowed.
   */
  validate?(value: unknown): boolean;
  /**
   * @summary Who the setting belongs to. The default is `device`.
   */
  readonly kind?: 'device' | 'user';
}

/**
 * @summary The settings that every Settings has, as the proposal defines them.
 *
 * @description
 * `syncInterval` (ms, at least 1000, default 300 000), `bandwidthMode`
 * (default `FULL`) and `dataSaver` (default `false`) are `device` settings.
 * `locale` (a BCP 47 tag, or `null` to let the device decide) is a `user`
 * setting. Give a definition with the same key to change one.
 *
 * @example
 * Reading a default
 * ```ts
 * BUILT_IN_SETTINGS.bandwidthMode.default; // 'FULL'
 * ```
 *
 * @public
 */
export const BUILT_IN_SETTINGS: Readonly<Record<string, SettingDefinition>> = {
  syncInterval: {
    default: 300_000,
    validate: (value) => Number.isInteger(value) && (value as number) >= 1000,
  },
  bandwidthMode: {
    default: 'FULL' satisfies BandwidthMode,
    validate: (value) => value === 'FULL' || value === 'CONSERVATIVE' || value === 'MINIMAL',
  },
  dataSaver: { default: false },
  locale: {
    default: null,
    kind: 'user',
    validate: (value) => value === null || isLocale(value),
  },
};

/**
 * @summary One change of one setting: the value, and the time of the change.
 *
 * @example
 * Example 1: A record
 * ```ts
 * // { key: 'dataSaver', value: true, timestamp: 1767225600000 }
 * ```
 *
 * @example
 * Example 2: In a broadcast
 * ```ts
 * receive: (packet) => console.info((packet.take() as SettingRecord[]).map((r) => r.key));
 * ```
 *
 * @public
 */
export interface SettingRecord {
  /**
   * @summary The key of the setting.
   */
  readonly key: string;
  /**
   * @summary The value after the change.
   */
  readonly value: SettingValue;
  /**
   * @summary The time of the change, in Unix milliseconds. When two tabs disagree, the newer record wins.
   */
  readonly timestamp: number;
}

/**
 * @summary The functions that keep the user settings on a server.
 *
 * @example
 * Example 1: A REST endpoint
 * ```ts
 * const handlers: SettingsHandlers = {
 *   load: async () => (await fetch('/api/me/settings')).json(),
 *   save: async (changes) => void (await fetch('/api/me/settings', { method: 'PATCH', body: JSON.stringify(changes) })),
 * };
 * ```
 *
 * @example
 * Example 2: Through Network
 * ```ts
 * const handlers: SettingsHandlers = { save: (changes) => network.commands.patch('/api/me/settings', changes).then(() => {}) };
 * ```
 *
 * @public
 */
export interface SettingsHandlers {
  /**
   * @summary Gets the user settings of the signed-in user.
   * @description Settings calls it when a user signs in, and on `commands.load()`.
   * Keys that are not `user` settings, and values that fail the check, are ignored.
   * @returns {Promise<Readonly<Record<string, SettingValue>>>} The values, by key.
   */
  load?(): Promise<Readonly<Record<string, SettingValue>>>;
  /**
   * @summary Saves changed user settings.
   * @description When it rejects, the change rolls back in every tab.
   * @param {Readonly<Record<string, SettingValue>>} changes The new values, by key.
   * @returns {Promise<void>} Resolves when the server has them.
   */
  save?(changes: Readonly<Record<string, SettingValue>>): Promise<void>;
}

/**
 * @summary Options for {@linkcode createSettings}.
 *
 * @example
 * Example 1: An app setting
 * ```ts
 * createSettings({ definitions: { 'editor.fontSize': { default: 14, validate: (v) => v === 12 || v === 14 || v === 16 } } });
 * ```
 *
 * @example
 * Example 2: Settings that follow the user
 * ```ts
 * createSettings({ handlers: { load, save } });
 * ```
 *
 * @public
 */
export interface SettingsOptions {
  /**
   * @summary More settings, and changes to the built-in ones (same key).
   */
  readonly definitions?: Readonly<Record<string, SettingDefinition>>;
  /**
   * @summary The functions that keep the user settings on a server.
   */
  readonly handlers?: SettingsHandlers;
  /**
   * @summary The clock, in Unix milliseconds. The default is `Date.now`.
   */
  readonly now?: () => number;
}

/**
 * @summary The state of Settings.
 *
 * @example
 * Example 1: After one change
 * ```ts
 * // { records: { dataSaver: { key: 'dataSaver', value: true, timestamp: 1767225600000 } }, saving: 0, lastError: null }
 * ```
 *
 * @example
 * Example 2: A failed save
 * ```ts
 * views.state.getSnapshot().lastError; // 'Not saved: 503'
 * ```
 *
 * @public
 */
export interface SettingsData {
  /**
   * @summary The last change of each setting. The kernel persists it.
   * @description A setting without a record has its default.
   */
  records: Record<string, SettingRecord>;
  /**
   * @summary The number of saves on the server that run now.
   */
  saving: number;
  /**
   * @summary The message of the last failed save or load, or `null`.
   */
  lastError: string | null;
}

/**
 * @summary The control interface of Settings.
 *
 * @example
 * Example 1: A settings page
 * ```ts
 * const { commands, views } = kernel.unit<SettingsControl>('settings').control!;
 * views.values.subscribe(() => render(views.values.getSnapshot()));
 * mode.onchange = () => void commands.set('bandwidthMode', mode.value);
 * ```
 *
 * @example
 * Example 2: The analytics switch
 * ```ts
 * analytics.checked = commands.isAnalyticsEnabled();
 * analytics.onchange = () => (analytics.checked ? commands.enableAnalytics() : commands.disableAnalytics());
 * ```
 *
 * @public
 */
export interface SettingsControl {
  /**
   * @summary The commands of Settings.
   */
  readonly commands: {
    /**
     * @summary Returns the value of a setting.
     * @example
     * The interval of a timer
     * ```ts
     * setInterval(sync, commands.get('syncInterval') as number);
     * ```
     * @param {string} key The key.
     * @returns {SettingValue} The value, or the default when nobody changed it.
     * @throws {RangeError} For a key without a definition.
     */
    get(key: string): SettingValue;
    /**
     * @summary Changes one setting.
     * @description The same as `update({ [key]: value })`.
     * @example
     * The data saver
     * ```ts
     * await commands.set('dataSaver', true);
     * ```
     * @param {string} key The key.
     * @param {SettingValue} value The new value.
     * @returns {Promise<boolean>} `true`, or `false` when the save failed and the change rolled back.
     * @throws {RangeError} For a key without a definition, or a value that fails the check.
     */
    set(key: string, value: SettingValue): Promise<boolean>;
    /**
     * @summary Changes several settings at once.
     * @description The change applies at once and goes to the other tabs.
     * When it has `user` settings and a `save` handler, they go to the
     * server. When the save fails, the change rolls back, the error goes to
     * the kernel's `onError`, and the promise resolves with `false`.
     * @example
     * The "save" button of a form
     * ```ts
     * const saved = await commands.update({ bandwidthMode: 'MINIMAL', dataSaver: true });
     * ```
     * @param {Readonly<Record<string, SettingValue>>} changes The new values, by key.
     * @returns {Promise<boolean>} `true`, or `false` when the save failed and the change rolled back.
     * @throws {RangeError} For a key without a definition, or a value that fails the check. Nothing changes then.
     */
    update(changes: Readonly<Record<string, SettingValue>>): Promise<boolean>;
    /**
     * @summary Sets settings back to their defaults.
     * @example
     * A "reset" button
     * ```ts
     * await commands.reset(); // every setting
     * await commands.reset(['dataSaver']);
     * ```
     * @param {readonly string[]} [keys] The keys. The default is every setting.
     * @returns {Promise<boolean>} `true`, or `false` when the save failed and the change rolled back.
     * @throws {RangeError} For a key without a definition.
     */
    reset(keys?: readonly string[]): Promise<boolean>;
    /**
     * @summary Gets the user settings from the server again (`handlers.load`).
     * @example
     * After the user changed them on another device
     * ```ts
     * await commands.load();
     * ```
     * @returns {Promise<void>} Resolves when they apply. A failure goes to `lastError` and `onError`.
     */
    load(): Promise<void>;
    /**
     * @summary Returns the keys of every defined setting.
     * @example
     * Building a form
     * ```ts
     * for (const key of commands.keys()) addField(key);
     * ```
     * @returns {readonly string[]} The keys.
     */
    keys(): readonly string[];
    /**
     * @summary Tells if the user granted analytics (Consent).
     * @example
     * The analytics switch
     * ```ts
     * analytics.checked = commands.isAnalyticsEnabled();
     * ```
     * @returns {boolean} `true` when the `analytics` category is granted.
     */
    isAnalyticsEnabled(): boolean;
    /**
     * @summary Grants analytics through Consent.
     * @example
     * The switch turns on
     * ```ts
     * commands.enableAnalytics();
     * ```
     * @returns {boolean} `true` when the grant changed.
     */
    enableAnalytics(): boolean;
    /**
     * @summary Revokes analytics through Consent. The essential work does not stop.
     * @example
     * The switch turns off
     * ```ts
     * commands.disableAnalytics();
     * ```
     * @returns {boolean} `true` when the grant changed.
     */
    disableAnalytics(): boolean;
  };
  /**
   * @summary The views of Settings.
   */
  readonly views: {
    /**
     * @summary The state: the records, the saves that run, and the last error.
     */
    readonly state: View<Partial<SettingsData>>;
    /**
     * @summary The value of every defined setting, defaults included.
     */
    readonly values: View<Readonly<Record<string, SettingValue>>>;
  };
}

/** The part of Consent that Settings uses. Settings does not import `@webkrnl/consent`. */
interface ConsentLike extends ControlInterface {
  readonly commands: {
    isGranted(category: string): boolean;
    grant(category: string): boolean;
    revoke(category: string): boolean;
  };
}

/** The part of Auth that Settings reads, to know when a user signs in. */
interface AuthLike extends ControlInterface {
  readonly views: {
    readonly state: View<{
      readonly status?: string;
      readonly user?: { readonly id: string } | null;
    }>;
  };
}

/**
 * @summary Tells if a value is a BCP 47 locale tag.
 * @param {unknown} value The value.
 * @returns {boolean} `true` for a valid tag.
 * @internal
 */
function isLocale(value: unknown): boolean {
  if (typeof value !== 'string' || value === '') return false;
  try {
    return Intl.getCanonicalLocales(value).length === 1;
  } catch {
    return false;
  }
}

/**
 * @summary The JSON type of a value: `null`, `array`, or the `typeof` result.
 * @param {unknown} value The value.
 * @returns {string} The type.
 * @internal
 */
function jsonType(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

/**
 * @summary Tells if a value is allowed for a definition.
 * @param {SettingDefinition} definition The definition.
 * @param {unknown} value The value.
 * @returns {boolean} `true` when it is allowed.
 * @internal
 */
function allowed(definition: SettingDefinition, value: unknown): boolean {
  if (value === undefined || (typeof value === 'number' && !Number.isFinite(value))) return false;
  if (definition.validate) return definition.validate(value);
  return jsonType(value) === jsonType(definition.default);
}

/**
 * @summary Tells if two values are the same JSON data.
 * @param {unknown} a One value.
 * @param {unknown} b The other.
 * @returns {boolean} `true` when they are equal.
 * @internal
 */
function same(a: unknown, b: unknown): boolean {
  return a === b || JSON.stringify(a) === JSON.stringify(b);
}

/**
 * @summary Merges records from another tab: for each key, the newer record wins.
 *
 * @description
 * Returns the merged records and the incoming records that won. An incoming
 * record for a defined key whose value fails the check is ignored. Records
 * for keys without a definition are kept, so that a tab with a newer version
 * of the app does not lose them. On equal timestamps, the local record stays.
 *
 * @example
 * Example 1: A newer change from another tab
 * ```ts
 * mergeSettingRecords({}, [{ key: 'dataSaver', value: true, timestamp: 2 }], BUILT_IN_SETTINGS).applied.length; // 1
 * ```
 *
 * @example
 * Example 2: An older one loses
 * ```ts
 * mergeSettingRecords({ dataSaver: newer }, [older], BUILT_IN_SETTINGS).applied; // []
 * ```
 *
 * @param {Readonly<Record<string, SettingRecord>>} local The records of this tab.
 * @param {readonly SettingRecord[]} incoming The records from another tab.
 * @param {Readonly<Record<string, SettingDefinition>>} definitions The definitions.
 * @returns {{ records: Record<string, SettingRecord>; applied: SettingRecord[] }} The merge and the records that won.
 *
 * @public
 */
export function mergeSettingRecords(
  local: Readonly<Record<string, SettingRecord>>,
  incoming: readonly SettingRecord[],
  definitions: Readonly<Record<string, SettingDefinition>>,
): { records: Record<string, SettingRecord>; applied: SettingRecord[] } {
  const records = { ...local };
  const applied: SettingRecord[] = [];
  for (const record of incoming) {
    if (typeof record?.key !== 'string' || typeof record.timestamp !== 'number') continue;
    const definition = definitions[record.key];
    if (definition && !allowed(definition, record.value)) continue;
    const current = records[record.key];
    if (current && current.timestamp >= record.timestamp) continue;
    records[record.key] = record;
    applied.push(record);
  }
  return { records, applied };
}

/**
 * @summary Creates the Settings subsystem.
 *
 * @description
 * Returns the subsystem definition (id {@linkcode SETTINGS_ID}, featurized,
 * Window scope). It requires Consent. Auth and the Window transport are
 * optional: with Auth, the user settings load at sign-in and return to their
 * defaults at sign-out; with the Window transport, every tab of the site
 * shares the settings.
 *
 * @example
 * Example 1: Registering
 * ```ts
 * new Kernel([...centralized, createWindowTransport({ hubUrl }), createConsent(), createSettings()], { router: queue.router, persistence });
 * ```
 *
 * @example
 * Example 2: Following a setting from another subsystem
 * ```ts
 * ctx.watch<SettingsControl>('settings', (settings) => settings?.views.values.subscribe(apply));
 * ```
 *
 * @param {SettingsOptions} [options] More definitions, the server handlers, and the clock.
 * @returns {SubsystemDefinition<SettingsData, SettingsControl>} The subsystem.
 * @throws {RangeError} When a default fails the check of its own definition.
 *
 * @public
 */
export function createSettings(
  options: SettingsOptions = {},
): SubsystemDefinition<SettingsData, SettingsControl> {
  const now = options.now ?? Date.now;
  const definitions: Readonly<Record<string, SettingDefinition>> = {
    ...BUILT_IN_SETTINGS,
    ...options.definitions,
  };
  for (const [key, definition] of Object.entries(definitions)) {
    if (!allowed(definition, definition.default)) {
      throw new RangeError(`The default of the setting "${key}" fails its own check.`);
    }
  }
  const keys = Object.keys(definitions);
  const isUser = (key: string) => definitions[key]?.kind === 'user';
  const definitionOf = (key: string) => {
    const definition = definitions[key];
    if (!definition) throw new RangeError(`Unknown setting "${key}".`);
    return definition;
  };

  // Shared by init and control: set in init, used by the commands.
  let load: () => Promise<void> = async () => {};
  let signedIn: () => boolean = () => true;

  return defineSubsystem({
    id: SETTINGS_ID,
    scope: 'window',
    kind: 'featurized',
    requires: [
      { target: 'consent' },
      { target: 'window', kind: 'optional' },
      { target: 'auth', kind: 'optional' },
    ],
    subscribes: [SETTINGS_CHANGED, SETTINGS_SYNC, SETTINGS_STATE],
    state: {
      initial: { records: {}, saving: 0, lastError: null } as SettingsData,
      policy: {
        records: { readable: true, persisted: true },
        saving: { readable: true },
        lastError: { readable: true },
      },
      version: 1,
    },
    init(ctx) {
      ctx.port
        .send({ eventId: SETTINGS_SYNC, payload: null, importance: 'MEDIUM' })
        .catch((error: unknown) => ctx.report(error));

      // A sign-out raises the generation, so a load that it overtook is dropped.
      let generation = 0;
      let authRunning = false;
      let userId: string | null = null;

      load = async () => {
        const handler = options.handlers?.load;
        if (!handler) return;
        const started = generation;
        let values: Readonly<Record<string, SettingValue>>;
        try {
          values = await handler();
        } catch (error) {
          ctx.state.update((s) => void (s.lastError = (error as Error)?.message ?? String(error)));
          ctx.report(error);
          return;
        }
        if (started !== generation) return;
        const timestamp = now();
        const loaded: SettingRecord[] = [];
        for (const [key, value] of Object.entries(values ?? {})) {
          const definition = definitions[key];
          if (!definition || definition.kind !== 'user') continue;
          if (!allowed(definition, value)) {
            ctx.report(new RangeError(`The server sent a value that fails the check of "${key}".`));
            continue;
          }
          loaded.push({ key, value, timestamp });
        }
        if (loaded.length === 0) return;
        ctx.state.update((s) => {
          for (const record of loaded) s.records[record.key] = record;
          s.lastError = null;
        });
        ctx.port
          .send({ eventId: SETTINGS_CHANGED, payload: loaded, importance: 'MEDIUM' })
          .catch((error: unknown) => ctx.report(error));
      };

      let stopView: (() => void) | undefined;
      const stopAuth = ctx.watch<AuthLike>('auth', (auth) => {
        stopView?.();
        stopView = undefined;
        authRunning = typeof auth?.views?.state?.subscribe === 'function';
        if (!authRunning) return;
        const read = () => {
          const { status, user } = auth!.views.state.getSnapshot();
          const id = status === 'AUTHENTICATED' || status === 'EXPIRED' ? (user?.id ?? null) : null;
          if (id !== null && id !== userId) {
            userId = id;
            void load();
          } else if (id === null) {
            userId = null;
          }
        };
        stopView = auth!.views.state.subscribe(read);
        read();
      });
      signedIn = () => !authRunning || userId !== null;

      const stopSignOut = watchSignOut(ctx, () => {
        generation++;
        // The user settings return to their defaults; the device settings stay (§5.1).
        ctx.state.update((s) => {
          for (const key of Object.keys(s.records)) if (isUser(key)) delete s.records[key];
        });
      });

      return () => {
        stopSignOut();
        stopAuth();
        stopView?.();
        load = async () => {};
        signedIn = () => true;
      };
    },
    receive(packet, ctx) {
      const { eventId } = packet.header;
      if (eventId === SETTINGS_SYNC) {
        const mine = Object.values(ctx.state.get().records);
        if (mine.length === 0) return;
        ctx.port
          .send({ eventId: SETTINGS_STATE, payload: mine, importance: 'MEDIUM' })
          .catch((error: unknown) => ctx.report(error));
        return;
      }
      // settings:changed or settings:state from another tab (a tab never hears its own).
      const incoming = packet.take();
      if (!Array.isArray(incoming)) return;
      const { records, applied } = mergeSettingRecords(
        ctx.state.get().records,
        incoming as SettingRecord[],
        definitions,
      );
      if (applied.length > 0) ctx.state.update((s) => void (s.records = records));
    },
    control: (ctx) => {
      const consent = () => ctx.dependency<ConsentLike>('consent');
      const valueOf = (records: Readonly<Record<string, SettingRecord>>, key: string) =>
        records[key] ? records[key].value : definitions[key]!.default;

      /** Writes records in this tab and sends them to the other tabs. */
      const write = (records: readonly SettingRecord[]) => {
        ctx.state.update((s) => {
          for (const record of records) s.records[record.key] = record;
        });
        ctx.port
          .send({ eventId: SETTINGS_CHANGED, payload: records, importance: 'MEDIUM' })
          .catch((error: unknown) => ctx.report(error));
      };

      const update = (changes: Readonly<Record<string, SettingValue>>): Promise<boolean> => {
        for (const [key, value] of Object.entries(changes)) {
          if (!allowed(definitionOf(key), value)) {
            throw new RangeError(`The value of the setting "${key}" fails its check.`);
          }
        }
        const before = ctx.state.get().records;
        const timestamp = now();
        const written: SettingRecord[] = Object.entries(changes)
          .filter(([key, value]) => !same(valueOf(before, key), value))
          .map(([key, value]) => ({ key, value: structuredClone(value), timestamp }));
        if (written.length === 0) return Promise.resolve(true);

        const save = options.handlers?.save;
        const forServer = written.filter((record) => isUser(record.key));
        if (!save || forServer.length === 0 || !signedIn()) {
          write(written);
          return Promise.resolve(true);
        }
        ctx.state.update((s) => void s.saving++);
        return optimisticUpdate(
          () => write(written),
          () => save(Object.fromEntries(forServer.map((record) => [record.key, record.value]))),
          () => {
            // Roll back only the records that nobody changed since.
            const current = ctx.state.get().records;
            const at = now();
            const reverts = written
              .filter(
                (record) => current[record.key] === record || same(current[record.key], record),
              )
              .map((record) => ({
                key: record.key,
                value: valueOf(before, record.key),
                timestamp: at,
              }));
            if (reverts.length > 0) write(reverts);
          },
        ).then(
          () => {
            ctx.state.update((s) => {
              s.saving--;
              s.lastError = null;
            });
            return true;
          },
          (error: unknown) => {
            ctx.state.update((s) => {
              s.saving--;
              s.lastError = (error as Error)?.message ?? String(error);
            });
            ctx.report(error);
            return false;
          },
        );
      };

      const records$ = deriveView(ctx.state.readable, (s) => s.records ?? {});
      return {
        commands: {
          get: (key: string) => {
            definitionOf(key);
            return valueOf(ctx.state.get().records, key);
          },
          set: (key: string, value: SettingValue) => update({ [key]: value }),
          update,
          reset: (resetKeys: readonly string[] = keys) =>
            update(Object.fromEntries(resetKeys.map((key) => [key, definitionOf(key).default]))),
          load: () => load(),
          keys: () => keys,
          isAnalyticsEnabled: () => consent()?.commands.isGranted('analytics') ?? false,
          enableAnalytics: () => consent()?.commands.grant('analytics') ?? false,
          disableAnalytics: () => consent()?.commands.revoke('analytics') ?? false,
        },
        views: {
          state: ctx.state.readable,
          values: deriveView(records$, (records) =>
            Object.fromEntries(keys.map((key) => [key, valueOf(records, key)])),
          ),
        },
      };
    },
  });
}
