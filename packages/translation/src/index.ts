/**
 * @fileoverview
 * @module @platform/translation
 * @summary The public API of `@platform/translation`.
 * @description
 * Re-exports the Translation subsystem ({@linkcode createTranslation}), the
 * ICU MessageFormat parser and formatter, the locale rules, the processor
 * that compiles catalogs, and the types.
 *
 * ```text
 *   @platform/translation
 *   +-- createTranslation      the subsystem: id 'translation', featurized, Tab scope
 *   +-- parseMessage, formatMessage, createFormatContext, escapeHtml, MessageSyntaxError   the ICU subset
 *   +-- resolveLocaleChain, canonicalLocale, textDirection                              the locale rules
 *   +-- compileCatalog, createCompileProcessor                                          the processor 'compile'
 *   +-- LOCALE_CHANGED, MISSING_KEY, CATALOG_COLLECTION, MissingTranslationError
 *   +-- types                  TranslationControl, TranslationData, TranslationOptions, MessageCatalog, ...
 *   ```
 *
 * @example
 * Registering it
 * ```ts
 * import { createTranslation } from '@platform/translation';
 *
 * const kernel = new Kernel([...centralized, createTranslation({ supportedLocales: ['en', 'fr'], url: '/i18n/{locale}/{namespace}.json' })]);
 * ```
 *
 * @example
 * Formatting a message without the subsystem
 * ```ts
 * import { createFormatContext, formatMessage, parseMessage } from '@platform/translation';
 *
 * formatMessage(parseMessage('{n, plural, one {# day} other {# days}}'), { n: 2 }, createFormatContext('en'));
 * ```
 *
 * @author MathAid
 */

export * from './compile';
export * from './icu';
export * from './locale';
export * from './translation';
