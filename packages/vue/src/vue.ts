/**
 * @fileoverview
 * @summary The Vue adapter of WebKrnl: views as refs, the platform in components, translations, and vue-router.
 * @description
 * Implements docs/ARCHITECTURE.md §14.1 and §22.3. Every WebKrnl view is an
 * external store (§6.1), so the adapter is small: it turns a view into a
 * `shallowRef`, provides the platform to components, and follows the router.
 * It adds no behaviour that the core lacks.
 *
 * ```text
 *   app.use(createWebKrnl(platform, { router }))  --> provide(platform), platform.start()
 *                                                     router.afterEach --> kernel.changePage(path)
 *   setup() {
 *     const state = useView(platform.unit('global-state')!.views.state)   Readonly<ShallowRef<...>>
 *     const settings = useUnit('settings')                                 ShallowRef<SettingsControl | undefined>
 *     const t = useT()                                                      renders again on a new catalog or locale
 *   }
 *   ```
 *
 * @example
 * A status bar
 * ```ts
 * const state = useView(usePlatform().unit('global-state')!.views.state);
 * // <span>{{ state.status }}</span>
 * ```
 *
 * @author MathAid
 */

import type { RouteSource, View } from '@webkrnl/core';
import type { Platform, PlatformControls } from '@webkrnl/platform';
import {
  getCurrentScope,
  inject,
  onScopeDispose,
  shallowRef,
  type App,
  type InjectionKey,
  type Plugin,
  type ShallowRef,
} from 'vue';
import type { Router } from 'vue-router';

/**
 * @summary The injection key of the platform.
 * @public
 */
export const WEBKRNL_KEY: InjectionKey<Platform> = Symbol('webkrnl');

/**
 * @summary Follows a view as a read-only `shallowRef`.
 *
 * @description
 * The ref holds the snapshot of the view, and changes when the view
 * notifies. Inside a component or an effect scope, it stops following when
 * the scope ends. Snapshots are immutable, so a `shallowRef` is enough.
 *
 * @example
 * Example 1: The online state
 * ```ts
 * const state = useView(platform.unit('global-state')!.views.state);
 * const online = computed(() => state.value.online);
 * ```
 *
 * @example
 * Example 2: The theme
 * ```ts
 * const theme = useView(platform.unit('design-system')!.views.theme);
 * ```
 *
 * @template T The snapshot.
 * @param {View<T>} view The view.
 * @returns {Readonly<ShallowRef<T>>} The ref.
 *
 * @public
 */
export function useView<T>(view: View<T>): Readonly<ShallowRef<T>> {
  const ref = shallowRef(view.getSnapshot());
  const stop = view.subscribe(() => (ref.value = view.getSnapshot()));
  if (getCurrentScope()) onScopeDispose(stop);
  return ref;
}

/**
 * @summary Returns the platform that `createWebKrnl` provided.
 *
 * @example
 * Example 1: In `setup`
 * ```ts
 * const platform = usePlatform();
 * ```
 *
 * @example
 * Example 2: A unit of the app
 * ```ts
 * usePlatform().unit<CartControl>('cart')?.commands.add(item);
 * ```
 *
 * @returns {Platform} The platform.
 * @throws {Error} Outside a component of an app that uses `createWebKrnl`.
 *
 * @public
 */
export function usePlatform(): Platform {
  const platform = inject(WEBKRNL_KEY, null);
  if (!platform) throw new Error('No WebKrnl platform: call app.use(createWebKrnl(platform)).');
  return platform;
}

/**
 * @summary Follows the control interface of a unit: `undefined` while it does not run.
 *
 * @example
 * Example 1: Settings
 * ```ts
 * const settings = useUnit('settings');
 * const save = () => settings.value?.commands.set('dataSaver', true);
 * ```
 *
 * @example
 * Example 2: A unit of the app
 * ```ts
 * const cart = useUnit<CartControl>('cart');
 * ```
 *
 * @template K The id, for a subsystem of the catalogue.
 * @param {K} id The id.
 * @param {Platform} [platform] The platform. The default is the provided one.
 * @returns {Readonly<ShallowRef<PlatformControls[K] | undefined>>} The ref.
 *
 * @public
 */
export function useUnit<K extends keyof PlatformControls>(
  id: K,
  platform?: Platform,
): Readonly<ShallowRef<PlatformControls[K] | undefined>>;
/**
 * @summary Follows the control interface of a unit of the app: `undefined` while it does not run.
 * @template C The control interface.
 * @param {string} id The id.
 * @param {Platform} [platform] The platform. The default is the provided one.
 * @returns {Readonly<ShallowRef<C | undefined>>} The ref.
 * @public
 */
export function useUnit<C>(id: string, platform?: Platform): Readonly<ShallowRef<C | undefined>>;
export function useUnit(id: string, platform: Platform = usePlatform()) {
  const statuses = platform.kernel.statuses;
  return useView({
    getSnapshot: () => platform.unit<unknown>(id),
    subscribe: (listener: () => void) => statuses.subscribe(listener),
  } as View<unknown>);
}

/** The part of Translation that `useT` reads. */
interface TranslationLike {
  readonly commands: {
    t(
      key: string,
      params?: Readonly<Record<string, unknown>>,
      options?: { namespace?: string },
    ): string;
  };
  readonly views: {
    readonly state: View<{ readonly revision?: number; readonly locale?: string }>;
  };
}

/**
 * @summary Returns `t` of Translation, bound to its state, so a template renders again on a new catalog or locale.
 *
 * @description
 * Before Translation runs, `t` returns the key. Vue escapes text itself, so
 * give Translation `escapeParams: false` in a Vue app.
 *
 * @example
 * Example 1: In a template
 * ```ts
 * const t = useT();
 * // <h1>{{ t('cart.title') }}</h1> <p>{{ t('cart.items', { count }) }}</p>
 * ```
 *
 * @example
 * Example 2: One namespace
 * ```ts
 * const t = useT({ namespace: 'checkout' });
 * ```
 *
 * @param {{ namespace?: string; platform?: Platform }} [options] A namespace, and the platform (the default is the provided one).
 * @returns {(key: string, params?: Readonly<Record<string, unknown>>) => string} The function.
 *
 * @public
 */
export function useT(
  options: { namespace?: string; platform?: Platform } = {},
): (key: string, params?: Readonly<Record<string, unknown>>) => string {
  const platform = options.platform ?? usePlatform();
  const unit = useUnit<TranslationLike>('translation', platform);
  const version = shallowRef(0);
  let followed: TranslationLike | undefined;
  let stop: (() => void) | undefined;
  // Follow the state of the running Translation; a restart gives a new control.
  const follow = () => {
    if (unit.value === followed) return;
    stop?.();
    followed = unit.value;
    stop = followed?.views.state.subscribe(() => version.value++);
    version.value++;
  };
  follow();
  const stopStatuses = platform.kernel.statuses.subscribe(follow);
  if (getCurrentScope()) {
    onScopeDispose(() => {
      stop?.();
      stopStatuses();
    });
  }
  return (key, params) => {
    void version.value; // the dependency that makes a template render again
    const translation = unit.value;
    return translation
      ? translation.commands.t(key, params, { namespace: options.namespace })
      : key;
  };
}

/**
 * @summary A route source that follows vue-router (`afterEach`), for a kernel without the platform.
 *
 * @example
 * Example 1: A kernel of your own
 * ```ts
 * new Kernel(units, { routes: createVueRouterRouteSource(router) });
 * ```
 *
 * @example
 * Example 2: The current path
 * ```ts
 * createVueRouterRouteSource(router).current(); // '/settings'
 * ```
 *
 * @param {Router} router The router.
 * @returns {RouteSource} The route source.
 *
 * @public
 */
export function createVueRouterRouteSource(router: Router): RouteSource {
  return {
    current: () => router.currentRoute.value.path,
    subscribe(listener) {
      return router.afterEach((to, from, failure) => {
        if (!failure && to.path !== from.path) listener(to.path);
      });
    },
  };
}

/**
 * @summary Options of {@linkcode createWebKrnl}.
 * @public
 */
export interface WebKrnlPluginOptions {
  /**
   * @summary The router. Page scope then follows its navigations.
   */
  readonly router?: Router;
  /**
   * @summary Starts the platform when the app uses the plugin. The default is `true`.
   */
  readonly start?: boolean;
}

/**
 * @summary The Vue plugin: provides the platform, starts it, and connects vue-router to Page scope.
 *
 * @example
 * Example 1: An app
 * ```ts
 * createApp(App).use(router).use(createWebKrnl(platform, { router })).mount('#app');
 * ```
 *
 * @example
 * Example 2: Waiting for the platform before mounting
 * ```ts
 * app.use(createWebKrnl(platform));
 * await platform.ready;
 * app.mount('#app');
 * ```
 *
 * @param {Platform} platform The platform (`createPlatform`).
 * @param {WebKrnlPluginOptions} [options] The router, and whether to start.
 * @returns {Plugin} The plugin.
 *
 * @public
 */
export function createWebKrnl(platform: Platform, options: WebKrnlPluginOptions = {}): Plugin {
  return {
    install(app: App) {
      app.provide(WEBKRNL_KEY, platform);
      if (options.start !== false) {
        void platform.start().catch((error: unknown) => console.error('[webkrnl]', error));
      }
      if (options.router) {
        const source = createVueRouterRouteSource(options.router);
        const stop = source.subscribe((path) => void platform.kernel.changePage(path));
        const unmount = app.unmount.bind(app);
        app.unmount = () => {
          stop();
          unmount();
        };
      }
    },
  };
}
