/**
 * A fake server for Sync tests. PUT and DELETE /<entity>/<id> apply a change
 * once for each Idempotency-Key. Tests can make the next request for a path
 * fail with a status, or apply it and then drop the response.
 */
import type { Change, EntityDefinition, SyncTools } from '../src';

export interface FakeServer {
  /** How many times the server applied each idempotency key. */
  readonly applied: Map<string, number>;
  /** Every request, as `<METHOD> <path>`. */
  readonly requests: string[];
  /** The current data, by `<entity>/<id>`. */
  readonly data: Map<string, unknown>;
  /** Faults to inject, by path: a status, or 'drop' (apply, then fail the connection). */
  readonly faults: Map<string, Array<number | 'drop' | 'conflict'>>;
  /** The changes that a pull returns. */
  readonly feed: Array<{ entityId: string; op: 'upsert' | 'delete'; data?: unknown }>;
  readonly fetch: typeof fetch;
}

export function fakeServer(): FakeServer {
  const applied = new Map<string, number>();
  const requests: string[] = [];
  const data = new Map<string, unknown>();
  const faults = new Map<string, Array<number | 'drop' | 'conflict'>>();
  const feed: FakeServer['feed'] = [];
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const path = new URL(request.url).pathname;
    requests.push(`${request.method} ${path}`);
    if (path.endsWith('/changes')) {
      const since = Number(new URL(request.url).searchParams.get('since') || 0);
      return Response.json({ changes: feed.slice(since), cursor: String(feed.length) });
    }
    const fault = faults.get(path)?.shift();
    if (typeof fault === 'number') return new Response('fault', { status: fault });
    const key = request.headers.get('idempotency-key') ?? `${request.method} ${path}`;
    const record = path.slice(1);
    if (fault === 'conflict' && request.headers.get('x-force') !== '1') {
      return Response.json({ remote: true, title: 'server' }, { status: 409 });
    }
    if (!applied.has(key)) {
      // A repeated key is not applied again: that is what the key is for.
      if (request.method === 'DELETE') data.delete(record);
      else data.set(record, await request.json());
    }
    applied.set(key, (applied.get(key) ?? 0) + 1);
    if (fault === 'drop')
      throw new TypeError('connection reset after the server applied the change');
    return new Response(null, { status: 204 });
  }) as typeof globalThis.fetch;
  return { applied, requests, data, faults, feed, fetch };
}

/** A REST push for an entity: PUT or DELETE /<entity>/<id>, with the change id as the key. */
export function restPush<T>(entity: string): EntityDefinition<T>['push'] {
  return async (change: Change<T>, { network }: SyncTools) => {
    const response = await network.commands.request<T>({
      url: `https://api.test/${entity}/${change.entityId}`,
      method: change.op === 'delete' ? 'DELETE' : 'PUT',
      body: change.op === 'delete' ? undefined : change.data,
      idempotencyKey: change.id,
      headers: change.force ? { 'x-force': '1' } : {},
      allowErrorStatus: true,
    });
    if (response.status === 409) return { conflict: response.data };
    if (response.status >= 400)
      throw Object.assign(new Error(`status ${response.status}`), { status: response.status });
    return undefined;
  };
}

/** Sums the counts of the pending-work entries of Sync ("3 changes to todos waiting"). */
export function pendingCount(
  pending: ReadonlyArray<{ subsystemId: string; label: string | null }> | undefined,
): number {
  return (pending ?? [])
    .filter((w) => w.subsystemId === 'sync')
    .reduce((sum, w) => sum + Number(/^(\d+)/.exec(w.label ?? '')?.[1] ?? 0), 0);
}
