# Examples: `@webkrnl/design-system`

The Design System turns design tokens and appearance preferences into CSS custom properties (`--ds-*`) and attributes on the root element. These examples give it a small fake root and fake media queries, so they run in every sandbox. In a page, the root is `<html>` and the media queries are real.

## Switch to dark mode and a larger font

<!-- example id="design-system/appearance" runtime="any" -->

The device prefers dark colors, and the preference `colorScheme` is `system`, so the theme is dark. The user then picks light colors and a larger font. Only the properties that change are written again.

```ts file=main.ts
import { Kernel } from '@webkrnl/core';
import { DESIGN_SYSTEM_ID, createDesignSystem, type DesignSystemControl, type ThemeRoot } from '@webkrnl/design-system';

const properties = new Map<string, string>();
const attributes = new Map<string, string>();
const root: ThemeRoot = {
  style: { setProperty: (name, value) => void properties.set(name, value) },
  setAttribute: (name, value) => void attributes.set(name, value),
  removeAttribute: (name) => void attributes.delete(name),
};
const darkDevice = (query: string) => ({
  matches: query === '(prefers-color-scheme: dark)',
  addEventListener() {},
  removeEventListener() {},
});

const kernel = new Kernel([createDesignSystem({ root, matchMedia: darkDevice, storage: null, schedule: (write) => write() })]);
await kernel.start();
const { commands, views } = kernel.unit<DesignSystemControl>(DESIGN_SYSTEM_ID).control!;
const show = () =>
  console.log(
    `${attributes.get('data-color-scheme')}: surface ${properties.get('--ds-color-surface')}, text ${properties.get('--ds-font-size-md')}`,
  );

show();
await commands.setAppearance({ colorScheme: 'light', fontScale: 1.25 });
show();
console.log('token for a style:', commands.token('color.primary'));
console.log('theme:', JSON.stringify(views.theme.getSnapshot()));
await kernel.stop();
```

```text output
dark: surface #121316, text 1rem
light: surface #ffffff, text 1.25rem
token for a style: var(--ds-color-primary)
theme: {"colorScheme":"light","contrast":"normal","density":"comfortable","fontScale":1.25,"reducedMotion":false,"direction":"ltr","lang":""}
```

## Paint the right theme before the platform starts

<!-- example id="design-system/head" runtime="any" -->

A server renders the stylesheet and the small script into the `<head>`. The stylesheet has every mode, so the first paint already follows the device and the stored preferences. Check your brand colors with `contrastRatio` before you ship them.

```ts file=main.ts
import { DEFAULT_TOKENS, contrastRatio, renderThemeCss, renderThemeScript, type TokenSet } from '@webkrnl/design-system';

const brand: TokenSet = {
  ...DEFAULT_TOKENS,
  base: { ...DEFAULT_TOKENS.base, 'color.primary': '#6d28d9' },
};
const ratio = contrastRatio(brand.base['color.on-primary']!, brand.base['color.primary']!);
console.log('white on the brand color:', ratio.toFixed(2), ratio >= 4.5 ? '(AA)' : '(too low)');

const css = renderThemeCss(brand);
const head = `<style>${css}</style>${renderThemeScript(brand, { nonce: 'r4nd0m' })}`;
console.log('rules:', css.split('\n').length);
console.log('first rule starts:', css.slice(0, 48));
console.log('script has the nonce:', head.includes('<script nonce="r4nd0m">'));
```

```text output
white on the brand color: 7.10 (AA)
rules: 13
first rule starts: :root{color-scheme:light dark;--ds-color-surface
script has the nonce: true
```
