# Examples: `@webkrnl/platform`

`createPlatform` boots a chosen set of WebKrnl subsystems with one call, and wires them together: the Queue router, the kernel persistence, the appearance settings, and the errors.

## Boot WebKrnl and use three subsystems

<!-- example id="platform/boot" runtime="any" -->

A notes app boots the default set with a catalog of messages. It reads the platform status, changes a setting, and translates a message with a plural.

```ts file=main.ts
import { createPlatform } from '@webkrnl/platform';

const platform = createPlatform({
  appName: `notes-${Date.now()}`,
  routes: null,
  translation: {
    catalogs: [
      {
        locale: 'en',
        namespace: 'common',
        messages: { notes: '{n, plural, one {# note} other {# notes}}' },
      },
    ],
    languages: () => ['en'],
    hosts: ['virtual'],
  },
});
await platform.start();

const statuses = Object.values(platform.kernel.statuses.getSnapshot());
console.log(
  'every subsystem ready:',
  statuses.every((s) => s.status === 'READY'),
);
console.log('platform:', platform.unit('global-state')!.views.state.getSnapshot().status);

await platform.unit('settings')!.commands.set('dataSaver', true);
console.log('data saver:', platform.unit('settings')!.commands.get('dataSaver'));

const i18n = platform.unit('translation')!;
await i18n.commands.ready();
console.log(i18n.commands.t('notes', { n: 3 }));
await platform.stop();
```

```text output
every subsystem ready: true
platform: IDLE
data saver: true
3 notes
```
