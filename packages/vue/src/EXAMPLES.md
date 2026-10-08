# Examples: `@webkrnl/vue`

The Vue adapter turns WebKrnl views into refs, provides the platform to components, re-renders translations, and makes Page scope follow vue-router. These examples use a render function instead of a single-file component, so they run without a build step.

## Show the platform status and a translated greeting

<!-- example id="vue/status" runtime="any" -->

A component reads the status of the platform with `useView`, and a message with `useT`. When the user picks French, the same `t` gives the French message: the component renders again.

```ts file=main.ts
import { createPlatform } from '@webkrnl/platform';
import { createWebKrnl, usePlatform, useT, useUnit, useView } from '@webkrnl/vue';
import { createApp, effectScope } from 'vue';

const platform = createPlatform({
  appName: `vue-${Date.now()}`,
  routes: null,
  persistence: false,
  translation: {
    hosts: ['virtual'],
    supportedLocales: ['en', 'fr'],
    languages: () => ['en'],
    escapeParams: false, // Vue escapes text itself
    catalogs: [
      { locale: 'en', namespace: 'common', messages: { greeting: 'Hello, {name}!' } },
      { locale: 'fr', namespace: 'common', messages: { greeting: 'Bonjour, {name} !' } },
    ],
  },
});
const app = createApp({ render: () => null });
app.use(createWebKrnl(platform));
await platform.ready;
await platform.unit('translation')!.commands.ready();

// What a component's setup() does:
const scope = effectScope();
const { state, settings, t } = app.runWithContext(() =>
  scope.run(() => ({
    state: useView(usePlatform().unit('global-state')!.views.state),
    settings: useUnit('settings'),
    t: useT(),
  }))!,
);
console.log('status:', state.value.status);
console.log(t('greeting', { name: 'Ada' }));
await settings.value!.commands.set('locale', 'fr');
await platform.unit('translation')!.commands.ready();
console.log(t('greeting', { name: 'Ada' }));
scope.stop();
await platform.stop();
```

```text output
status: IDLE
Hello, Ada!
Bonjour, Ada !
```

## Register the plugin in an app

<!-- example id="vue/app" runtime="none" -->

The usual `main.ts` of a Vue app with vue-router. Page scope follows the router, so the platform gets `routes: null`. The scaffolder (`npm init @webkrnl`) writes this file.

```ts file=main.ts
import { createPlatform } from '@webkrnl/platform';
import { createWebKrnl } from '@webkrnl/vue';
import { createApp, defineComponent, h } from 'vue';
import { createRouter, createWebHistory, RouterView } from 'vue-router';

const platform = createPlatform({
  appName: 'shop',
  routes: null,
  translation: { escapeParams: false },
});
const router = createRouter({
  history: createWebHistory(),
  routes: [{ path: '/', component: defineComponent({ render: () => h('p', 'Home') }) }],
});
createApp(defineComponent({ render: () => h(RouterView) }))
  .use(router)
  .use(createWebKrnl(platform, { router }))
  .mount('#app');
```
