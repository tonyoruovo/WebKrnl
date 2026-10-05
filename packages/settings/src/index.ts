/**
 * @fileoverview
 * @module @platform/settings
 * @summary The public API of `@platform/settings`.
 * @description
 * Re-exports the Settings subsystem ({@linkcode createSettings}), the
 * built-in settings, the merge rule between tabs, the optimistic update
 * primitive, and the types.
 *
 * ```text
 *   @platform/settings
 *   +-- createSettings        the subsystem: id 'settings', featurized, Window scope, requires Consent
 *   +-- BUILT_IN_SETTINGS     syncInterval, bandwidthMode, dataSaver, locale
 *   +-- optimisticUpdate      apply, commit, roll back on failure
 *   +-- SETTINGS_CHANGED, SETTINGS_SYNC, SETTINGS_STATE, mergeSettingRecords   sharing settings between tabs
 *   +-- types                 SettingsControl, SettingsData, SettingDefinition, SettingRecord, SettingValue, ...
 *   ```
 *
 * @example
 * Registering it
 * ```ts
 * import { createSettings } from '@platform/settings';
 *
 * const kernel = new Kernel([...centralized, createConsent(), createSettings()], { router: queue.router, persistence });
 * ```
 *
 * @example
 * Reading a value
 * ```ts
 * import type { SettingsControl } from '@platform/settings';
 *
 * kernel.unit<SettingsControl>('settings').control!.commands.get('dataSaver');
 * ```
 *
 * @author MathAid
 */

export * from './optimistic';
export * from './settings';
