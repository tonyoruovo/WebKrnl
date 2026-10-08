/**
 * The WebKrnl platform of {{name}}: one createPlatform call. Turn subsystems
 * on and off here; see the README of @webkrnl/platform for every option.
 */
import { createPlatform, type Platform, type PlatformOptions } from '@webkrnl/platform';

export interface Note {
  readonly text: string;
}

export function createAppPlatform(overrides: PlatformOptions = {}): Platform {
  return createPlatform({
    appName: '{{name}}',
    routes: null, // Page scope follows vue-router (src/main.ts)
    translation: {
      supportedLocales: ['en', 'fr'],
      url: '/i18n/{locale}/{namespace}.json',
      escapeParams: false, // Vue escapes text itself
    },
    sync: { intervalMs: false },
    // hub: { hubUrl: 'https://example.com/__platform/hub.html' }, // a site on subdomains
    // auth: { handlers }, realtime: { url }, analytics: { endpoint } // on demand
    ...overrides,
  });
}

/** The notes of the app: kept in the Sync outbox while offline, sent to /api/notes when online. */
export function notes(platform: Platform) {
  return platform.unit('sync')!.commands.entity<Note>({
    name: 'notes',
    push: async (change, { network }) => {
      const response = await network.commands.request({
        url: `/api/notes/${encodeURIComponent(change.entityId)}`,
        method: change.op === 'delete' ? 'DELETE' : 'PUT',
        body: change.data ?? undefined,
        idempotencyKey: change.id,
        allowErrorStatus: true,
      });
      if (response.status >= 400) {
        throw Object.assign(new Error(`The server answered ${response.status}.`), {
          status: response.status,
        });
      }
    },
  });
}
