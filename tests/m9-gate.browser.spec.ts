/**
 * The M9 gate, browser part (docs/ARCHITECTURE.md §21.6): two tabs of one
 * site (two kernels joined by the Window transport). A setting changed in
 * one tab changes the locale of Translation in the other, and Analytics in
 * the other tab sends nothing until the analytics grant reaches it.
 */
import {
  ANALYTICS_ID,
  createAnalytics,
  type AnalyticsBatch,
  type AnalyticsControl,
} from '@platform/analytics';
import { CONSENT_ID, createConsent, type ConsentControl } from '@platform/consent';
import { Kernel, type SubsystemDefinition } from '@platform/core';
import {
  createGlobalState,
  GLOBAL_STATE_ID,
  type GlobalStateControl,
} from '@platform/global-state';
import {
  WINDOW_TRANSPORT_ID,
  createWindowTransport,
  type WindowTransportControl,
} from '@platform/hub';
import { createNotificationCenter } from '@platform/notification';
import { createQueue } from '@platform/queue';
import { SETTINGS_ID, createSettings, type SettingsControl } from '@platform/settings';
import { TRANSLATION_ID, createTranslation, type TranslationControl } from '@platform/translation';
import { afterEach, describe, expect, it } from 'vitest';

const kernels: Kernel[] = [];
afterEach(async () => {
  for (const kernel of kernels.splice(0)) await kernel.stop();
});

async function tab(channel: string, batches: AnalyticsBatch[]) {
  const notification = createNotificationCenter();
  const queue = createQueue({ fanOut: notification.fanOut });
  const kernel = new Kernel(
    [
      createGlobalState(),
      queue.subsystem,
      notification.subsystem,
      createWindowTransport({ channel }),
      createConsent(),
      createSettings(),
      createTranslation({
        supportedLocales: ['en', 'de'],
        languages: () => ['en'],
        catalogs: [
          {
            locale: 'en',
            namespace: 'common',
            messages: { saved: 'Saved {n, plural, one {# file} other {# files}}' },
          },
          {
            locale: 'de',
            namespace: 'common',
            messages: { saved: '{n, plural, one {# Datei} other {# Dateien}} gespeichert' },
          },
        ],
      }),
      createAnalytics({ send: async (batch) => void batches.push(batch), random: () => 0 }),
    ] as SubsystemDefinition[],
    { router: queue.router },
  );
  kernels.push(kernel);
  await kernel.start();
  const transport = kernel.unit<WindowTransportControl>(WINDOW_TRANSPORT_ID).control!;
  await expect.poll(() => transport.views.state.getSnapshot().connection).toBe('connected');
  return {
    settings: kernel.unit<SettingsControl>(SETTINGS_ID).control!,
    i18n: kernel.unit<TranslationControl>(TRANSLATION_ID).control!,
    analytics: kernel.unit<AnalyticsControl>(ANALYTICS_ID).control!,
    consent: kernel.unit<ConsentControl>(CONSENT_ID).control!,
    globalState: kernel.unit<GlobalStateControl>(GLOBAL_STATE_ID).control!,
  };
}

describe('M9 gate in the browser: two tabs', () => {
  it('a setting in one tab changes the other, and Analytics waits for the grant', async () => {
    const channel = `m9-gate-${crypto.randomUUID()}`;
    const batchesB: AnalyticsBatch[] = [];
    const a = await tab(channel, []);
    const b = await tab(channel, batchesB);
    await b.i18n.commands.ready();
    expect(b.i18n.views.state.getSnapshot().compiler).toBe('dedicated');
    expect(b.i18n.commands.t('saved', { n: 2 })).toBe('Saved 2 files');

    // A setting changed in tab A changes Translation in tab B.
    await a.settings.commands.set('locale', 'de');
    await expect.poll(() => b.i18n.views.state.getSnapshot().locale).toBe('de');
    await b.i18n.commands.ready();
    expect(b.i18n.commands.t('saved', { n: 2 })).toBe('2 Dateien gespeichert');

    // Analytics in tab B sends nothing until the grant made in tab A arrives.
    b.analytics.commands.track('before');
    await b.analytics.commands.flush();
    expect(batchesB).toEqual([]);
    a.settings.commands.enableAnalytics();
    await expect.poll(() => b.consent.commands.isGranted('analytics')).toBe(true);
    await expect.poll(() => b.analytics.views.state.getSnapshot().collecting).toBe(true);
    b.analytics.commands.track('after');
    await b.analytics.commands.flush();
    expect(batchesB.flatMap((batch) => batch.events.map((e) => e.name))).toEqual(['after']);

    // Both tabs count each other.
    await expect.poll(() => a.globalState.views.state.getSnapshot().tabs).toBeGreaterThanOrEqual(2);
  });
});
