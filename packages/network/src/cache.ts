/**
 * @fileoverview
 * @summary The response cache of the Network: memory first, Storage when it runs.
 * @description
 * Entries are kept by method and full URL. The memory part is a small LRU.
 * When Storage runs, the Network gives the cache a collection
 * (`network.cache`), and entries are also kept there, so they survive a
 * reload (docs/ARCHITECTURE.md §19.1).
 *
 * ```text
 *   get(key)  memory hit --> entry
 *             memory miss --> collection.get(key) --> back into memory
 *   set(key)  memory (LRU, evicts the oldest) + collection.set(key)
 *   ```
 *
 * @example
 * Keeping a response
 * ```ts
 * const cache = new ResponseCache(200);
 * await cache.set('GET https://shop.example/api/me', { status: 200, headers: {}, data: me, etag: null, storedAt: now, expiresAt: now + 60_000 });
 * ```
 *
 * @author MathAid
 */

/**
 * @summary One cached response.
 * @example
 * Example 1: A fresh entry with an ETag
 * ```ts
 * // { status: 200, headers: { etag: '"v3"' }, data: [...], etag: '"v3"', storedAt: 1700000000000, expiresAt: 1700000060000 }
 * ```
 * @example
 * Example 2: Checking freshness
 * ```ts
 * const fresh = entry.expiresAt > Date.now();
 * ```
 * @public
 */
export interface CacheEntry {
  /**
   * @summary The HTTP status.
   */
  readonly status: number;
  /**
   * @summary The headers, with lower-case names.
   */
  readonly headers: Readonly<Record<string, string>>;
  /**
   * @summary The parsed body.
   */
  readonly data: unknown;
  /**
   * @summary The `ETag` of the response, or `null`.
   */
  readonly etag: string | null;
  /**
   * @summary When the entry was stored, in Unix milliseconds.
   */
  readonly storedAt: number;
  /**
   * @summary When the entry stops being fresh, in Unix milliseconds.
   */
  readonly expiresAt: number;
}

/**
 * @summary The part of a Storage collection that the cache uses.
 * @description The Network does not import `@platform/storage`. Any object with this shape works.
 * @public
 */
export interface CacheCollection {
  /**
   * @summary Reads an entry.
   * @example
   * Reading
   * ```ts
   * await collection.get(key);
   * ```
   * @param {string} key The key.
   * @returns {Promise<CacheEntry | undefined>} The entry, or `undefined`.
   */
  get(key: string): Promise<CacheEntry | undefined>;
  /**
   * @summary Writes an entry.
   * @example
   * Writing
   * ```ts
   * await collection.set(key, entry);
   * ```
   * @param {string} key The key.
   * @param {CacheEntry} value The entry.
   * @returns {Promise<void>} Resolves when the entry is stored.
   */
  set(key: string, value: CacheEntry): Promise<void>;
  /**
   * @summary Deletes an entry.
   * @example
   * Deleting
   * ```ts
   * await collection.delete(key);
   * ```
   * @param {string} key The key.
   * @returns {Promise<void>} Resolves when the entry is deleted.
   */
  delete(key: string): Promise<void>;
  /**
   * @summary Returns all keys.
   * @example
   * Listing
   * ```ts
   * await collection.keys();
   * ```
   * @returns {Promise<string[]>} The keys.
   */
  keys(): Promise<string[]>;
}

/**
 * @summary The response cache: an LRU in memory, and a Storage collection when one is bound.
 * @example
 * Example 1: Memory only
 * ```ts
 * const cache = new ResponseCache(100);
 * ```
 * @example
 * Example 2: With Storage
 * ```ts
 * cache.bind(storage.commands.collection({ name: 'network.cache', maxEntries: 500 }));
 * ```
 * @public
 */
export class ResponseCache {
  readonly #entries = new Map<string, CacheEntry>();
  #collection: CacheCollection | null = null;

  /**
   * @summary Makes a cache.
   * @param {number} capacity The largest number of entries in memory.
   */
  constructor(
    /**
     * @summary The largest number of entries in memory.
     */
    readonly capacity: number,
  ) {}

  /**
   * @summary Binds a Storage collection, or unbinds it with `null`.
   * @example
   * Binding when Storage starts
   * ```ts
   * cache.bind(collection);
   * ```
   * @param {CacheCollection | null} collection The collection.
   * @returns {void}
   */
  bind(collection: CacheCollection | null): void {
    this.#collection = collection;
  }

  /**
   * @summary Returns the key of a request.
   * @example
   * A key
   * ```ts
   * ResponseCache.key('GET', 'https://shop.example/api/me'); // 'GET https://shop.example/api/me'
   * ```
   * @param {string} method The method.
   * @param {string} url The full URL.
   * @returns {string} The key.
   */
  static key(method: string, url: string): string {
    return `${method} ${url}`;
  }

  /**
   * @summary Reads an entry, fresh or not.
   * @example
   * Reading
   * ```ts
   * const entry = await cache.get(key);
   * ```
   * @param {string} key The key.
   * @returns {Promise<CacheEntry | undefined>} The entry, or `undefined`.
   */
  async get(key: string): Promise<CacheEntry | undefined> {
    const hit = this.#entries.get(key);
    if (hit) {
      // Most recently used goes last.
      this.#entries.delete(key);
      this.#entries.set(key, hit);
      return hit;
    }
    const stored = await this.#collection?.get(key).catch(() => undefined);
    if (stored) this.#remember(key, stored);
    return stored;
  }

  /**
   * @summary Writes an entry in memory and, when bound, in Storage.
   * @example
   * Writing
   * ```ts
   * await cache.set(key, entry);
   * ```
   * @param {string} key The key.
   * @param {CacheEntry} entry The entry.
   * @returns {Promise<void>} Resolves when the entry is stored.
   */
  async set(key: string, entry: CacheEntry): Promise<void> {
    this.#remember(key, entry);
    await this.#collection?.set(key, entry).catch(() => undefined);
  }

  /**
   * @summary Deletes the entries whose URL starts with a prefix, or all entries.
   * @example
   * Deleting one API
   * ```ts
   * await cache.invalidate('https://shop.example/api/orders');
   * ```
   * @param {string} [prefix] The prefix of the full URL.
   * @returns {Promise<number>} The number of entries deleted from memory.
   */
  async invalidate(prefix?: string): Promise<number> {
    const matches = (key: string) =>
      prefix === undefined || key.slice(key.indexOf(' ') + 1).startsWith(prefix);
    let removed = 0;
    for (const key of [...this.#entries.keys()]) {
      if (!matches(key)) continue;
      this.#entries.delete(key);
      removed++;
    }
    const collection = this.#collection;
    if (collection) {
      const keys = await collection.keys().catch(() => [] as string[]);
      for (const key of keys) if (matches(key)) await collection.delete(key).catch(() => undefined);
    }
    return removed;
  }

  #remember(key: string, entry: CacheEntry) {
    this.#entries.delete(key);
    this.#entries.set(key, entry);
    while (this.#entries.size > this.capacity) {
      this.#entries.delete(this.#entries.keys().next().value!);
    }
  }
}
