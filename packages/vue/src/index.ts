/**
 * @fileoverview
 * @module @webkrnl/vue
 * @summary The public API of `@webkrnl/vue`.
 * @description
 * Re-exports the Vue adapter: the plugin, the composables, and the
 * vue-router route source.
 *
 * ```text
 *   @webkrnl/vue
 *   +-- createWebKrnl               the plugin: provide, start, Page scope follows vue-router
 *   +-- useView, usePlatform, useUnit, useT
 *   +-- createVueRouterRouteSource  for a kernel without the platform
 *   +-- WEBKRNL_KEY
 *   ```
 *
 * @example
 * An app
 * ```ts
 * import { createWebKrnl } from '@webkrnl/vue';
 *
 * createApp(App).use(router).use(createWebKrnl(platform, { router })).mount('#app');
 * ```
 *
 * @example
 * A component
 * ```ts
 * import { useT, useView, usePlatform } from '@webkrnl/vue';
 *
 * const t = useT();
 * const state = useView(usePlatform().unit('global-state')!.views.state);
 * ```
 *
 * @author MathAid
 */

export * from './vue';
