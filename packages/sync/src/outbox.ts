/**
 * @fileoverview
 * @summary The outbox of Sync: the changes that wait for the server, in memory and in Storage.
 * @description
 * The outbox keeps every change until the server confirms it. When Storage
 * runs, it is the collection `sync.outbox.<name>`, shared by every tab of the
 * origin. A new change merges with a waiting change of the same entity, but
 * only when that change was never sent (docs/ARCHITECTURE.md §19.3).
 *
 * ```text
 *   waiting    + new        = result        (only when the waiting change has 0 attempts)
 *   create     + update     = create (new data)
 *   create     + delete     = nothing (the server never saw it)
 *   update     + delete     = delete
 *   delete     + create     = update
 *   ```
 *
 * Every operation of the outbox runs in one queue, so a reload never drops a
 * change that was written while it read the collection.
 *
 * @example
 * Merging two changes
 * ```ts
 * mergeOps('create', 'update'); // 'create'
 * mergeOps('create', 'delete'); // null
 * ```
 *
 * @author MathAid
 */

import type { Change, ChangeOp } from './types';

/**
 * @summary Returns the kind of change that two waiting changes of one entity become, or `null` when they cancel.
 * @example
 * Example 1: An update after a create
 * ```ts
 * mergeOps('create', 'update'); // 'create'
 * ```
 * @example
 * Example 2: A delete after a create
 * ```ts
 * mergeOps('create', 'delete'); // null
 * ```
 * @param {ChangeOp} previous The waiting change.
 * @param {ChangeOp} next The new change.
 * @returns {ChangeOp | null} The merged kind, or `null`.
 * @public
 */
export function mergeOps(previous: ChangeOp, next: ChangeOp): ChangeOp | null {
  if (previous === 'create') return next === 'delete' ? null : 'create';
  if (previous === 'update') return next === 'delete' ? 'delete' : 'update';
  return next === 'delete' ? 'delete' : 'update';
}

/**
 * @summary Sorts changes in the order that they were made.
 * @example
 * Sorting
 * ```ts
 * changes.sort(byOrder);
 * ```
 * @param {Change} a A change.
 * @param {Change} b Another change.
 * @returns {number} A negative number when `a` comes first.
 * @public
 */
export function byOrder(a: Change, b: Change): number {
  return a.createdAt - b.createdAt || a.seq - b.seq || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

/**
 * @summary The part of a Storage collection that the outbox uses.
 * @description Sync does not import `@webkrnl/storage`. Any object with this shape works.
 * @public
 */
export interface OutboxStore {
  /**
   * @summary Returns every change.
   * @example
   * Reading
   * ```ts
   * await store.entries();
   * ```
   * @returns {Promise<Array<{ key: string; value: Change }>>} The changes.
   */
  entries(): Promise<Array<{ key: string; value: Change }>>;
  /**
   * @summary Writes a change.
   * @example
   * Writing
   * ```ts
   * await store.set(change.id, change);
   * ```
   * @param {string} key The id of the change.
   * @param {Change} value The change.
   * @returns {Promise<void>} Resolves when the change is stored.
   */
  set(key: string, value: Change): Promise<void>;
  /**
   * @summary Deletes a change.
   * @example
   * Deleting
   * ```ts
   * await store.delete(change.id);
   * ```
   * @param {string} key The id of the change.
   * @returns {Promise<void>} Resolves when the change is deleted.
   */
  delete(key: string): Promise<void>;
}

/**
 * @summary The operations that an exclusive section of the outbox can do.
 * @public
 */
export interface OutboxEditor {
  /**
   * @summary Returns every change, oldest first.
   * @example
   * Reading
   * ```ts
   * edit.list();
   * ```
   * @returns {Change[]} The changes.
   */
  list(): Change[];
  /**
   * @summary Adds or replaces a change.
   * @example
   * Writing
   * ```ts
   * await edit.put(change);
   * ```
   * @param {Change} change The change.
   * @returns {Promise<void>} Resolves when the change is stored.
   */
  put(change: Change): Promise<void>;
  /**
   * @summary Deletes a change.
   * @example
   * Deleting
   * ```ts
   * await edit.delete(id);
   * ```
   * @param {string} id The id of the change.
   * @returns {Promise<boolean>} `true` when the change existed.
   */
  delete(id: string): Promise<boolean>;
}

/**
 * @summary The outbox: changes in memory, and in a Storage collection when one is bound.
 * @example
 * Example 1: Memory only
 * ```ts
 * const outbox = new Outbox(() => render());
 * await outbox.put(change);
 * ```
 * @example
 * Example 2: Binding Storage
 * ```ts
 * await outbox.bind(storage.commands.collection({ name: 'sync.outbox.default' }));
 * ```
 * @public
 */
export class Outbox {
  readonly #changes = new Map<string, Change>();
  #store: OutboxStore | null = null;
  #queue: Promise<unknown> = Promise.resolve();
  readonly #editor: OutboxEditor = {
    list: () => this.list(),
    put: (change) => this.#put(change),
    delete: (id) => this.#delete(id),
  };

  /**
   * @summary Makes an outbox.
   * @param {Function} onChange Called after each change of the content.
   */
  constructor(private readonly onChange: () => void) {}

  /**
   * @summary Tells if a Storage collection is bound.
   * @returns {boolean} `true` when the outbox survives a reload.
   */
  get persistent(): boolean {
    return this.#store !== null;
  }

  /**
   * @summary Binds a Storage collection, or unbinds it with `null`.
   * @description The changes in memory move into the collection, then the outbox reads it.
   * @example
   * Binding when Storage starts
   * ```ts
   * await outbox.bind(collection);
   * ```
   * @param {OutboxStore | null} store The collection.
   * @returns {Promise<void>} Resolves when the outbox has the content of the collection.
   */
  bind(store: OutboxStore | null): Promise<void> {
    return this.exclusive(async () => {
      this.#store = store;
      if (!store) return;
      for (const change of this.#changes.values()) await store.set(change.id, change);
      await this.#reload();
    });
  }

  /**
   * @summary Runs a section alone: no other operation of the outbox runs at the same time.
   * @description Use it to read, decide and write as one step, for example to merge a new change.
   * @example
   * Merging
   * ```ts
   * await outbox.exclusive(async (edit) => {
   *   const last = edit.list().at(-1);
   *   if (last) await edit.put({ ...last, data });
   * });
   * ```
   * @param {Function} section The section. It gets an editor; it must not call the outbox itself.
   * @returns {Promise<T>} What the section returns.
   * @template T The result of the section.
   */
  exclusive<T>(section: (edit: OutboxEditor) => Promise<T>): Promise<T> {
    const next = this.#queue.then(() => section(this.#editor));
    this.#queue = next.catch(() => undefined);
    return next;
  }

  /**
   * @summary Reads the collection again, for example after another tab changed it.
   * @example
   * After a change in another tab
   * ```ts
   * await outbox.reload();
   * ```
   * @returns {Promise<void>} Resolves when the outbox has the content of the collection.
   */
  reload(): Promise<void> {
    return this.exclusive(() => this.#reload());
  }

  async #reload(): Promise<void> {
    const store = this.#store;
    if (!store) return;
    const rows = await store.entries();
    this.#changes.clear();
    for (const { value } of rows) this.#changes.set(value.id, value);
    this.onChange();
  }

  /**
   * @summary Returns every change, oldest first.
   * @example
   * The waiting changes
   * ```ts
   * outbox.list().filter((c) => c.state === 'waiting');
   * ```
   * @returns {Change[]} The changes.
   */
  list(): Change[] {
    return [...this.#changes.values()].sort(byOrder);
  }

  /**
   * @summary Returns one change.
   * @example
   * Reading
   * ```ts
   * outbox.get(id)?.state;
   * ```
   * @param {string} id The id of the change.
   * @returns {Change | undefined} The change.
   */
  get(id: string): Change | undefined {
    return this.#changes.get(id);
  }

  /**
   * @summary Adds or replaces a change.
   * @example
   * Writing
   * ```ts
   * await outbox.put({ ...change, attempts: change.attempts + 1 });
   * ```
   * @param {Change} change The change.
   * @returns {Promise<void>} Resolves when the change is stored.
   */
  put(change: Change): Promise<void> {
    return this.exclusive(() => this.#put(change));
  }

  async #put(change: Change): Promise<void> {
    this.#changes.set(change.id, change);
    this.onChange();
    await this.#store?.set(change.id, change);
  }

  /**
   * @summary Deletes a change.
   * @example
   * After the server confirmed it
   * ```ts
   * await outbox.delete(change.id);
   * ```
   * @param {string} id The id of the change.
   * @returns {Promise<boolean>} `true` when the change existed.
   */
  delete(id: string): Promise<boolean> {
    return this.exclusive(() => this.#delete(id));
  }

  /**
   * @summary Deletes every change, in memory and in the collection. Sync calls it on sign-out (ARCHITECTURE §5.1).
   * @example
   * On sign-out
   * ```ts
   * await outbox.clear();
   * ```
   * @returns {Promise<number>} The number of changes deleted.
   */
  clear(): Promise<number> {
    return this.exclusive(async () => {
      const ids = [...this.#changes.keys()];
      for (const id of ids) await this.#delete(id);
      // Changes that only the collection has (another tab wrote them) go too.
      const store = this.#store;
      if (store) for (const { key } of await store.entries()) await store.delete(key);
      return ids.length;
    });
  }

  async #delete(id: string): Promise<boolean> {
    const existed = this.#changes.delete(id);
    if (existed) this.onChange();
    await this.#store?.delete(id);
    return existed;
  }
}
