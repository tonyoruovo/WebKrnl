# Examples: `@platform/settings`

Settings keeps the preferences of the user and of the device. A change applies at once, reaches the other tabs of the site, and, for a `user` setting, goes to the server.

## Build a settings page

<!-- example id="settings/page" runtime="any" -->

The page shows every value, with the defaults. The user turns on the data saver and picks a font size that the app defined. A wrong value is refused, and nothing changes.

```ts file=main.ts
import { Kernel } from '@platform/core';
import { createConsent } from '@platform/consent';
import { SETTINGS_ID, createSettings, type SettingsControl } from '@platform/settings';

const kernel = new Kernel([
  createConsent(),
  createSettings({
    definitions: { 'editor.fontSize': { default: 14, validate: (v) => v === 12 || v === 14 || v === 16 } },
  }),
]);
await kernel.start();
const { commands, views } = kernel.unit<SettingsControl>(SETTINGS_ID).control!;

console.log('before:', JSON.stringify(views.values.getSnapshot()));
await commands.update({ dataSaver: true, 'editor.fontSize': 16 });
try {
  await commands.set('editor.fontSize', 15);
} catch (error) {
  console.log('refused:', (error as Error).message);
}
console.log('after:', JSON.stringify(views.values.getSnapshot()));
await kernel.stop();
```

```text output
before: {"syncInterval":300000,"bandwidthMode":"FULL","dataSaver":false,"locale":null,"editor.fontSize":14}
refused: The value of the setting "editor.fontSize" fails its check.
after: {"syncInterval":300000,"bandwidthMode":"FULL","dataSaver":true,"locale":null,"editor.fontSize":16}
```

## Save on the server, and roll back on failure

<!-- example id="settings/rollback" runtime="any" -->

The language is a `user` setting, so it goes to the server. The first save fails: the change applies at once, then rolls back, and `set` resolves with `false`. The second save works.

```ts file=main.ts
import { Kernel } from '@platform/core';
import { createConsent } from '@platform/consent';
import { SETTINGS_ID, createSettings, type SettingsControl } from '@platform/settings';

let online = false;
const kernel = new Kernel(
  [
    createConsent(),
    createSettings({
      handlers: {
        save: async (changes) => {
          if (!online) throw new Error('The server is offline.');
          console.log('server saved:', JSON.stringify(changes));
        },
      },
    }),
  ],
  { onError: (error) => console.log('reported:', (error as Error).message) },
);
await kernel.start();
const { commands } = kernel.unit<SettingsControl>(SETTINGS_ID).control!;

const first = commands.set('locale', 'fr-FR');
console.log('at once:', commands.get('locale'));
console.log('saved?', await first, '- locale:', commands.get('locale'));

online = true;
console.log('saved?', await commands.set('locale', 'fr-FR'), '- locale:', commands.get('locale'));
await kernel.stop();
```

```text output
at once: fr-FR
reported: The server is offline.
saved? false - locale: null
server saved: {"locale":"fr-FR"}
saved? true - locale: fr-FR
```
