/**
 * The M9 gate, Node part (docs/ARCHITECTURE.md §21.6): the whole catalogue
 * boots in one kernel, and the product subsystems work together: a setting
 * changes the locale of Translation and the theme, Analytics sends nothing until the
 * analytics grant, and a sign-out wipes the user data of each subsystem.
 */
import 'fake-indexeddb/auto';

import {
  ANALYTICS_ID,
  createAnalytics,
  type AnalyticsBatch,
  type AnalyticsControl,
} from '@webkrnl/analytics';
import { AUTH_ID, createAuth, type AuthControl, type AuthHandlers } from '@webkrnl/auth';
import { CONSENT_ID, createConsent, type ConsentControl } from '@webkrnl/consent';
import { Kernel, type SubsystemDefinition } from '@webkrnl/core';
import { createCrypto } from '@webkrnl/crypto';
import {
  APPEARANCE_SETTINGS,
  DESIGN_SYSTEM_ID,
  createDesignSystem,
  type DesignSystemControl,
} from '@webkrnl/design-system';
import {
  GLOBAL_STATE_ID,
  createGlobalState,
  createStaticEnvironment,
  type GlobalStateControl,
} from '@webkrnl/global-state';
import { createWindowTransport } from '@webkrnl/hub';
import { createLogger } from '@webkrnl/logger';
import { createNetwork } from '@webkrnl/network';
import { createNotificationCenter } from '@webkrnl/notification';
import { createQueue } from '@webkrnl/queue';
import { createRealtime, type SocketLike } from '@webkrnl/realtime';
import {
  SETTINGS_ID,
  createSettings,
  type SettingValue,
  type SettingsControl,
} from '@webkrnl/settings';
import { createStorage } from '@webkrnl/storage';
import { createSync } from '@webkrnl/sync';
import { TRANSLATION_ID, createTranslation, type TranslationControl } from '@webkrnl/translation';
import { afterEach, describe, expect, it, vi } from 'vitest';

const kernels: Kernel[] = [];
afterEach(async () => {
  for (const kernel of kernels.splice(0)) await kernel.stop();
});

/** A socket server that accepts and answers pings. */
function socket(): SocketLike {
  const s: SocketLike = {
    readyState: 0,
    onopen: null,
    onmessage: null,
    onclose: null,
    onerror: null,
    send(data) {
      if ((JSON.parse(String(data)) as { type: string }).type === 'ping') {
        setTimeout(() => s.onmessage?.({ data: JSON.stringify({ type: 'pong' }) }), 1);
      }
    },
    close() {
      (s as { readyState: number }).readyState = 3;
    },
  };
  setTimeout(() => {
    (s as { readyState: number }).readyState = 1;
    s.onopen?.({});
  }, 1);
  return s;
}

describe('M9 gate: the whole catalogue', () => {
  it('boots, and the product subsystems work together', async () => {
    const stamp = Date.now();
    const userSettings = new Map<string, SettingValue>([['locale', 'fr']]);
    const batches: AnalyticsBatch[] = [];
    const handlers: AuthHandlers<{ user: string }> = {
      login: async ({ user }) => ({
        user: { id: user, name: user, roles: [], permissions: [], level: 0 },
        accessToken: 'access',
        refreshToken: 'refresh',
        accessExpiresAt: Date.now() + 3_600_000,
      }),
      refresh: async () => {
        throw new Error('not in this test');
      },
      logout: async () => {},
    };
    const notification = createNotificationCenter();
    const queue = createQueue({ fanOut: notification.fanOut });
    const errors: unknown[] = [];
    const kernel = new Kernel(
      [
        createGlobalState({ environment: createStaticEnvironment() }),
        queue.subsystem,
        notification.subsystem,
        createLogger({ sessionId: 's1' }),
        createWindowTransport({ channel: `m9-${stamp}`, origin: 'https://app.test' }),
        createCrypto({ hosts: ['virtual'], database: `m9-keys-${stamp}` }),
        createStorage({
          domain: 'app',
          database: `m9-${stamp}`,
          hosts: ['virtual'],
          keys: { source: { kind: 'device' }, database: `m9-keys-${stamp}` },
          quota: false,
        }),
        createConsent(),
        createSettings({
          definitions: APPEARANCE_SETTINGS,
          handlers: {
            load: async () => Object.fromEntries(userSettings),
            save: async (changes) => {
              for (const [key, value] of Object.entries(changes)) userSettings.set(key, value);
            },
          },
        }),
        createNetwork({ fetch: async () => Response.json({}), baseUrl: 'https://app.test/' }),
        createAuth({ handlers, persist: false }),
        createSync({ intervalMs: false }),
        createRealtime({ url: 'wss://rt.app.test/', hosts: ['virtual'], socket }),
        createTranslation({
          hosts: ['virtual'],
          supportedLocales: ['en', 'fr'],
          languages: () => ['en'],
          catalogs: [
            {
              locale: 'en',
              namespace: 'common',
              messages: { cart: '{n, plural, one {# item} other {# items}}' },
            },
            {
              locale: 'fr',
              namespace: 'common',
              messages: { cart: '{n, plural, one {# article} other {# articles}}' },
            },
          ],
        }),
        createAnalytics({ send: async (batch) => void batches.push(batch), random: () => 0 }),
        createDesignSystem({ root: null, matchMedia: () => null, storage: null }),
      ] as SubsystemDefinition[],
      { router: queue.router, onError: (error) => void errors.push(error) },
    );
    kernels.push(kernel);
    await kernel.start();

    // 1. Every unit runs, and the platform is idle.
    const statuses = kernel.statuses.getSnapshot();
    const notRunning = Object.entries(statuses).filter(
      ([, s]) => !['READY', 'BUSY'].includes(s.status),
    );
    expect(notRunning).toEqual([]);
    const globalState = kernel.unit<GlobalStateControl>(GLOBAL_STATE_ID).control!;
    await vi.waitFor(() => expect(globalState.views.state.getSnapshot().status).toBe('IDLE'));
    expect(globalState.views.state.getSnapshot().tabs).toBeGreaterThanOrEqual(1);

    const settings = kernel.unit<SettingsControl>(SETTINGS_ID).control!;
    const i18n = kernel.unit<TranslationControl>(TRANSLATION_ID).control!;
    const analytics = kernel.unit<AnalyticsControl>(ANALYTICS_ID).control!;
    const consent = kernel.unit<ConsentControl>(CONSENT_ID).control!;
    const auth = kernel.unit<AuthControl<{ user: string }>>(AUTH_ID).control!;
    await i18n.commands.ready();
    expect(i18n.commands.t('cart', { n: 2 })).toBe('2 items');

    // 2. Analytics sends nothing without the grant.
    analytics.commands.track('before');
    await analytics.commands.flush();
    expect(batches).toEqual([]);

    // 3. A sign-in loads the user settings: the locale of the user changes Translation.
    await auth.commands.login({ user: 'u1' });
    await vi.waitFor(() => expect(settings.commands.get('locale')).toBe('fr'));
    await vi.waitFor(() => expect(i18n.views.state.getSnapshot().locale).toBe('fr'));
    await i18n.commands.ready();
    expect(i18n.commands.t('cart', { n: 2 })).toBe('2 articles');

    // 4. With the grant, Analytics collects and sends.
    settings.commands.enableAnalytics();
    await vi.waitFor(() => expect(analytics.views.state.getSnapshot().collecting).toBe(true));
    analytics.commands.track('purchase');
    await analytics.commands.flush();
    expect(batches.flatMap((b) => b.events.map((e) => e.name))).toEqual(['purchase']);
    expect(consent.commands.isGranted('analytics')).toBe(true);

    // 5. An appearance setting changes the theme; the locale gives its direction and language.
    const ds = kernel.unit<DesignSystemControl>(DESIGN_SYSTEM_ID).control!;
    await settings.commands.set('appearance.colorScheme', 'dark');
    await vi.waitFor(() =>
      expect(ds.views.theme.getSnapshot()).toMatchObject({ colorScheme: 'dark', lang: 'fr' }),
    );

    // 6. A sign-out wipes the user data: the user's locale goes, and so does the buffer.
    analytics.commands.track('private');
    await auth.commands.logout();
    await kernel.settled();
    await vi.waitFor(() => expect(settings.commands.get('locale')).toBeNull());
    await vi.waitFor(() => expect(i18n.views.state.getSnapshot().locale).toBe('en'));
    await vi.waitFor(() => expect(analytics.views.state.getSnapshot().buffered).toBe(0));
    expect(ds.views.theme.getSnapshot().colorScheme).toBe('dark'); // a device setting: it stays
    expect(errors).toEqual([]);
  });
});
