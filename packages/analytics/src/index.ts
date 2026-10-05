/**
 * @fileoverview
 * @module @platform/analytics
 * @summary The public API of `@platform/analytics`.
 * @description
 * Re-exports the Analytics subsystem ({@linkcode createAnalytics}), the
 * histogram summary, and the types.
 *
 * ```text
 *   @platform/analytics
 *   +-- createAnalytics     the subsystem: id 'analytics', featurized, Tab scope, requires Consent
 *   +-- summarize           count, sum, min, max, p50, p90, p99
 *   +-- ANALYTICS_ID, ANALYTICS_OUTBOX
 *   +-- types               AnalyticsControl, AnalyticsData, AnalyticsBatch, AnalyticsEvent, AnalyticsOptions, HistogramSummary
 *   ```
 *
 * @example
 * Registering it
 * ```ts
 * import { createAnalytics } from '@platform/analytics';
 *
 * const kernel = new Kernel([...centralized, createConsent(), createNetwork(), createAnalytics({ endpoint: '/t/batch' })]);
 * ```
 *
 * @example
 * Recording
 * ```ts
 * kernel.unit<AnalyticsControl>('analytics').control!.commands.track('search', { results: 12 });
 * ```
 *
 * @author MathAid
 */

export * from './analytics';
