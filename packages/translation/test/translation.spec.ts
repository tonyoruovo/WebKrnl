/**
 * The Translation subsystem (docs/ARCHITECTURE.md §21.2): the chain, the
 * catalog sources, offline catalogs, Settings, missing keys and formatting.
 */
import { createConsent } from '@webkrnl/consent';
import { Kernel, NO_CONTROL, type Scheduler, type SubsystemDefinition } from '@webkrnl/core';
import { createNetwork } from '@webkrnl/network';
import { createNotificationCenter } from '@webkrnl/notification';
import { createQueue } from '@webkrnl/queue';
import { SETTINGS_ID, createSettings, type SettingsControl } from '@webkrnl/settings';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  CATALOG_COLLECTION,
  LOCALE_CHANGED,
  MISSING_KEY,
  MissingTranslationError,
  TRANSLATION_ID,
  createTranslation,
  type MessageCatalog,
  type TranslationControl,
  type TranslationOptions,
} from '../src';

const scheduler: Scheduler = {
  kind: 'timeout',
  postTask: (task) => Promise.resolve().then(task),
  yield: () => Promise.resolve(),
  idle: (task) => Promise.resolve().then(task),
};

const kernels: Kernel[] = [];
afterEach(async () => {
  for (const kernel of kernels.splice(0)) await kernel.stop();
});

const catalogs: MessageCatalog[] = [
  {
    locale: 'en',
    namespace: 'common',
    messages: {
      hello: 'Hello, {name}!',
      items: '{count, plural, one {# item} other {# items}}',
      only: 'Only in English',
    },
  },
  { locale: 'fr', namespace: 'common', messages: { hello: 'Bonjour, {name} !' } },
  {
    locale: 'fr-CA',
    namespace: 'common',
    messages: { items: '{count, plural, one {# article} other {# articles}}' },
  },
  { locale: 'ar', namespace: 'common', messages: { hello: 'مرحبا {name}' } },
];

/** A Storage double: one in-memory map for each collection. */
function memoryStorage(maps = new Map<string, Map<string, unknown>>()): SubsystemDefinition {
  return {
    id: 'storage',
    scope: 'tab',
    kind: 'featurized',
    state: { initial: {} },
    control: () => ({
      commands: {
        collection: ({ name }: { name: string }) => {
          if (!maps.has(name)) maps.set(name, new Map());
          const map = maps.get(name)!;
          return {
            get: async (key: string) => structuredClone(map.get(key)),
            set: async (key: string, value: unknown) => void map.set(key, structuredClone(value)),
          };
        },
      },
      views: {},
    }),
  };
}

async function boot(options: TranslationOptions, units: SubsystemDefinition[] = []) {
  const errors: unknown[] = [];
  const heard: Array<{ eventId: string; payload: unknown }> = [];
  const notification = createNotificationCenter();
  const queue = createQueue({ scheduler, fanOut: notification.fanOut });
  const listener: SubsystemDefinition = {
    id: 'listener',
    scope: 'tab',
    kind: 'featurized',
    state: { initial: {} },
    subscribes: [LOCALE_CHANGED, MISSING_KEY],
    receive: (packet) =>
      void heard.push({ eventId: packet.header.eventId, payload: packet.take() }),
    control: () => NO_CONTROL,
  };
  const kernel = new Kernel(
    [
      queue.subsystem,
      notification.subsystem,
      ...units,
      createTranslation({ hosts: ['virtual'], languages: () => ['en'], ...options }),
      listener,
    ] as SubsystemDefinition[],
    { router: queue.router, onError: (error) => void errors.push(error) },
  );
  kernels.push(kernel);
  await kernel.start();
  const i18n = kernel.unit<TranslationControl>(TRANSLATION_ID).control!;
  await i18n.commands.ready();
  return { kernel, i18n, errors, heard };
}

describe('messages and the chain', () => {
  it('translates through the chain of the device locale', async () => {
    const { i18n } = await boot({
      catalogs,
      supportedLocales: ['en', 'fr', 'fr-CA'],
      languages: () => ['fr-CA', 'en'],
    });
    expect(i18n.views.state.getSnapshot()).toMatchObject({
      locale: 'fr-CA',
      chain: ['fr-CA', 'fr', 'en'],
      direction: 'ltr',
    });
    expect(i18n.commands.t('items', { count: 2 })).toBe('2 articles'); // fr-CA
    expect(i18n.commands.t('hello', { name: 'Zoé' })).toBe('Bonjour, Zoé !'); // fr
    expect(i18n.commands.t('only')).toBe('Only in English'); // en
  });

  it('returns the key for a missing message, and reports it once', async () => {
    const { kernel, i18n, heard } = await boot({ catalogs });
    expect(i18n.commands.t('nope')).toBe('nope');
    expect(i18n.commands.t('nope')).toBe('nope');
    await kernel.settled();
    await vi.waitFor(() =>
      expect(heard.filter((h) => h.eventId === MISSING_KEY)).toEqual([
        { eventId: MISSING_KEY, payload: { key: 'nope', locale: 'en' } },
      ]),
    );
    expect(i18n.commands.missingKeys()).toEqual(['nope (en)']);
    expect(i18n.views.state.getSnapshot().missing).toBe(1);
    expect(i18n.commands.has('hello')).toBe(true);
    expect(i18n.commands.has('nope')).toBe(false);
  });

  it('throws for a missing key in strict mode', async () => {
    const { i18n } = await boot({ catalogs, strict: true });
    expect(() => i18n.commands.t('nope')).toThrow(MissingTranslationError);
  });

  it('reports a message that does not parse, and falls back past it', async () => {
    const { i18n, errors } = await boot({
      supportedLocales: ['en', 'fr'],
      languages: () => ['fr'],
      catalogs: [
        { locale: 'fr', namespace: 'common', messages: { hello: 'Bonjour {name' } },
        { locale: 'en', namespace: 'common', messages: { hello: 'Hello, {name}!' } },
      ],
    });
    expect(i18n.commands.t('hello', { name: 'A' })).toBe('Hello, A!');
    expect(String(errors[0])).toContain('"hello" of fr/common is not valid');
  });

  it('changes the locale and its direction, and broadcasts the change', async () => {
    const { kernel, i18n, heard } = await boot({ catalogs, supportedLocales: ['en', 'ar'] });
    await i18n.commands.setLocale('ar');
    expect(i18n.views.state.getSnapshot()).toMatchObject({ locale: 'ar', direction: 'rtl' });
    expect(i18n.commands.t('hello', { name: 'Ali' })).toBe('مرحبا Ali');
    await kernel.settled();
    await vi.waitFor(() =>
      expect(heard.find((h) => h.eventId === LOCALE_CHANGED)?.payload).toEqual({
        oldLocale: 'en',
        newLocale: 'ar',
        direction: 'rtl',
      }),
    );
    await i18n.commands.setLocale(null);
    expect(i18n.views.state.getSnapshot().locale).toBe('en');
    await expect(i18n.commands.setLocale('not a tag')).rejects.toThrow(RangeError);
  });

  it('escapes parameters unless told not to', async () => {
    const escaped = await boot({ catalogs });
    expect(escaped.i18n.commands.t('hello', { name: '<b>' })).toBe('Hello, &lt;b&gt;!');
    const raw = await boot({ catalogs, escapeParams: false });
    expect(raw.i18n.commands.t('hello', { name: '<b>' })).toBe('Hello, <b>!');
  });
});

describe('Settings', () => {
  it('follows the setting locale, and setLocale changes the setting', async () => {
    const { kernel, i18n } = await boot({ catalogs, supportedLocales: ['en', 'fr'] }, [
      createConsent(),
      createSettings(),
    ]);
    const settings = kernel.unit<SettingsControl>(SETTINGS_ID).control!;
    await settings.commands.set('locale', 'fr');
    await vi.waitFor(() => expect(i18n.views.state.getSnapshot().locale).toBe('fr'));
    await i18n.commands.ready();
    expect(i18n.commands.t('hello', { name: 'Ada' })).toBe('Bonjour, Ada !');

    await i18n.commands.setLocale('en');
    expect(settings.commands.get('locale')).toBe('en');
  });
});

describe('catalog sources', () => {
  it('loads namespaces through the loader, and unloads them', async () => {
    const load = vi.fn(async (locale: string, namespace: string) =>
      namespace === 'checkout' ? { messages: { pay: `Pay (${locale})` } } : null,
    );
    const { i18n } = await boot({ catalogs, load });
    expect(i18n.commands.t('pay')).toBe('pay');
    await i18n.commands.loadNamespace('checkout');
    expect(i18n.commands.t('pay')).toBe('Pay (en)');
    expect(i18n.commands.t('pay', {}, { namespace: 'common' })).toBe('pay');
    expect(i18n.views.state.getSnapshot().namespaces).toEqual(['common', 'checkout']);
    i18n.commands.unloadNamespace('checkout');
    expect(i18n.commands.t('pay')).toBe('pay');
  });

  it('adds catalogs from the app', async () => {
    const { i18n } = await boot({});
    await i18n.commands.addCatalog({ locale: 'en', namespace: 'common', messages: { a: 'A' } });
    expect(i18n.commands.t('a')).toBe('A');
  });

  it('fetches catalog files, keeps them in Storage, and serves them offline', async () => {
    const maps = new Map<string, Map<string, unknown>>();
    let online = true;
    const requests: Array<{ url: string; etag: string | null }> = [];
    const fetchCatalog = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      if (!online) throw new TypeError('Failed to fetch');
      requests.push({ url: request.url, etag: request.headers.get('if-none-match') });
      if (request.headers.get('if-none-match') === '"v1"')
        return new Response(null, { status: 304 });
      return Response.json(
        { messages: { hello: 'Hello from the server, {name}!' }, version: 1 },
        { headers: { etag: '"v1"' } },
      );
    });
    vi.stubGlobal('fetch', fetchCatalog);
    try {
      const options = { url: 'https://cdn.test/i18n/{locale}/{namespace}.json' };
      const first = await boot(options, [memoryStorage(maps)]);
      expect(first.i18n.commands.t('hello', { name: 'A' })).toBe('Hello from the server, A!');
      await vi.waitFor(() => expect(maps.get(CATALOG_COLLECTION)?.get('en/common')).toBeDefined());
      expect(requests).toEqual([{ url: 'https://cdn.test/i18n/en/common.json', etag: null }]);

      // A reload: the catalog comes from Storage, then is checked with its ETag.
      const second = await boot(options, [memoryStorage(maps)]);
      expect(second.i18n.commands.t('hello', { name: 'B' })).toBe('Hello from the server, B!');
      await vi.waitFor(() => expect(requests).toHaveLength(2));
      expect(requests[1]!.etag).toBe('"v1"');

      // Offline: still there.
      online = false;
      const third = await boot(options, [memoryStorage(maps)]);
      expect(third.i18n.commands.t('hello', { name: 'C' })).toBe('Hello from the server, C!');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('fetches through Network when it runs', async () => {
    const fetch = vi.fn(async () => Response.json({ hello: 'Hi via Network' }));
    const { i18n } = await boot({ url: '/i18n/{locale}/{namespace}.json' }, [
      createNetwork({ fetch, baseUrl: 'https://app.test/' }) as SubsystemDefinition,
    ]);
    expect(i18n.commands.t('hello')).toBe('Hi via Network');
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('does not hold the start for a slow source', async () => {
    let answer: (value: { messages: Record<string, string> }) => void = () => {};
    const load = () => new Promise<{ messages: Record<string, string> }>((r) => (answer = r));
    const notification = createNotificationCenter();
    const queue = createQueue({ scheduler, fanOut: notification.fanOut });
    const kernel = new Kernel(
      [
        queue.subsystem,
        notification.subsystem,
        createTranslation({ hosts: ['virtual'], load, startWaitMs: 20, languages: () => ['en'] }),
      ] as SubsystemDefinition[],
      { router: queue.router },
    );
    kernels.push(kernel);
    await kernel.start();
    const i18n = kernel.unit<TranslationControl>(TRANSLATION_ID).control!;
    expect(i18n.commands.t('hi')).toBe('hi');
    expect(i18n.views.state.getSnapshot().loading).toBe(1);
    answer({ messages: { hi: 'Hi!' } });
    await i18n.commands.ready();
    expect(i18n.commands.t('hi')).toBe('Hi!');
    expect(i18n.views.state.getSnapshot().loading).toBe(0);
  });

  it('keeps at most maxCatalogs in memory, and never the ones in use', async () => {
    const load = vi.fn(async (_locale: string, namespace: string) => ({
      messages: { [namespace]: namespace.toUpperCase() },
    }));
    const { i18n } = await boot({ load, maxCatalogs: 2, namespaces: ['a'] });
    await i18n.commands.loadNamespace('b');
    i18n.commands.unloadNamespace('b');
    await i18n.commands.loadNamespace('c');
    await i18n.commands.loadNamespace('d'); // a, c, d are in use: b goes
    expect(load).toHaveBeenCalledTimes(4);
    await i18n.commands.loadNamespace('b');
    expect(load).toHaveBeenCalledTimes(5); // loaded again
    expect(i18n.commands.t('a')).toBe('A');
  });
});

describe('formatting', () => {
  it('formats with the active locale', async () => {
    const { i18n } = await boot({ supportedLocales: ['en', 'de'], languages: () => ['de'] });
    expect(i18n.commands.formatNumber(1234.5)).toBe('1.234,5');
    expect(i18n.commands.formatCurrency(5, 'EUR')).toBe('5,00 €');
    expect(i18n.commands.formatRelativeTime(-1, 'day')).toBe('gestern');
    expect(i18n.commands.formatList(['A', 'B', 'C'])).toBe('A, B und C');
    expect(
      i18n.commands.formatDate(Date.UTC(2026, 9, 5, 12), { dateStyle: 'short', timeZone: 'UTC' }),
    ).toBe('05.10.26');
    expect(['ö', 'z', 'a'].sort(i18n.commands.compare)).toEqual(['a', 'ö', 'z']);
  });
});
