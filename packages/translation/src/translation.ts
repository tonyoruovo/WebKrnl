/**
 * @fileoverview
 * @summary The Translation subsystem: localized messages and locale-aware formatting, offline.
 * @description
 * Implements docs/ARCHITECTURE.md §21.2 (amended proposal:
 * `proposals/translation_PROPOSAL.md`). `t()` is synchronous, because
 * templates call it while they render. Catalogs load before, in the
 * background, and `views.state` tells the UI when to render again.
 *
 * ```text
 *   locale   setting 'locale' (Settings) --> navigator.languages --> defaultLocale
 *            matched against supportedLocales --> chain, e.g. ['fr-CA', 'fr', 'en']
 *
 *   catalog  (locale, namespace), first found:
 *            options.catalogs --> Storage 'translation.catalogs' --> options.load() --> options.url (Network, ETag)
 *            --> processor 'compile' (dedicated worker, or the main thread) --> registry (LRU, maxCatalogs)
 *            a catalog from Storage is checked again with its ETag in the background
 *
 *   t(key, params)   each locale of the chain, each namespace --> formatMessage
 *                    not found --> the key (or MissingTranslationError in strict mode),
 *                                  'translation:missing-key' once for each key and locale
 *   ```
 *
 * @example
 * Rendering a label
 * ```ts
 * const i18n = kernel.unit<TranslationControl>('translation').control!;
 * label.textContent = i18n.commands.t('cart.items', { count: 3 });
 * ```
 *
 * @author MathAid
 */

import {
  defineSubsystem,
  type ControlInterface,
  type HostKind,
  type ProcessorDef,
  type SubsystemDefinition,
  type View,
} from '@platform/core';

import { createCompileProcessor, type CompileRequest, type CompileResult } from './compile';
import {
  createFormatContext,
  formatMessage,
  type CompiledMessage,
  type FormatContext,
} from './icu';
import { canonicalLocale, resolveLocaleChain, textDirection } from './locale';

/**
 * @summary The id the Translation subsystem registers under.
 * @constant {'translation'}
 * @public
 */
export const TRANSLATION_ID = 'translation';

/**
 * @summary The event broadcast (Tab scope) when the locale changes, with a {@linkcode LocaleChange}.
 * @constant {'translation:locale-changed'}
 * @public
 */
export const LOCALE_CHANGED = 'translation:locale-changed';

/**
 * @summary The event broadcast (LOW) the first time a key is missing in a locale, with a {@linkcode MissingKey}.
 * @constant {'translation:missing-key'}
 * @public
 */
export const MISSING_KEY = 'translation:missing-key';

/**
 * @summary The Storage collection where fetched catalogs are kept for offline use.
 * @constant {'translation.catalogs'}
 * @public
 */
export const CATALOG_COLLECTION = 'translation.catalogs';

/**
 * @summary The messages of one locale and one namespace.
 *
 * @example
 * Example 1: An inline catalog
 * ```ts
 * const common: MessageCatalog = { locale: 'en', namespace: 'common', messages: { hello: 'Hello, {name}!' } };
 * ```
 *
 * @example
 * Example 2: A catalog file at /i18n/fr/common.json
 * ```ts
 * // { "messages": { "hello": "Bonjour, {name} !" }, "version": 7 }
 * ```
 *
 * @public
 */
export interface MessageCatalog {
  /**
   * @summary The locale, a BCP 47 tag.
   */
  readonly locale: string;
  /**
   * @summary The namespace, for example `common` or `checkout`.
   */
  readonly namespace: string;
  /**
   * @summary The messages, by key, in ICU MessageFormat.
   */
  readonly messages: Readonly<Record<string, string>>;
  /**
   * @summary The version of the catalog, if the source gives one.
   */
  readonly version?: string | number;
}

/**
 * @summary The payload of `translation:locale-changed`.
 * @public
 */
export interface LocaleChange {
  /**
   * @summary The locale before the change.
   */
  readonly oldLocale: string;
  /**
   * @summary The locale after the change.
   */
  readonly newLocale: string;
  /**
   * @summary The text direction of the new locale.
   */
  readonly direction: 'ltr' | 'rtl';
}

/**
 * @summary The payload of `translation:missing-key`.
 * @public
 */
export interface MissingKey {
  /**
   * @summary The key that is missing.
   */
  readonly key: string;
  /**
   * @summary The locale that was asked for.
   */
  readonly locale: string;
}

/**
 * @summary The error of `t()` for a missing key, in strict mode.
 *
 * @example
 * Example 1: In a test, to find gaps
 * ```ts
 * createTranslation({ strict: true });
 * expect(() => i18n.commands.t('nope')).toThrow(MissingTranslationError);
 * ```
 *
 * @example
 * Example 2: Reading the key
 * ```ts
 * catch (error) { if (error instanceof MissingTranslationError) report(error.key); }
 * ```
 *
 * @public
 */
export class MissingTranslationError extends Error {
  /**
   * @summary The key that is missing.
   */
  readonly key: string;

  /**
   * @summary Creates the error.
   * @param {string} key The key.
   * @param {string} locale The locale.
   */
  constructor(key: string, locale: string) {
    super(`No translation for "${key}" in ${locale}.`);
    this.name = 'MissingTranslationError';
    this.key = key;
  }
}

/**
 * @summary Options for {@linkcode createTranslation}.
 *
 * @example
 * Example 1: Catalog files on the server
 * ```ts
 * createTranslation({ supportedLocales: ['en', 'fr', 'ar'], url: '/i18n/{locale}/{namespace}.json' });
 * ```
 *
 * @example
 * Example 2: Catalogs in the bundle
 * ```ts
 * createTranslation({ supportedLocales: ['en', 'de'], load: (locale, ns) => import(`./i18n/${locale}/${ns}.json`).then((m) => m.default) });
 * ```
 *
 * @public
 */
export interface TranslationOptions {
  /**
   * @summary The last locale of every chain. The default is `en`.
   */
  readonly defaultLocale?: string;
  /**
   * @summary The locales that the app has catalogs for. The default is the default locale only.
   */
  readonly supportedLocales?: readonly string[];
  /**
   * @summary Catalogs in the options. They need no loading.
   */
  readonly catalogs?: readonly MessageCatalog[];
  /**
   * @summary Gets a catalog from the app, for example with a dynamic `import()`.
   * @param {string} locale The locale.
   * @param {string} namespace The namespace.
   * @returns {Promise<{ messages: Readonly<Record<string, string>>; version?: string | number } | null>} The messages, or `null` when there are none.
   */
  load?(
    locale: string,
    namespace: string,
  ): Promise<{ messages: Readonly<Record<string, string>>; version?: string | number } | null>;
  /**
   * @summary The URL of a catalog file, with `{locale}` and `{namespace}`. Fetched through Network when it runs.
   * @description The file is JSON: `{ "messages": { ... }, "version"?: ... }`, or the messages object itself.
   */
  readonly url?: string;
  /**
   * @summary The namespaces that load at start. The default is `['common']`.
   */
  readonly namespaces?: readonly string[];
  /**
   * @summary The largest number of catalogs in memory. The default is 50.
   */
  readonly maxCatalogs?: number;
  /**
   * @summary Throws {@linkcode MissingTranslationError} for a missing key, instead of returning the key. The default is `false`.
   */
  readonly strict?: boolean;
  /**
   * @summary HTML-escapes parameter values. The default is `true`.
   * @description Turn it off where the framework escapes text itself (Vue, React), so that text is not escaped twice.
   */
  readonly escapeParams?: boolean;
  /**
   * @summary The currency of the `currency` number style and of `formatCurrency`. The default is `USD`.
   */
  readonly currency?: string;
  /**
   * @summary How long the start waits for the first catalogs, in milliseconds. The default is 2000.
   * @description After that, Translation is ready, `t()` returns keys until the
   * catalogs arrive, and `views.state` changes when they do.
   */
  readonly startWaitMs?: number;
  /**
   * @summary The hosts of the processor `compile`. The default is `['dedicated', 'virtual']`.
   */
  readonly hosts?: readonly HostKind[];
  /**
   * @summary The locales of the device, best first. The default reads `navigator.languages`.
   * @returns {readonly string[]} The locales.
   */
  languages?(): readonly string[];
}

/**
 * @summary Where `t()` and `has()` look a key up.
 *
 * @example
 * Only in one namespace
 * ```ts
 * commands.t('title', {}, { namespace: 'checkout' });
 * ```
 *
 * @public
 */
export interface LookupOptions {
  /**
   * @summary Look only in this namespace. The default is every namespace that the app asked for.
   */
  readonly namespace?: string;
}

/**
 * @summary The state of Translation.
 *
 * @example
 * Example 1: French, ready
 * ```ts
 * // { locale: 'fr', chain: ['fr', 'en'], direction: 'ltr', namespaces: ['common'], loading: 0, revision: 2, missing: 0, lastError: null }
 * ```
 *
 * @example
 * Example 2: Rendering again when catalogs arrive
 * ```ts
 * views.state.subscribe(() => app.render());
 * ```
 *
 * @public
 */
export interface TranslationData {
  /**
   * @summary The active locale: the first of the chain.
   */
  locale: string;
  /**
   * @summary The locales that `t()` looks a key up in, in order.
   */
  chain: string[];
  /**
   * @summary The text direction of the active locale.
   */
  direction: 'ltr' | 'rtl';
  /**
   * @summary The namespaces that the app asked for.
   */
  namespaces: string[];
  /**
   * @summary The number of catalogs that load now.
   */
  loading: number;
  /**
   * @summary A number that changes each time a catalog arrives or leaves. Render again when it changes.
   */
  revision: number;
  /**
   * @summary The number of different missing keys (for each locale).
   */
  missing: number;
  /**
   * @summary The message of the last failed load, or `null`.
   */
  lastError: string | null;
  /**
   * @summary The host that compiles catalogs (`dedicated` or `virtual`), or `null` before it starts.
   */
  compiler: HostKind | null;
}

/**
 * @summary The control interface of Translation.
 *
 * @example
 * Example 1: Messages and formats
 * ```ts
 * const { commands } = kernel.unit<TranslationControl>('translation').control!;
 * commands.t('greeting', { name: 'Ada' });
 * commands.formatCurrency(9.99, 'EUR');
 * ```
 *
 * @example
 * Example 2: A language menu
 * ```ts
 * menu.onchange = () => commands.setLocale(menu.value);
 * ```
 *
 * @public
 */
export interface TranslationControl {
  /**
   * @summary The commands of Translation.
   */
  readonly commands: {
    /**
     * @summary Translates a key.
     * @description Looks the key up in each locale of the chain, and in each
     * namespace that the app asked for (or only in `options.namespace`).
     * Returns the key when no catalog has it.
     * @example
     * A plural
     * ```ts
     * commands.t('cart.items', { count: 3 }); // '3 items'
     * ```
     * @param {string} key The key.
     * @param {Readonly<Record<string, unknown>>} [params] The parameters of the message.
     * @param {LookupOptions} [options] Look only in this namespace.
     * @returns {string} The text, or the key.
     * @throws {MissingTranslationError} In strict mode, for a missing key.
     */
    t(key: string, params?: Readonly<Record<string, unknown>>, options?: LookupOptions): string;
    /**
     * @summary Tells if a key has a message in the chain.
     * @example
     * An optional hint
     * ```ts
     * if (commands.has('checkout.hint')) hint.textContent = commands.t('checkout.hint');
     * ```
     * @param {string} key The key.
     * @param {LookupOptions} [options] Look only in this namespace.
     * @returns {boolean} `true` when a catalog has it.
     */
    has(key: string, options?: LookupOptions): boolean;
    /**
     * @summary Changes the locale.
     * @description With Settings, it changes the setting `locale`, so every
     * tab follows. `null` lets the device decide again.
     * @example
     * A language menu
     * ```ts
     * await commands.setLocale('ar');
     * ```
     * @param {string | null} locale The locale, or `null`.
     * @returns {Promise<void>} Resolves when the catalogs of the new chain are loaded.
     * @throws {RangeError} For a tag that is not valid.
     */
    setLocale(locale: string | null): Promise<void>;
    /**
     * @summary Loads a namespace in every locale of the chain.
     * @example
     * Before the checkout page renders
     * ```ts
     * await commands.loadNamespace('checkout');
     * ```
     * @param {string} namespace The namespace.
     * @returns {Promise<void>} Resolves when it is loaded (or could not load).
     */
    loadNamespace(namespace: string): Promise<void>;
    /**
     * @summary Stops looking keys up in a namespace, and frees its catalogs.
     * @example
     * When the checkout closes
     * ```ts
     * commands.unloadNamespace('checkout');
     * ```
     * @param {string} namespace The namespace.
     * @returns {void}
     */
    unloadNamespace(namespace: string): void;
    /**
     * @summary Adds a catalog from the app.
     * @description It replaces a catalog of the same locale and namespace.
     * @example
     * Messages from a feature module
     * ```ts
     * await commands.addCatalog({ locale: 'en', namespace: 'help', messages: { title: 'Help' } });
     * ```
     * @param {MessageCatalog} catalog The catalog.
     * @returns {Promise<void>} Resolves when it is compiled and in use.
     */
    addCatalog(catalog: MessageCatalog): Promise<void>;
    /**
     * @summary Waits until no catalog loads.
     * @example
     * Before the first render
     * ```ts
     * await commands.ready();
     * ```
     * @returns {Promise<void>} Resolves when loading ends.
     */
    ready(): Promise<void>;
    /**
     * @summary Returns the missing keys, as `key (locale)`.
     * @example
     * In a developer panel
     * ```ts
     * console.table(commands.missingKeys());
     * ```
     * @returns {string[]} The missing keys.
     */
    missingKeys(): string[];
    /**
     * @summary Formats a number for the active locale.
     * @example
     * A count
     * ```ts
     * commands.formatNumber(1234.5); // '1,234.5'
     * ```
     * @param {number | bigint} value The number.
     * @param {Intl.NumberFormatOptions} [options] The options.
     * @returns {string} The text.
     */
    formatNumber(value: number | bigint, options?: Intl.NumberFormatOptions): string;
    /**
     * @summary Formats an amount of money for the active locale.
     * @example
     * A price
     * ```ts
     * commands.formatCurrency(9.99, 'EUR'); // '€9.99'
     * ```
     * @param {number} value The amount.
     * @param {string} [currency] The ISO 4217 code. The default is the option `currency`.
     * @param {'symbol' | 'code' | 'name' | 'narrowSymbol'} [display] How to show the currency. The default is `symbol`.
     * @returns {string} The text.
     */
    formatCurrency(
      value: number,
      currency?: string,
      display?: 'symbol' | 'code' | 'name' | 'narrowSymbol',
    ): string;
    /**
     * @summary Formats a date for the active locale.
     * @example
     * A due date
     * ```ts
     * commands.formatDate(order.due, { dateStyle: 'long' });
     * ```
     * @param {Date | number | string} value The date, a timestamp, or an ISO text.
     * @param {Intl.DateTimeFormatOptions} [options] The options. The default is `{ dateStyle: 'medium' }`.
     * @returns {string} The text.
     */
    formatDate(value: Date | number | string, options?: Intl.DateTimeFormatOptions): string;
    /**
     * @summary Formats a relative time for the active locale.
     * @example
     * A message age
     * ```ts
     * commands.formatRelativeTime(-3, 'minute'); // '3 minutes ago'
     * ```
     * @param {number} value The amount, negative for the past.
     * @param {Intl.RelativeTimeFormatUnit} unit The unit.
     * @param {Intl.RelativeTimeFormatOptions} [options] The options. The default is `{ numeric: 'auto' }`.
     * @returns {string} The text.
     */
    formatRelativeTime(
      value: number,
      unit: Intl.RelativeTimeFormatUnit,
      options?: Intl.RelativeTimeFormatOptions,
    ): string;
    /**
     * @summary Formats a list for the active locale.
     * @example
     * Names
     * ```ts
     * commands.formatList(['Ada', 'Grace', 'Edsger']); // 'Ada, Grace, and Edsger'
     * ```
     * @param {readonly string[]} items The items.
     * @param {Intl.ListFormatOptions} [options] The options.
     * @returns {string} The text.
     */
    formatList(items: readonly string[], options?: Intl.ListFormatOptions): string;
    /**
     * @summary Compares two texts in the order of the active locale.
     * @example
     * Sorting names
     * ```ts
     * names.sort(commands.compare);
     * ```
     * @param {string} a One text.
     * @param {string} b The other.
     * @returns {number} Negative, zero or positive.
     */
    compare(a: string, b: string): number;
  };
  /**
   * @summary The views of Translation.
   */
  readonly views: {
    /**
     * @summary The locale, the chain, the direction, the namespaces and the loading state.
     */
    readonly state: View<Partial<TranslationData>>;
  };
}

/** A catalog in memory. */
interface Entry {
  readonly messages: Readonly<Record<string, CompiledMessage | null>>;
  readonly version?: string | number;
  usedAt: number;
}

/** A catalog in Storage. */
interface StoredCatalog {
  readonly messages: Readonly<Record<string, string>>;
  readonly version?: string | number;
  readonly etag?: string;
}

/** The parts of other subsystems that Translation uses. It imports none of them. */
interface SettingsLike extends ControlInterface {
  readonly commands: {
    get(key: string): unknown;
    set(key: string, value: unknown): Promise<boolean>;
    keys(): readonly string[];
  };
  readonly views: { readonly values: View<Readonly<Record<string, unknown>>> };
}
interface StoredCollection {
  get(key: string): Promise<StoredCatalog | undefined>;
  set(key: string, value: StoredCatalog): Promise<void>;
}
interface StorageLike extends ControlInterface {
  readonly commands: {
    collection(definition: { name: string; encrypt?: boolean }): StoredCollection;
  };
}
interface NetworkLike extends ControlInterface {
  readonly commands: {
    request(config: {
      url: string;
      headers?: Record<string, string>;
      responseType?: 'json';
      allowErrorStatus?: boolean;
      background?: boolean;
      importance?: 'LOW';
    }): Promise<{ status: number; headers: Readonly<Record<string, string>>; data: unknown }>;
  };
}

const idOf = (locale: string, namespace: string) => `${locale}/${namespace}`;

/**
 * @summary Creates the Translation subsystem.
 *
 * @description
 * Returns the subsystem definition (id {@linkcode TRANSLATION_ID},
 * featurized, Tab scope). Settings, Storage and Network are optional and
 * late-bound: with Settings, the setting `locale` chooses the locale; with
 * Storage, fetched catalogs work offline; with Network, catalog files come
 * through it (retries, the offline check), otherwise through `fetch`.
 *
 * @example
 * Example 1: Registering
 * ```ts
 * new Kernel([...centralized, createConsent(), createSettings(), createTranslation({ supportedLocales: ['en', 'fr'], url: '/i18n/{locale}/{namespace}.json' })], { router: queue.router });
 * ```
 *
 * @example
 * Example 2: Inline catalogs, for tests
 * ```ts
 * createTranslation({ catalogs: [{ locale: 'en', namespace: 'common', messages: { hi: 'Hi!' } }] });
 * ```
 *
 * @param {TranslationOptions} [options] The locales, the catalog sources and the format rules.
 * @returns {SubsystemDefinition<TranslationData, TranslationControl>} The subsystem.
 *
 * @public
 */
export function createTranslation(
  options: TranslationOptions = {},
): SubsystemDefinition<TranslationData, TranslationControl> {
  const defaultLocale = canonicalLocale(options.defaultLocale) ?? 'en';
  const supported = [
    ...new Set(
      [...(options.supportedLocales ?? []), defaultLocale]
        .map(canonicalLocale)
        .filter((t): t is string => t !== null),
    ),
  ];
  const maxCatalogs = options.maxCatalogs ?? 50;
  const escape = options.escapeParams ?? true;
  const currency = options.currency ?? 'USD';
  const inline = new Map<string, MessageCatalog>();
  for (const catalog of options.catalogs ?? []) {
    const locale = canonicalLocale(catalog.locale);
    if (locale) inline.set(idOf(locale, catalog.namespace), { ...catalog, locale });
  }
  const languages =
    options.languages ??
    (() =>
      typeof navigator === 'undefined'
        ? []
        : navigator.languages?.length
          ? navigator.languages
          : [navigator.language]);
  const compile: ProcessorDef<CompileRequest, CompileResult> = {
    id: 'compile',
    job: 'scheduler',
    hosts: options.hosts ?? ['dedicated', 'virtual'],
    load: async () => createCompileProcessor(),
    dedicated: () =>
      new Worker(new URL('./compile.worker.ts', import.meta.url), { type: 'module' }),
  };
  const initialChain = resolveLocaleChain([], supported, defaultLocale);

  // What init builds and control uses.
  let api: {
    lookup(key: string, namespace?: string): { message: CompiledMessage; locale: string } | null;
    missed(key: string): void;
    context(locale: string): FormatContext;
    setLocale(locale: string | null): Promise<void>;
    load(namespace: string): Promise<void>;
    unload(namespace: string): void;
    add(catalog: MessageCatalog): Promise<void>;
    ready(): Promise<void>;
    missing(): string[];
  } | null = null;

  return defineSubsystem({
    id: TRANSLATION_ID,
    scope: 'tab',
    kind: 'featurized',
    requires: [
      { target: 'settings', kind: 'optional' },
      { target: 'storage', kind: 'optional' },
      { target: 'network', kind: 'optional' },
    ],
    processors: [compile],
    state: {
      initial: {
        locale: initialChain[0]!,
        chain: initialChain,
        direction: textDirection(initialChain[0]!),
        namespaces: [...(options.namespaces ?? ['common'])],
        loading: 0,
        revision: 0,
        missing: 0,
        lastError: null,
        compiler: null,
      } as TranslationData,
      policy: {
        locale: { readable: true },
        chain: { readable: true },
        direction: { readable: true },
        namespaces: { readable: true },
        loading: { readable: true },
        revision: { readable: true },
        missing: { readable: true },
        lastError: { readable: true },
        compiler: { readable: true },
      },
    },
    async init(ctx) {
      const processor = ctx.processor<CompileRequest, CompileResult>('compile');
      const showHost = () => {
        const host = processor.status.getSnapshot().host;
        if (ctx.state.get().compiler !== host) ctx.state.update((s) => void (s.compiler = host));
      };
      const stopHost = processor.status.subscribe(showHost);
      showHost();
      const registry = new Map<string, Entry>();
      const inFlight = new Map<string, Promise<void>>();
      const missing = new Set<string>();
      const contexts = new Map<string, FormatContext>();
      let override: string | null = null; // the locale without Settings
      let collection: StoredCollection | null = null;
      let idle: Promise<void> = Promise.resolve();
      let stopped = false;

      const settings = () => ctx.dependency<SettingsLike>('settings');
      const preferred = (): (string | null | undefined)[] => {
        const fromSettings = settings();
        const chosen = fromSettings?.commands.keys().includes('locale')
          ? (fromSettings.commands.get('locale') as string | null)
          : override;
        return [chosen, ...languages()];
      };

      const fail = (error: unknown) => {
        ctx.state.update((s) => void (s.lastError = (error as Error)?.message ?? String(error)));
        ctx.report(error);
      };

      const register = async (
        locale: string,
        namespace: string,
        messages: Readonly<Record<string, string>>,
        version?: string | number,
      ) => {
        const result = await processor.call({ messages });
        if (stopped) return;
        for (const { key, message } of result.errors) {
          ctx.report(
            new Error(
              `The message "${key}" of ${idOf(locale, namespace)} is not valid: ${message}`,
            ),
          );
        }
        registry.set(idOf(locale, namespace), {
          messages: result.messages,
          version,
          usedAt: Date.now(),
        });
        evict();
        ctx.state.update((s) => void s.revision++);
      };

      /** Removes the least recently used catalogs that the chain does not need now. */
      const evict = () => {
        if (registry.size <= maxCatalogs) return;
        const { chain, namespaces } = ctx.state.get();
        const needed = new Set(chain.flatMap((l) => namespaces.map((n) => idOf(l, n))));
        const candidates = [...registry.entries()]
          .filter(([id]) => !needed.has(id))
          .sort((a, b) => a[1].usedAt - b[1].usedAt);
        while (registry.size > maxCatalogs && candidates.length > 0) {
          registry.delete(candidates.shift()![0]);
        }
      };

      const fetchCatalog = async (
        locale: string,
        namespace: string,
        etag?: string,
      ): Promise<{ catalog: StoredCatalog } | 'not-modified' | null> => {
        const url = options
          .url!.replaceAll('{locale}', encodeURIComponent(locale))
          .replaceAll('{namespace}', encodeURIComponent(namespace));
        const headers: Record<string, string> = etag ? { 'If-None-Match': etag } : {};
        const network = ctx.dependency<NetworkLike>('network');
        let status: number;
        let data: unknown;
        let tag: string | undefined;
        if (network) {
          const response = await network.commands.request({
            url,
            headers,
            responseType: 'json',
            allowErrorStatus: true,
            background: true,
            importance: 'LOW',
          });
          status = response.status;
          data = response.data;
          tag = response.headers.etag;
        } else {
          const response = await fetch(url, { headers });
          status = response.status;
          data = status === 200 ? await response.json() : null;
          tag = response.headers.get('etag') ?? undefined;
        }
        if (status === 304) return 'not-modified';
        if (status === 404) return null;
        if (status < 200 || status >= 300)
          throw new Error(`The catalog ${url} answered ${status}.`);
        const body = (data ?? {}) as {
          messages?: Record<string, string>;
          version?: string | number;
        };
        const messages =
          body.messages && typeof body.messages === 'object'
            ? body.messages
            : (body as Record<string, string>);
        return { catalog: { messages, version: body.version, etag: tag } };
      };

      /** Checks a catalog from Storage against the server, in the background. */
      const revalidate = (locale: string, namespace: string, stored: StoredCatalog) => {
        fetchCatalog(locale, namespace, stored.etag)
          .then(async (result) => {
            if (!result || result === 'not-modified' || stopped) return;
            await register(locale, namespace, result.catalog.messages, result.catalog.version);
            await collection?.set(idOf(locale, namespace), result.catalog);
          })
          .catch(() => {}); // Offline, or the server is down: the stored catalog stays.
      };

      /** Loads one catalog, from the first source that has it. */
      const ensure = (locale: string, namespace: string): Promise<void> => {
        const id = idOf(locale, namespace);
        if (registry.has(id)) return Promise.resolve();
        const running = inFlight.get(id);
        if (running) return running;
        const task = (async () => {
          const fromOptions = inline.get(id);
          if (fromOptions)
            return register(locale, namespace, fromOptions.messages, fromOptions.version);
          const stored = await collection?.get(id).catch(() => undefined);
          if (stored) {
            await register(locale, namespace, stored.messages, stored.version);
            if (options.url) revalidate(locale, namespace, stored);
            return;
          }
          if (options.load) {
            const loaded = await options.load(locale, namespace);
            if (loaded) return register(locale, namespace, loaded.messages, loaded.version);
          }
          if (options.url) {
            const result = await fetchCatalog(locale, namespace);
            if (result && result !== 'not-modified') {
              await register(locale, namespace, result.catalog.messages, result.catalog.version);
              await collection
                ?.set(id, result.catalog)
                .catch((error: unknown) => ctx.report(error));
            }
          }
        })()
          .catch(fail)
          .finally(() => inFlight.delete(id));
        inFlight.set(id, task);
        return task;
      };

      /** Loads what the current chain and namespaces need. */
      const loadAll = (pairs: Array<[string, string]>) => {
        if (pairs.length === 0) return idle;
        ctx.state.update((s) => void s.loading++);
        const run = Promise.all(pairs.map(([l, n]) => ensure(l, n))).then(() => {
          if (!stopped) ctx.state.update((s) => void s.loading--);
        });
        idle = Promise.all([idle, run]).then(() => {});
        return run;
      };

      /** Resolves the chain again, and loads its catalogs. */
      const refresh = () => {
        const chain = resolveLocaleChain(preferred(), supported, defaultLocale);
        const before = ctx.state.get();
        const locale = chain[0]!;
        if (chain.join() !== before.chain.join()) {
          const direction = textDirection(locale);
          ctx.state.update((s) => {
            s.chain = chain;
            s.locale = locale;
            s.direction = direction;
          });
          if (locale !== before.locale) {
            const change: LocaleChange = { oldLocale: before.locale, newLocale: locale, direction };
            ctx.port
              .send({ eventId: LOCALE_CHANGED, payload: change, importance: 'HIGH' })
              .catch((error: unknown) => ctx.report(error));
          }
        }
        const { namespaces } = ctx.state.get();
        return loadAll(chain.flatMap((l) => namespaces.map((n): [string, string] => [l, n])));
      };

      api = {
        lookup(key, namespace) {
          const { chain, namespaces } = ctx.state.get();
          for (const locale of chain) {
            for (const ns of namespace ? [namespace] : namespaces) {
              const entry = registry.get(idOf(locale, ns));
              const message = entry?.messages[key];
              if (entry && message) {
                entry.usedAt = Date.now();
                return { message, locale };
              }
            }
          }
          return null;
        },
        missed(key) {
          const locale = ctx.state.get().locale;
          const id = `${key} (${locale})`;
          if (missing.has(id)) return;
          missing.add(id);
          ctx.state.update((s) => void (s.missing = missing.size));
          const payload: MissingKey = { key, locale };
          ctx.port
            .send({ eventId: MISSING_KEY, payload, importance: 'LOW' })
            .catch((error: unknown) => ctx.report(error));
        },
        context(locale) {
          let context = contexts.get(locale);
          if (!context)
            contexts.set(locale, (context = createFormatContext(locale, { escape, currency })));
          return context;
        },
        async setLocale(locale) {
          if (locale !== null && canonicalLocale(locale) === null) {
            throw new RangeError(`"${locale}" is not a BCP 47 locale tag.`);
          }
          const fromSettings = settings();
          if (fromSettings?.commands.keys().includes('locale')) {
            await fromSettings.commands.set(
              'locale',
              locale === null ? null : canonicalLocale(locale),
            );
          } else {
            override = locale === null ? null : canonicalLocale(locale);
          }
          await refresh();
        },
        async load(namespace) {
          if (!ctx.state.get().namespaces.includes(namespace)) {
            ctx.state.update((s) => void s.namespaces.push(namespace));
          }
          await refresh();
        },
        unload(namespace) {
          ctx.state.update(
            (s) => void (s.namespaces = s.namespaces.filter((n) => n !== namespace)),
          );
          let removed = false;
          for (const id of [...registry.keys()]) {
            if (id.endsWith(`/${namespace}`)) removed = registry.delete(id) || removed;
          }
          if (removed) ctx.state.update((s) => void s.revision++);
        },
        async add(catalog) {
          const locale = canonicalLocale(catalog.locale);
          if (!locale) throw new RangeError(`"${catalog.locale}" is not a BCP 47 locale tag.`);
          inline.set(idOf(locale, catalog.namespace), { ...catalog, locale });
          await register(locale, catalog.namespace, catalog.messages, catalog.version);
        },
        ready: async () => {
          let seen: Promise<void> | null = null;
          while (seen !== idle) {
            seen = idle;
            await idle;
          }
        },
        missing: () => [...missing],
      };

      // Use Storage when it runs, and follow the setting 'locale'. The watches
      // call back at once; the first refresh waits until both are set up.
      let watching = false;
      const stopStorage = ctx.watch<StorageLike>('storage', (storage) => {
        collection =
          typeof storage?.commands?.collection === 'function'
            ? storage.commands.collection({ name: CATALOG_COLLECTION, encrypt: false })
            : null;
        if (collection && watching) void refresh(); // Catalogs that could not load may be in Storage.
      });
      let stopValues: (() => void) | undefined;
      const stopSettings = ctx.watch<SettingsLike>('settings', (next) => {
        stopValues?.();
        stopValues = undefined;
        if (typeof next?.views?.values?.subscribe === 'function') {
          let last = next.commands.keys().includes('locale') ? next.commands.get('locale') : null;
          stopValues = next.views.values.subscribe(() => {
            const value = next.views.values.getSnapshot().locale;
            if (value === last) return;
            last = value;
            void refresh();
          });
        }
        if (watching) void refresh();
      });
      watching = true;

      // A slow catalog server must not hold the boot.
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        refresh(),
        new Promise<void>((resolve) => (timer = setTimeout(resolve, options.startWaitMs ?? 2000))),
      ]);
      clearTimeout(timer);
      return () => {
        stopped = true;
        stopHost();
        stopSettings();
        stopStorage();
        stopValues?.();
        api = null;
      };
    },
    control: (ctx) => {
      const running = () => {
        if (!api) throw new Error('Translation does not run.');
        return api;
      };
      const locale = () => ctx.state.get().locale;
      const context = () => running().context(locale());
      const t = (
        key: string,
        params: Readonly<Record<string, unknown>> = {},
        lookupOptions: { namespace?: string } = {},
      ) => {
        const found = running().lookup(key, lookupOptions.namespace);
        if (!found) {
          running().missed(key);
          if (options.strict) throw new MissingTranslationError(key, locale());
          return key;
        }
        try {
          return formatMessage(found.message, params, running().context(found.locale));
        } catch (error) {
          ctx.report(error);
          return key;
        }
      };
      return {
        commands: {
          t,
          has: (key: string, lookupOptions: { namespace?: string } = {}) =>
            running().lookup(key, lookupOptions.namespace) !== null,
          setLocale: (next: string | null) => running().setLocale(next),
          loadNamespace: (namespace: string) => running().load(namespace),
          unloadNamespace: (namespace: string) => running().unload(namespace),
          addCatalog: (catalog: MessageCatalog) => running().add(catalog),
          ready: () => running().ready(),
          missingKeys: () => running().missing(),
          formatNumber: (value: number | bigint, o: Intl.NumberFormatOptions = {}) =>
            context().number(o).format(value),
          formatCurrency: (
            value: number,
            code = currency,
            display: 'symbol' | 'code' | 'name' | 'narrowSymbol' = 'symbol',
          ) =>
            context()
              .number({ style: 'currency', currency: code, currencyDisplay: display })
              .format(value),
          formatDate: (
            value: Date | number | string,
            o: Intl.DateTimeFormatOptions = { dateStyle: 'medium' },
          ) =>
            context()
              .date(o)
              .format(value instanceof Date ? value : new Date(value)),
          formatRelativeTime: (
            value: number,
            unit: Intl.RelativeTimeFormatUnit,
            o: Intl.RelativeTimeFormatOptions = { numeric: 'auto' },
          ) => new Intl.RelativeTimeFormat(locale(), o).format(value, unit),
          formatList: (items: readonly string[], o: Intl.ListFormatOptions = {}) =>
            new Intl.ListFormat(locale(), o).format(items),
          compare: (a: string, b: string) => new Intl.Collator(locale()).compare(a, b),
        },
        views: { state: ctx.state.readable },
      };
    },
  });
}
