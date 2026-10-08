/**
 * The orchestrator (docs/ARCHITECTURE.md §22.2): the default set, the
 * subsystems on demand, the wiring, the units of the app, and persistence.
 */
import 'fake-indexeddb/auto';

import { NO_CONTROL, type SubsystemDefinition } from '@webkrnl/core';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createPlatform, type Platform, type PlatformOptions } from '../src';

const platforms: Platform[] = [];
afterEach(async () => {
  for (const platform of platforms.splice(0)) await platform.stop();
});

let n = 0;
async function boot(options: PlatformOptions = {}) {
  const platform = createPlatform({
    appName: `test-${Date.now()}-${++n}`,
    routes: null,
    onError: () => {},
    ...options,
  });
  platforms.push(platform);
  await platform.start();
  return platform;
}

describe('createPlatform', () => {
  it('boots the default set, wired together', async () => {
    const platform = await boot();
    // Node has no location: the Window transport is on only with an origin.
    expect(platform.ids).toEqual([
      'global-state',
      'queue',
      'notification',
      'logger',
      'crypto',
      'storage',
      'consent',
      'settings',
      'network',
      'sync',
      'translation',
      'design-system',
    ]);
    const statuses = platform.kernel.statuses.getSnapshot();
    expect(
      Object.entries(statuses).filter(([, s]) => !['READY', 'BUSY'].includes(s.status)),
    ).toEqual([]);
    await platform.ready;
    // The Design System added its appearance settings to Settings.
    expect(platform.unit('settings')!.commands.keys()).toContain('appearance.colorScheme');
    await platform.unit('settings')!.commands.set('appearance.colorScheme', 'dark');
    await vi.waitFor(() =>
      expect(platform.unit('design-system')!.views.theme.getSnapshot().colorScheme).toBe('dark'),
    );
    expect(platform.unit('auth')).toBeUndefined(); // not registered
  });

  it('turns subsystems off and on', async () => {
    const platform = await boot({
      designSystem: false,
      sync: false,
      crypto: false,
      storage: false,
      analytics: { send: async () => {} },
      realtime: { url: 'wss://rt.test/', hosts: ['virtual'], autoConnect: false },
    });
    expect(platform.ids).toContain('analytics');
    const withHub = await boot({
      hub: { origin: 'https://app.test', channel: `hub-${Date.now()}` },
    });
    expect(withHub.ids).toContain('window');
    expect(platform.ids).toContain('realtime');
    expect(platform.ids).not.toContain('design-system');
    expect(platform.ids).not.toContain('sync');
    expect(platform.unit('settings')!.commands.keys()).not.toContain('appearance.colorScheme');
  });

  it('adds the units of the app, and refuses the ids of the catalogue', async () => {
    const cart: SubsystemDefinition = {
      id: 'cart',
      scope: 'tab',
      kind: 'featurized',
      state: { initial: {} },
      control: () => ({ commands: { size: () => 3 }, views: {} }),
    };
    const platform = await boot({ units: [cart] });
    expect(platform.unit<{ commands: { size(): number } }>('cart')!.commands.size()).toBe(3);
    expect(platform.unit('nothing')).toBeUndefined();
    expect(() =>
      createPlatform({
        units: [{ ...cart, id: 'settings', control: () => NO_CONTROL }],
      }),
    ).toThrow(RangeError);
  });

  it('keeps persisted state between two starts of the same app', async () => {
    const appName = `persist-${Date.now()}`;
    const first = createPlatform({ appName, routes: null, onError: () => {} });
    await first.start();
    first.unit('consent')!.commands.grant('analytics');
    await new Promise((resolve) => setTimeout(resolve, 50)); // the automatic save
    await first.stop();

    const second = createPlatform({ appName, routes: null, onError: () => {} });
    platforms.push(second);
    await second.start();
    expect(second.unit('consent')!.commands.isGranted('analytics')).toBe(true);
  });

  it('sends errors without a caller to the Logger', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const noisy: SubsystemDefinition = {
      id: 'noisy',
      scope: 'tab',
      kind: 'featurized',
      state: { initial: {} },
      init: (ctx) => ctx.report(new Error('the disk is full')),
      control: () => NO_CONTROL,
    };
    const platform = createPlatform({ appName: `log-${Date.now()}`, routes: null, units: [noisy] });
    platforms.push(platform);
    await platform.start();
    const entries = platform.unit('logger')!.commands.query({ levels: ['ERROR'] });
    expect(entries.map((e) => [e.subsystemId, e.message])).toContainEqual([
      'noisy',
      'the disk is full',
    ]);
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});
