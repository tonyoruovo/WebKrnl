/**
 * Settings in one tab (docs/ARCHITECTURE.md §21.1): values, checks,
 * persistence, the server handlers with rollback, and the sign-out wipe.
 */
import { createConsent, type ConsentControl } from '@platform/consent';
import { Kernel, type Scheduler, type SubsystemDefinition } from '@platform/core';
import { createMemoryPersistence, createTestAuth } from '@platform/core/testing';
import { createNotificationCenter } from '@platform/notification';
import { createQueue } from '@platform/queue';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  SETTINGS_ID,
  createSettings,
  optimisticUpdate,
  type SettingsControl,
  type SettingsOptions,
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

let clock = 1_000;

async function boot(
  options: SettingsOptions = {},
  extra: {
    persistence?: ReturnType<typeof createMemoryPersistence>;
    units?: SubsystemDefinition[];
  } = {},
) {
  const errors: unknown[] = [];
  const notification = createNotificationCenter();
  const queue = createQueue({ scheduler, fanOut: notification.fanOut });
  const kernel = new Kernel(
    [
      queue.subsystem,
      notification.subsystem,
      createConsent(),
      createSettings({ now: () => ++clock, ...options }),
      ...(extra.units ?? []),
    ] as SubsystemDefinition[],
    {
      router: queue.router,
      persistence: extra.persistence,
      onError: (error) => void errors.push(error),
    },
  );
  kernels.push(kernel);
  await kernel.start();
  return {
    kernel,
    errors,
    settings: kernel.unit<SettingsControl>(SETTINGS_ID).control!,
    consent: kernel.unit<ConsentControl>('consent').control!,
  };
}

describe('values', () => {
  it('starts with the defaults, and changes a value at once', async () => {
    const { settings } = await boot();
    expect(settings.views.values.getSnapshot()).toEqual({
      syncInterval: 300_000,
      bandwidthMode: 'FULL',
      dataSaver: false,
      locale: null,
    });
    await expect(settings.commands.set('dataSaver', true)).resolves.toBe(true);
    expect(settings.commands.get('dataSaver')).toBe(true);
    expect(settings.views.values.getSnapshot().dataSaver).toBe(true);
  });

  it('refuses unknown keys and values that fail the check, and changes nothing', async () => {
    const { settings } = await boot();
    expect(() => settings.commands.set('colour', 'red')).toThrow(RangeError);
    expect(() => settings.commands.update({ dataSaver: true, bandwidthMode: 'FAST' })).toThrow(
      RangeError,
    );
    expect(() => settings.commands.set('syncInterval', 10)).toThrow(RangeError);
    expect(() => settings.commands.set('locale', 'not a locale!')).toThrow(RangeError);
    expect(() => settings.commands.get('colour')).toThrow(RangeError);
    expect(settings.commands.get('dataSaver')).toBe(false);
  });

  it('takes app definitions and changes to the built-in ones', async () => {
    const { settings } = await boot({
      definitions: {
        'editor.fontSize': { default: 14, validate: (v) => v === 12 || v === 14 || v === 16 },
        syncInterval: { default: 60_000 },
      },
    });
    expect(settings.commands.keys()).toContain('editor.fontSize');
    expect(settings.commands.get('syncInterval')).toBe(60_000);
    await settings.commands.set('editor.fontSize', 16);
    expect(() => settings.commands.set('editor.fontSize', 15)).toThrow(RangeError);
    expect(() =>
      createSettings({ definitions: { bad: { default: 1, validate: () => false } } }),
    ).toThrow(RangeError);
  });

  it('resets values to their defaults', async () => {
    const { settings } = await boot();
    await settings.commands.update({ dataSaver: true, bandwidthMode: 'MINIMAL' });
    await settings.commands.reset(['dataSaver']);
    expect(settings.views.values.getSnapshot()).toMatchObject({
      dataSaver: false,
      bandwidthMode: 'MINIMAL',
    });
    await settings.commands.reset();
    expect(settings.commands.get('bandwidthMode')).toBe('FULL');
  });

  it('keeps the values after a reload', async () => {
    const persistence = createMemoryPersistence();
    const first = await boot({}, { persistence });
    await first.settings.commands.set('bandwidthMode', 'CONSERVATIVE');
    await vi.waitFor(() => expect(persistence.saved.get(SETTINGS_ID)).toBeDefined());
    // A crash: the kernel does not stop, so only the automatic save keeps the change.
    kernels.splice(kernels.indexOf(first.kernel), 1);
    const second = await boot({}, { persistence });
    expect(second.settings.commands.get('bandwidthMode')).toBe('CONSERVATIVE');
    await first.kernel.stop();
  });
});

describe('the server', () => {
  it('saves user settings, and not device settings', async () => {
    const save = vi.fn(async () => {});
    const { settings } = await boot({ handlers: { save } });
    await settings.commands.update({ locale: 'fr-FR', dataSaver: true });
    expect(save).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledWith({ locale: 'fr-FR' });
    await settings.commands.set('dataSaver', false);
    expect(save).toHaveBeenCalledTimes(1);
  });

  it('rolls a change back when the save fails', async () => {
    let fail = true;
    const { settings, errors } = await boot({
      handlers: {
        save: async () => {
          if (fail) throw new Error('503');
        },
      },
    });
    const saved = settings.commands.set('locale', 'de');
    expect(settings.commands.get('locale')).toBe('de'); // at once
    await expect(saved).resolves.toBe(false);
    expect(settings.commands.get('locale')).toBeNull();
    expect(settings.views.state.getSnapshot()).toMatchObject({ saving: 0, lastError: '503' });
    expect(errors).toHaveLength(1);

    fail = false;
    await expect(settings.commands.set('locale', 'de')).resolves.toBe(true);
    expect(settings.views.state.getSnapshot().lastError).toBeNull();
  });

  it('loads the user settings when a user signs in, and wipes them at sign-out', async () => {
    const auth = createTestAuth();
    const load = vi.fn(async () => ({ locale: 'ja', dataSaver: true, unknown: 1 }));
    const save = vi.fn(async () => {});
    const { kernel, settings } = await boot({ handlers: { load, save } }, { units: [auth.unit] });
    await settings.commands.set('locale', 'en-GB'); // nobody signed in: not saved
    expect(save).not.toHaveBeenCalled();

    auth.signIn('u1');
    await vi.waitFor(() => expect(settings.commands.get('locale')).toBe('ja'));
    expect(settings.commands.get('dataSaver')).toBe(false); // a device setting: not from the server
    await settings.commands.set('dataSaver', true);

    auth.signOut();
    await kernel.settled();
    await vi.waitFor(() => expect(settings.commands.get('locale')).toBeNull());
    expect(settings.commands.get('dataSaver')).toBe(true); // the device setting stays
  });

  it('drops a load that a sign-out overtook', async () => {
    const auth = createTestAuth();
    let answer: (values: Record<string, string>) => void = () => {};
    const load = () => new Promise<Record<string, string>>((resolve) => (answer = resolve));
    const { kernel, settings } = await boot({ handlers: { load } }, { units: [auth.unit] });
    auth.signIn('u1');
    await kernel.settled();
    auth.signOut();
    await kernel.settled();
    answer({ locale: 'ja' });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(settings.commands.get('locale')).toBeNull();
  });
});

describe('analytics through Consent', () => {
  it('reads and changes the analytics grant', async () => {
    const { settings, consent } = await boot();
    expect(settings.commands.isAnalyticsEnabled()).toBe(false);
    expect(settings.commands.enableAnalytics()).toBe(true);
    expect(consent.commands.isGranted('analytics')).toBe(true);
    expect(settings.commands.disableAnalytics()).toBe(true);
    expect(settings.commands.isAnalyticsEnabled()).toBe(false);
    expect(consent.commands.isGranted('necessary')).toBe(true);
  });
});

describe('optimisticUpdate', () => {
  it('applies, commits, and rolls back on failure', async () => {
    let value = 'a';
    await expect(
      optimisticUpdate(
        () => (value = 'b'),
        async () => 'ok',
        () => (value = 'a'),
      ),
    ).resolves.toBe('ok');
    expect(value).toBe('b');
    const error = new Error('no');
    await expect(
      optimisticUpdate(
        () => (value = 'c'),
        () => Promise.reject(error),
        (e) => {
          expect(e).toBe(error);
          value = 'b';
        },
      ),
    ).rejects.toBe(error);
    expect(value).toBe('b');
  });
});
