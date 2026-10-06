/**
 * The Vue adapter (docs/ARCHITECTURE.md §22.3), in Node: composables in an
 * effect scope, the plugin without mounting, and vue-router with a memory
 * history.
 */
import type { SubsystemDefinition, View } from '@webkrnl/core';
import { createPlatform, type Platform } from '@webkrnl/platform';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp, effectScope, nextTick } from 'vue';
import { createMemoryHistory, createRouter } from 'vue-router';

import {
  createVueRouterRouteSource,
  createWebKrnl,
  usePlatform,
  useT,
  useUnit,
  useView,
} from '../src';

const platforms: Platform[] = [];
afterEach(async () => {
  for (const platform of platforms.splice(0)) await platform.stop();
});

function platformWith(units: SubsystemDefinition[] = []) {
  const platform = createPlatform({
    appName: `vue-${Date.now()}`,
    routes: null,
    persistence: false,
    onError: () => {},
    translation: {
      hosts: ['virtual'],
      supportedLocales: ['en', 'fr'],
      languages: () => ['en'],
      escapeParams: false,
      catalogs: [
        { locale: 'en', namespace: 'common', messages: { hi: 'Hi, {name}!' } },
        { locale: 'fr', namespace: 'common', messages: { hi: 'Salut, {name} !' } },
      ],
    },
    units,
  });
  platforms.push(platform);
  return platform;
}

describe('useView', () => {
  it('follows a view, and stops when the scope ends', async () => {
    let value = 1;
    const listeners = new Set<() => void>();
    const view: View<number> = {
      getSnapshot: () => value,
      subscribe: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    };
    const scope = effectScope();
    const ref = scope.run(() => useView(view))!;
    expect(ref.value).toBe(1);
    value = 2;
    listeners.forEach((l) => l());
    expect(ref.value).toBe(2);
    scope.stop();
    expect(listeners.size).toBe(0);
  });
});

describe('createWebKrnl', () => {
  it('provides and starts the platform; useUnit and useT follow it', async () => {
    const platform = platformWith();
    const app = createApp({ render: () => null });
    app.use(createWebKrnl(platform));
    await platform.ready;

    const scope = effectScope();
    const { settings, t, injected } = app.runWithContext(() =>
      scope.run(() => ({ injected: usePlatform(), settings: useUnit('settings'), t: useT() }))!,
    );
    expect(injected).toBe(platform);
    expect(settings.value).toBeDefined();
    await platform.unit('translation')!.commands.ready();
    expect(t('hi', { name: '<Ada>' })).toBe('Hi, <Ada>!'); // Vue escapes; Translation does not

    await settings.value!.commands.set('locale', 'fr');
    await vi.waitFor(() => expect(t('hi', { name: 'Ada' })).toBe('Salut, Ada !'));
    scope.stop();
  });

  it('throws outside an app that uses the plugin', () => {
    expect(() => effectScope().run(() => usePlatform())).toThrow('No WebKrnl platform');
  });

  it('makes Page scope follow vue-router', async () => {
    const inits: string[] = [];
    const page: SubsystemDefinition = {
      id: 'page-view',
      scope: 'page',
      kind: 'featurized',
      state: { initial: {} },
      init: () => void inits.push('init'),
      control: () => ({ commands: {}, views: {} }),
    };
    const platform = platformWith([page]);
    const router = createRouter({
      history: createMemoryHistory(),
      routes: [
        { path: '/', component: { render: () => null } },
        { path: '/settings', component: { render: () => null } },
      ],
    });
    const app = createApp({ render: () => null });
    app.use(router).use(createWebKrnl(platform, { router }));
    await router.push('/');
    await platform.ready;
    expect(inits).toEqual(['init']);

    await router.push('/settings');
    await vi.waitFor(() => expect(inits).toEqual(['init', 'init']));
    expect(createVueRouterRouteSource(router).current()).toBe('/settings');
    await nextTick();
  });
});
