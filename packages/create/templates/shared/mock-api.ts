/**
 * A small API for development and the tests of this app: PUT and DELETE
 * /api/notes/<id>, GET /api/notes. Replace it with your server.
 */
import type { Connect, Plugin } from 'vite';

export function mockApi(): Plugin {
  const notes = new Map<string, unknown>();
  const handle: Connect.NextHandleFunction = (request, response, next) => {
    const url = request.url ?? '';
    if (!url.startsWith('/api/notes')) return next();
    let body = '';
    request.on('data', (chunk) => (body += chunk));
    request.on('end', () => {
      const id = decodeURIComponent(url.slice('/api/notes/'.length));
      if (request.method === 'PUT') notes.set(id, body ? JSON.parse(body) : null);
      if (request.method === 'DELETE') notes.delete(id);
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify(request.method === 'GET' ? [...notes.keys()] : { ok: true }));
    });
  };
  return {
    name: 'mock-api',
    configureServer: (server) => void server.middlewares.use(handle),
    configurePreviewServer: (server) => void server.middlewares.use(handle),
  };
}
