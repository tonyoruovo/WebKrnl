# {{name}}

A WebKrnl app ({{template}} template), made with `npm init @webkrnl`.

```bash
npm install
npm run dev        # http://localhost:5173
npm test           # the generated tests
npm run build && npm run preview
```

- `src/platform.ts` boots WebKrnl: one `createPlatform` call. Turn subsystems on and off there.
- `mock-api.ts` is a small API for development (`/api/notes`). Replace it with your server.
- `public/i18n` has the catalogs of Translation, in ICU MessageFormat.
- `src/style.css` uses the design tokens (`--ds-*`) of the Design System.

Try it: add a note, set the browser offline (DevTools, Network, Offline), add another, then go online again. The changes wait in the Sync outbox and reach the server once.
