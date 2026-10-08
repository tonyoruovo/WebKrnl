/**
 * @fileoverview
 * @summary The theme: appearance preferences, resolved with the device, turned into token values and a stylesheet.
 * @description
 * Implements the Theme Resolver and the Stylesheet Export of
 * `docs/proposals/design-system_PROPOSAL.md`. The preferences can say `system`;
 * the media queries of the device resolve them. The resolved theme picks the
 * modes of the token set, scales the font sizes, and stops motion.
 *
 * ```text
 *   preferences { colorScheme: 'system', contrast: 'system', density, fontScale, reducedMotion: 'system' }
 *     + media { dark, moreContrast, reducedMotion } + Translation { direction, lang }
 *     --> resolveTheme --> { colorScheme: 'dark', contrast: 'normal', density, fontScale, reducedMotion, direction, lang }
 *     --> themeValues(tokens, theme) --> { '--ds-color-surface': '#121316', ... }
 *
 *   renderThemeCss(tokens)  the same values as CSS, for the <head>: right on the first paint
 *   renderThemeScript()     sets the attributes of explicit preferences before the first paint
 *   ```
 *
 * @example
 * The values of a dark theme
 * ```ts
 * themeValues(DEFAULT_TOKENS, { ...DEFAULT_THEME, colorScheme: 'dark' })['--ds-color-surface']; // '#121316'
 * ```
 *
 * @author MathAid
 */

import type { SettingDefinition } from '@webkrnl/settings';

import { cssVar, type TokenSet } from './tokens';

/**
 * @summary The appearance preferences of the user, as Settings keeps them.
 *
 * @example
 * Example 1: The defaults
 * ```ts
 * // { colorScheme: 'system', contrast: 'system', density: 'comfortable', fontScale: 1, reducedMotion: 'system' }
 * ```
 *
 * @example
 * Example 2: A dark, large theme
 * ```ts
 * const preferences: AppearancePreferences = { ...DEFAULT_APPEARANCE, colorScheme: 'dark', fontScale: 1.25 };
 * ```
 *
 * @public
 */
export interface AppearancePreferences {
  /**
   * @summary The color scheme. `system` follows `prefers-color-scheme`.
   */
  readonly colorScheme: 'system' | 'light' | 'dark';
  /**
   * @summary The contrast. `system` follows `prefers-contrast`.
   */
  readonly contrast: 'system' | 'normal' | 'more';
  /**
   * @summary The space between and inside elements.
   */
  readonly density: 'compact' | 'comfortable' | 'spacious';
  /**
   * @summary The factor of the font sizes, from 0.875 to 1.5.
   */
  readonly fontScale: number;
  /**
   * @summary Motion. `system` follows `prefers-reduced-motion`.
   */
  readonly reducedMotion: 'system' | 'reduce' | 'no-preference';
}

/**
 * @summary The appearance preferences before the user changes them.
 * @public
 */
export const DEFAULT_APPEARANCE: AppearancePreferences = {
  colorScheme: 'system',
  contrast: 'system',
  density: 'comfortable',
  fontScale: 1,
  reducedMotion: 'system',
};

/**
 * @summary The Settings key of each appearance preference.
 *
 * @example
 * Reading one from Settings
 * ```ts
 * settings.commands.get(APPEARANCE_KEYS.colorScheme); // 'system'
 * ```
 *
 * @public
 */
export const APPEARANCE_KEYS: Readonly<Record<keyof AppearancePreferences, string>> = {
  colorScheme: 'appearance.colorScheme',
  contrast: 'appearance.contrast',
  density: 'appearance.density',
  fontScale: 'appearance.fontScale',
  reducedMotion: 'appearance.reducedMotion',
};

const oneOf =
  (...values: readonly unknown[]) =>
  (value: unknown) =>
    values.includes(value);

/** The checks of the preferences, shared by Settings and the subsystem. */
const CHECKS: Readonly<Record<keyof AppearancePreferences, (value: unknown) => boolean>> = {
  colorScheme: oneOf('system', 'light', 'dark'),
  contrast: oneOf('system', 'normal', 'more'),
  density: oneOf('compact', 'comfortable', 'spacious'),
  fontScale: (value) => typeof value === 'number' && value >= 0.875 && value <= 1.5,
  reducedMotion: oneOf('system', 'reduce', 'no-preference'),
};

/**
 * @summary Tells if a value is allowed for an appearance preference.
 *
 * @example
 * Example 1: A good value
 * ```ts
 * isAppearanceValue('density', 'compact'); // true
 * ```
 *
 * @example
 * Example 2: A font scale out of range
 * ```ts
 * isAppearanceValue('fontScale', 3); // false
 * ```
 *
 * @param {keyof AppearancePreferences} key The preference.
 * @param {unknown} value The value.
 * @returns {boolean} `true` when it is allowed.
 *
 * @public
 */
export function isAppearanceValue(key: keyof AppearancePreferences, value: unknown): boolean {
  return CHECKS[key]?.(value) ?? false;
}

/**
 * @summary The Settings definitions of the appearance preferences, for `createSettings({ definitions })`.
 *
 * @description
 * All are `device` settings: they stay after sign-out (ARCHITECTURE §5.1).
 *
 * @example
 * Registering them
 * ```ts
 * createSettings({ definitions: { ...APPEARANCE_SETTINGS } });
 * ```
 *
 * @public
 */
export const APPEARANCE_SETTINGS: Readonly<Record<string, SettingDefinition>> = Object.fromEntries(
  (Object.keys(APPEARANCE_KEYS) as (keyof AppearancePreferences)[]).map((key) => [
    APPEARANCE_KEYS[key],
    { default: DEFAULT_APPEARANCE[key], validate: CHECKS[key], kind: 'device' as const },
  ]),
);

/**
 * @summary What the device prefers: the results of the `prefers-*` media queries.
 * @public
 */
export interface DevicePreferences {
  /**
   * @summary `prefers-color-scheme: dark`.
   */
  readonly dark: boolean;
  /**
   * @summary `prefers-contrast: more`.
   */
  readonly moreContrast: boolean;
  /**
   * @summary `prefers-reduced-motion: reduce`.
   */
  readonly reducedMotion: boolean;
}

/**
 * @summary The theme that applies now.
 *
 * @example
 * Example 1: A dark theme in Arabic
 * ```ts
 * // { colorScheme: 'dark', contrast: 'normal', density: 'comfortable', fontScale: 1, reducedMotion: false, direction: 'rtl', lang: 'ar' }
 * ```
 *
 * @example
 * Example 2: Choosing an image
 * ```ts
 * logo.src = theme.colorScheme === 'dark' ? '/logo-light.svg' : '/logo.svg';
 * ```
 *
 * @public
 */
export interface ResolvedTheme {
  /**
   * @summary The color scheme, after `system` is resolved.
   */
  readonly colorScheme: 'light' | 'dark';
  /**
   * @summary The contrast, after `system` is resolved.
   */
  readonly contrast: 'normal' | 'more';
  /**
   * @summary The density.
   */
  readonly density: 'compact' | 'comfortable' | 'spacious';
  /**
   * @summary The factor of the font sizes.
   */
  readonly fontScale: number;
  /**
   * @summary Tells if motion stops, after `system` is resolved.
   */
  readonly reducedMotion: boolean;
  /**
   * @summary The text direction, from Translation. `ltr` without it.
   */
  readonly direction: 'ltr' | 'rtl';
  /**
   * @summary The language, from Translation. Empty without it.
   */
  readonly lang: string;
}

/**
 * @summary The theme without preferences, on a device without preferences.
 * @public
 */
export const DEFAULT_THEME: ResolvedTheme = {
  colorScheme: 'light',
  contrast: 'normal',
  density: 'comfortable',
  fontScale: 1,
  reducedMotion: false,
  direction: 'ltr',
  lang: '',
};

/**
 * @summary Resolves the preferences with the device and the locale.
 *
 * @example
 * Example 1: `system` on a dark device
 * ```ts
 * resolveTheme(DEFAULT_APPEARANCE, { dark: true, moreContrast: false, reducedMotion: false }).colorScheme; // 'dark'
 * ```
 *
 * @example
 * Example 2: The user chose light
 * ```ts
 * resolveTheme({ ...DEFAULT_APPEARANCE, colorScheme: 'light' }, { dark: true, moreContrast: false, reducedMotion: false }).colorScheme; // 'light'
 * ```
 *
 * @param {AppearancePreferences} preferences The preferences of the user.
 * @param {DevicePreferences} device The preferences of the device.
 * @param {{ direction?: 'ltr' | 'rtl'; lang?: string }} [locale] The direction and language from Translation.
 * @returns {ResolvedTheme} The theme.
 *
 * @public
 */
export function resolveTheme(
  preferences: AppearancePreferences,
  device: DevicePreferences,
  locale: { direction?: 'ltr' | 'rtl'; lang?: string } = {},
): ResolvedTheme {
  return {
    colorScheme:
      preferences.colorScheme === 'system'
        ? device.dark
          ? 'dark'
          : 'light'
        : preferences.colorScheme,
    contrast:
      preferences.contrast === 'system'
        ? device.moreContrast
          ? 'more'
          : 'normal'
        : preferences.contrast,
    density: preferences.density,
    fontScale: preferences.fontScale,
    reducedMotion:
      preferences.reducedMotion === 'system'
        ? device.reducedMotion
        : preferences.reducedMotion === 'reduce',
    direction: locale.direction ?? 'ltr',
    lang: locale.lang ?? '',
  };
}

/**
 * @summary Multiplies a CSS length (`1rem`, `14px`, `1.5em`) by a factor. Other values stay.
 * @param {string} value The value.
 * @param {number} factor The factor.
 * @returns {string} The scaled value.
 * @internal
 */
function scale(value: string, factor: number): string {
  if (factor === 1) return value;
  const match = /^(-?\d*\.?\d+)(rem|em|px)$/.exec(value.trim());
  if (!match) return value;
  return `${Number((Number(match[1]) * factor).toFixed(4))}${match[2]}`;
}

/**
 * @summary Returns the value of every token in a theme, by custom property.
 *
 * @description
 * Base values, then `dark` (dark scheme), then `contrast` (light, more
 * contrast) or `darkContrast` (dark, more contrast), then the density. Font
 * sizes (`font.size.*`) are multiplied by `fontScale`. With reduced motion,
 * durations (`motion.duration.*`) are `0ms`.
 *
 * @example
 * Example 1: Compact and large
 * ```ts
 * const values = themeValues(DEFAULT_TOKENS, { ...DEFAULT_THEME, density: 'compact', fontScale: 1.25 });
 * values['--ds-space-4']; // '0.75rem'
 * values['--ds-font-size-md']; // '1.25rem'
 * ```
 *
 * @example
 * Example 2: No motion
 * ```ts
 * themeValues(DEFAULT_TOKENS, { ...DEFAULT_THEME, reducedMotion: true })['--ds-motion-duration-normal']; // '0ms'
 * ```
 *
 * @param {TokenSet} tokens The token set.
 * @param {ResolvedTheme} theme The theme.
 * @returns {Record<string, string>} The values, by custom property.
 *
 * @public
 */
export function themeValues(tokens: TokenSet, theme: ResolvedTheme): Record<string, string> {
  const modes = tokens.modes ?? {};
  const dark = theme.colorScheme === 'dark';
  const merged: Record<string, string> = {
    ...tokens.base,
    ...(dark ? modes.dark : {}),
    ...(theme.contrast === 'more' ? (dark ? modes.darkContrast : modes.contrast) : {}),
    ...(theme.density === 'comfortable' ? {} : modes.density?.[theme.density]),
  };
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(merged)) {
    let resolved = value;
    if (name.startsWith('font.size.')) resolved = scale(value, theme.fontScale);
    if (theme.reducedMotion && name.startsWith('motion.duration.')) resolved = '0ms';
    out[cssVar(name)] = resolved;
  }
  return out;
}

/** CSS declarations of some token values. */
function declarations(values: Readonly<Record<string, string>> | undefined): string {
  return Object.entries(values ?? {})
    .map(([name, value]) => `${cssVar(name)}:${value};`)
    .join('');
}

/**
 * @summary Returns a stylesheet with the token values of every mode, for the `<head>`.
 *
 * @description
 * The base values apply to `:root`. Each mode applies when its attribute
 * says so (`data-color-scheme`, `data-contrast`, `data-density`,
 * `data-reduced-motion`), or, before an attribute is set, when the media
 * query of the device says so. The page then paints the right theme before
 * the platform starts. Font scaling needs the script or the subsystem.
 *
 * @example
 * Example 1: At build time
 * ```ts
 * writeFileSync('public/theme.css', renderThemeCss(DEFAULT_TOKENS));
 * ```
 *
 * @example
 * Example 2: Inline in a server-rendered page
 * ```ts
 * html = `<style>${renderThemeCss(tokens)}</style>${renderThemeScript()}` + html;
 * ```
 *
 * @param {TokenSet} tokens The token set.
 * @returns {string} The CSS.
 *
 * @public
 */
export function renderThemeCss(tokens: TokenSet): string {
  const modes = tokens.modes ?? {};
  const durations = Object.fromEntries(
    Object.keys(tokens.base)
      .filter((name) => name.startsWith('motion.duration.'))
      .map((name) => [name, '0ms']),
  );
  const notLight = ':root:not([data-color-scheme="light"])';
  const notNormal = ':not([data-contrast="normal"])';
  const rules = [
    `:root{color-scheme:light dark;${declarations(tokens.base)}}`,
    `@media (prefers-color-scheme:dark){${notLight}{${declarations(modes.dark)}}}`,
    `:root[data-color-scheme="dark"]{color-scheme:dark;${declarations(modes.dark)}}`,
    ':root[data-color-scheme="light"]{color-scheme:light}',
    `@media (prefers-contrast:more){:root:not([data-color-scheme="dark"])${notNormal}{${declarations(modes.contrast)}}}`,
    `@media (prefers-contrast:more) and (prefers-color-scheme:dark){${notLight}${notNormal}{${declarations(modes.darkContrast)}}}`,
    `:root[data-contrast="more"]:not([data-color-scheme="dark"]){${declarations(modes.contrast)}}`,
    `:root[data-contrast="more"][data-color-scheme="dark"]{${declarations(modes.darkContrast)}}`,
    `@media (prefers-color-scheme:dark) and (prefers-contrast:more){:root[data-contrast="more"]:not([data-color-scheme="light"]){${declarations(modes.darkContrast)}}}`,
    `:root[data-density="compact"]{${declarations(modes.density?.compact)}}`,
    `:root[data-density="spacious"]{${declarations(modes.density?.spacious)}}`,
    `@media (prefers-reduced-motion:reduce){:root:not([data-reduced-motion="false"]){${declarations(durations)}}}`,
    `:root[data-reduced-motion="true"]{${declarations(durations)}}`,
  ];
  return rules.filter((rule) => !rule.endsWith('{}') && !rule.endsWith('{}}')).join('\n');
}

/**
 * @summary The `localStorage` key where the Design System keeps the preferences for the head script.
 * @constant {'platform:theme'}
 * @public
 */
export const THEME_STORAGE_KEY = 'platform:theme';

/**
 * @summary Returns an inline script that applies the stored preferences before the first paint.
 *
 * @description
 * It reads the preferences that the Design System keeps in `localStorage`
 * ({@linkcode THEME_STORAGE_KEY}), and sets the attributes of the explicit
 * ones on `<html>`. `system` values stay with the media queries of the
 * stylesheet. With `tokens`, it also scales the font sizes. Put it in the
 * `<head>`, after the stylesheet.
 *
 * @example
 * Example 1: In an HTML template
 * ```ts
 * head += renderThemeScript(DEFAULT_TOKENS);
 * ```
 *
 * @example
 * Example 2: With a Content Security Policy nonce
 * ```ts
 * head += renderThemeScript(tokens, { nonce });
 * ```
 *
 * @param {TokenSet} [tokens] The token set, to scale the font sizes. Without it, sizes stay until the subsystem starts.
 * @param {{ nonce?: string }} [options] A CSP nonce for the script tag.
 * @returns {string} The `<script>` element.
 *
 * @public
 */
export function renderThemeScript(tokens?: TokenSet, options: { nonce?: string } = {}): string {
  const sizes = Object.fromEntries(
    Object.entries(tokens?.base ?? {})
      .filter(([name]) => name.startsWith('font.size.'))
      .map(([name, value]) => [cssVar(name), value]),
  );
  const body = `(function(){try{var p=JSON.parse(localStorage.getItem(${JSON.stringify(THEME_STORAGE_KEY)})||'{}'),r=document.documentElement,s=${JSON.stringify(sizes)};
if(p.colorScheme==='light'||p.colorScheme==='dark')r.setAttribute('data-color-scheme',p.colorScheme);
if(p.contrast==='normal'||p.contrast==='more')r.setAttribute('data-contrast',p.contrast);
if(p.density)r.setAttribute('data-density',p.density);
if(p.reducedMotion==='reduce'||p.reducedMotion==='no-preference')r.setAttribute('data-reduced-motion',p.reducedMotion==='reduce'?'true':'false');
if(typeof p.fontScale==='number'&&p.fontScale!==1)for(var k in s){var m=/^(-?\\d*\\.?\\d+)(rem|em|px)$/.exec(s[k]);if(m)r.style.setProperty(k,+(m[1]*p.fontScale).toFixed(4)+m[2]);}
}catch(e){}})();`;
  const nonce = options.nonce ? ` nonce="${options.nonce.replace(/"/g, '&quot;')}"` : '';
  return `<script${nonce}>${body}</script>`;
}
