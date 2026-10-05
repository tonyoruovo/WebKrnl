/**
 * Settings in Window scope (docs/ARCHITECTURE.md §21.1): every tab of the
 * site shares the settings, and a rollback reaches the other tabs.
 */
import { createConsent } from '@platform/consent';
import { Kernel, type Scheduler, type StatePersistence } from '@platform/core';
import { createMemoryPersistence } from '@platform/core/testing';
import {
  WINDOW_TRANSPORT_ID,
  createWindowTransport,
  type WindowTransportControl,
} from '@platform/hub';
import { createNotificationCenter } from '@platform/notification';
import { createQueue } from '@platform/queue';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { SETTINGS_ID, createSettings, type SettingsOptions, type SettingsControl } from '../src';

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

async function tab(channel: string, options: SettingsOptions = {}, persistence?: StatePersistence) {
  const notification = createNotificationCenter();
  const queue = createQueue({ scheduler, fanOut: notification.fanOut });
  const kernel = new Kernel(
    [
      queue.subsystem,
      notification.subsystem,
      createWindowTransport({ channel, origin: 'https://app.test' }),
      createConsent(),
      createSettings({ now: () => ++clock, ...options }),
    ],
    { router: queue.router, persistence, onError: () => {} },
  );
  kernels.push(kernel);
  await kernel.start();
  await vi.waitFor(() =>
    expect(
      kernel.unit<WindowTransportControl>(WINDOW_TRANSPORT_ID).control!.views.state.getSnapshot()
        .connection,
    ).toBe('connected'),
  );
  return kernel.unit<SettingsControl>(SETTINGS_ID).control!;
}

describe('Settings in Window scope', () => {
  it('shares a change made in one tab with the other tabs', async () => {
    const a = await tab('settings-1');
    const b = await tab('settings-1');
    await a.commands.set('dataSaver', true);
    await vi.waitFor(() => expect(b.commands.get('dataSaver')).toBe(true));
    await b.commands.set('bandwidthMode', 'MINIMAL');
    await vi.waitFor(() => expect(a.commands.get('bandwidthMode')).toBe('MINIMAL'));
  });

  it('brings a new tab up to date with the open ones', async () => {
    const a = await tab('settings-2', {}, createMemoryPersistence());
    await a.commands.update({ dataSaver: true, syncInterval: 60_000 });
    const late = await tab('settings-2', {}, createMemoryPersistence());
    await vi.waitFor(() =>
      expect(late.views.values.getSnapshot()).toMatchObject({
        dataSaver: true,
        syncInterval: 60_000,
      }),
    );
  });

  it('rolls a failed save back in the other tabs too', async () => {
    const save = () => Promise.reject(new Error('offline'));
    const a = await tab('settings-3', { handlers: { save } });
    const b = await tab('settings-3', { handlers: { save } });
    const seen: unknown[] = [];
    b.views.values.subscribe(() => seen.push(b.views.values.getSnapshot().locale));
    await expect(a.commands.set('locale', 'ar')).resolves.toBe(false);
    await vi.waitFor(() => expect(seen).toContain('ar'));
    await vi.waitFor(() => expect(b.commands.get('locale')).toBeNull());
  });
});
