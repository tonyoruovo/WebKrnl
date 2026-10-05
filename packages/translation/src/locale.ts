/**
 * @fileoverview
 * @summary Locale resolution: the chain of locales to look a key up in, and the text direction.
 * @description
 * Implements the locale rules of docs/ARCHITECTURE.md §21.2. The preferred
 * locales (the setting, then the device) are matched against the supported
 * locales. The chain is the chosen locale, its parents, then the default
 * locale and its parents, each only when it is supported.
 *
 * ```text
 *   preferred ['fr-CA', 'en'], supported ['en', 'fr', 'fr-CA'], default 'en'
 *     --> chosen 'fr-CA' --> chain ['fr-CA', 'fr', 'en']
 *   preferred ['pt-BR'], supported ['en', 'pt'], default 'en'
 *     --> no exact match; same language 'pt' --> chain ['pt', 'en']
 *   ```
 *
 * @example
 * The chain of a Canadian French user
 * ```ts
 * resolveLocaleChain(['fr-CA'], ['en', 'fr', 'fr-CA'], 'en'); // ['fr-CA', 'fr', 'en']
 * ```
 *
 * @author MathAid
 */

/** Languages that are written right to left, when `Intl.Locale` cannot say. */
const RTL_LANGUAGES = new Set([
  'ar',
  'arc',
  'ckb',
  'dv',
  'fa',
  'he',
  'ks',
  'ku',
  'ps',
  'sd',
  'syr',
  'ug',
  'ur',
  'yi',
]);

/**
 * @summary Returns the canonical form of a BCP 47 tag, or `null` when it is not valid.
 *
 * @example
 * Example 1: Case
 * ```ts
 * canonicalLocale('EN-us'); // 'en-US'
 * ```
 *
 * @example
 * Example 2: Not a tag
 * ```ts
 * canonicalLocale('not a tag'); // null
 * ```
 *
 * @param {string | null | undefined} tag The tag.
 * @returns {string | null} The canonical tag.
 *
 * @public
 */
export function canonicalLocale(tag: string | null | undefined): string | null {
  if (typeof tag !== 'string' || tag === '') return null;
  try {
    return Intl.getCanonicalLocales(tag)[0] ?? null;
  } catch {
    return null;
  }
}

/**
 * @summary Returns the parents of a locale, the locale first: `zh-Hant-TW`, `zh-Hant`, `zh`.
 * @param {string} locale A canonical tag.
 * @returns {string[]} The locale and its parents.
 * @internal
 */
function lineage(locale: string): string[] {
  const parts = locale.split('-');
  const out: string[] = [];
  for (let n = parts.length; n > 0; n--) out.push(parts.slice(0, n).join('-'));
  return out;
}

/**
 * @summary Chooses a locale and makes the chain to look keys up in.
 *
 * @description
 * The first preferred locale with a supported match wins. A match is the
 * locale itself, then one of its parents, then a supported locale of the
 * same language. The chain is the chosen locale and its supported parents,
 * then `fallback` and its supported parents, without repeats. `fallback` is
 * always in the chain.
 *
 * @example
 * Example 1: An exact match
 * ```ts
 * resolveLocaleChain(['de-AT'], ['en', 'de', 'de-AT'], 'en'); // ['de-AT', 'de', 'en']
 * ```
 *
 * @example
 * Example 2: Nothing matches
 * ```ts
 * resolveLocaleChain(['ja'], ['en', 'fr'], 'en'); // ['en']
 * ```
 *
 * @param {readonly (string | null | undefined)[]} preferred The preferred locales, best first.
 * @param {readonly string[]} supported The locales the app has catalogs for.
 * @param {string} fallback The default locale.
 * @returns {string[]} The chain, the chosen locale first.
 *
 * @public
 */
export function resolveLocaleChain(
  preferred: readonly (string | null | undefined)[],
  supported: readonly string[],
  fallback: string,
): string[] {
  const known = new Set(supported.map(canonicalLocale).filter((t): t is string => t !== null));
  const defaultLocale = canonicalLocale(fallback) ?? 'en';
  known.add(defaultLocale);
  let chosen: string | null = null;
  for (const tag of preferred) {
    const locale = canonicalLocale(tag);
    if (!locale) continue;
    chosen = lineage(locale).find((candidate) => known.has(candidate)) ?? null;
    if (!chosen) {
      const language = locale.split('-')[0]!;
      chosen = [...known].find((candidate) => candidate.split('-')[0] === language) ?? null;
    }
    if (chosen) break;
  }
  const chain: string[] = [];
  for (const locale of [...lineage(chosen ?? defaultLocale), ...lineage(defaultLocale)]) {
    if (known.has(locale) && !chain.includes(locale)) chain.push(locale);
  }
  return chain;
}

/**
 * @summary Returns the direction of the text of a locale.
 *
 * @description
 * Uses the text info of `Intl.Locale` where the browser has it, and a list of
 * right-to-left languages where it does not.
 *
 * @example
 * Example 1: Arabic
 * ```ts
 * textDirection('ar-EG'); // 'rtl'
 * ```
 *
 * @example
 * Example 2: English
 * ```ts
 * textDirection('en'); // 'ltr'
 * ```
 *
 * @param {string} locale The locale.
 * @returns {'ltr' | 'rtl'} The direction.
 *
 * @public
 */
export function textDirection(locale: string): 'ltr' | 'rtl' {
  try {
    const info = new Intl.Locale(locale) as Intl.Locale & {
      getTextInfo?: () => { direction?: string };
      textInfo?: { direction?: string };
    };
    const direction = (info.getTextInfo?.() ?? info.textInfo)?.direction;
    if (direction === 'rtl' || direction === 'ltr') return direction;
  } catch {
    // Not a valid tag: use the list.
  }
  return RTL_LANGUAGES.has(locale.split('-')[0]!.toLowerCase()) ? 'rtl' : 'ltr';
}
