# Examples: `@webkrnl/translation`

Translation gives localized messages in ICU MessageFormat and locale-aware formatting. `t()` is synchronous; catalogs load before, in the background. In an app, a dedicated worker compiles the catalogs. These examples compile them on the main thread (`hosts: ['virtual']`), so they run in every sandbox.

## Translate with plurals and a fallback chain

<!-- example id="translation/chain" runtime="any" -->

The device prefers Canadian French. The app has catalogs for French, Canadian French and English. A key comes from the first locale of the chain that has it, and plurals follow the rules of that locale.

```ts file=main.ts
import { Kernel } from '@webkrnl/core';
import { TRANSLATION_ID, createTranslation, type TranslationControl } from '@webkrnl/translation';

const kernel = new Kernel([
  createTranslation({
    hosts: ['virtual'],
    supportedLocales: ['en', 'fr', 'fr-CA'],
    languages: () => ['fr-CA', 'en'],
    catalogs: [
      { locale: 'en', namespace: 'common', messages: { cart: '{count, plural, one {# item} other {# items}}', help: 'Help' } },
      { locale: 'fr', namespace: 'common', messages: { cart: '{count, plural, one {# article} other {# articles}}' } },
      { locale: 'fr-CA', namespace: 'common', messages: { hello: 'Allô, {name}!' } },
    ],
  }),
]);
await kernel.start();
const { commands, views } = kernel.unit<TranslationControl>(TRANSLATION_ID).control!;
await commands.ready();

console.log('chain:', views.state.getSnapshot().chain?.join(' > '));
console.log(commands.t('hello', { name: 'Zoé' })); // fr-CA
console.log(commands.t('cart', { count: 0 }), '/', commands.t('cart', { count: 2 })); // fr: 0 is singular
console.log(commands.t('help')); // en
console.log(commands.t('missing.key')); // the key
await kernel.stop();
```

```text output
chain: fr-CA > fr > en
Allô, Zoé!
0 article / 2 articles
Help
missing.key
```

## Switch the locale and format for it

<!-- example id="translation/format" runtime="any" -->

A language menu switches to Arabic. The direction changes to right to left, and numbers, money, dates and lists follow the new locale.

```ts file=main.ts
import { Kernel } from '@webkrnl/core';
import { TRANSLATION_ID, createTranslation, type TranslationControl } from '@webkrnl/translation';

const kernel = new Kernel([
  createTranslation({ hosts: ['virtual'], supportedLocales: ['en', 'ar'], languages: () => ['en'] }),
]);
await kernel.start();
const { commands, views } = kernel.unit<TranslationControl>(TRANSLATION_ID).control!;
const show = () => {
  const { locale, direction } = views.state.getSnapshot();
  console.log(`${locale} (${direction}):`, commands.formatNumber(1234.5), '|', commands.formatCurrency(9.99, 'EUR'));
  console.log('  ', commands.formatDate(Date.UTC(2026, 9, 5), { dateStyle: 'long', timeZone: 'UTC' }), '|', commands.formatList(['A', 'B', 'C']));
};

show();
await commands.setLocale('ar');
show();
await kernel.stop();
```

```text output
en (ltr): 1,234.5 | €9.99
   October 5, 2026 | A, B, and C
ar (rtl): 1,234.5 | ‏9.99 €
   5 أكتوبر 2026 | A وB وC
```

## Load a namespace when a page opens

<!-- example id="translation/namespaces" runtime="any" -->

Only `common` loads at start. The checkout page loads its own namespace with a loader of the app (here a function; in an app, a dynamic `import()`), and frees it when it closes.

```ts file=main.ts
import { Kernel } from '@webkrnl/core';
import { TRANSLATION_ID, createTranslation, type TranslationControl } from '@webkrnl/translation';

const files: Record<string, Record<string, string>> = {
  'en/common': { title: 'Shop' },
  'en/checkout': { pay: 'Pay {amount, number, ::currency/USD}' },
};
const kernel = new Kernel([
  createTranslation({
    hosts: ['virtual'],
    languages: () => ['en'],
    load: async (locale, namespace) => {
      console.log(`loading ${locale}/${namespace}`);
      const messages = files[`${locale}/${namespace}`];
      return messages ? { messages } : null;
    },
  }),
]);
await kernel.start();
const { commands, views } = kernel.unit<TranslationControl>(TRANSLATION_ID).control!;

console.log(commands.t('title'), '|', commands.t('pay', { amount: 25 }));
await commands.loadNamespace('checkout');
console.log(commands.t('title'), '|', commands.t('pay', { amount: 25 }));
commands.unloadNamespace('checkout');
console.log('namespaces:', views.state.getSnapshot().namespaces?.join(', '));
await kernel.stop();
```

```text output
loading en/common
Shop | pay
loading en/checkout
Shop | Pay $25.00
namespaces: common
```
