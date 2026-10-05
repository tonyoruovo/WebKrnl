/**
 * @fileoverview
 * @summary The optimistic update: apply a change at once, commit it, and roll it back when the commit fails.
 * @description
 * The primitive of the Settings proposal. Settings uses it for each change
 * that it saves on the server, and an app can use it for its own changes.
 *
 * ```text
 *   apply()  --> the UI shows the change at once
 *   commit() --> ok:     the result
 *            --> failed: rollback(error), then the error again
 *   ```
 *
 * @example
 * A like button
 * ```ts
 * await optimisticUpdate(
 *   () => (post.liked = true),
 *   () => api.like(post.id),
 *   () => (post.liked = false),
 * );
 * ```
 *
 * @author MathAid
 */

/**
 * @summary Applies a change, commits it, and rolls it back when the commit fails.
 *
 * @description
 * `apply` runs at once, so the user sees the change without a wait. Then
 * `commit` runs. When it fails, `rollback` gets the error, and the returned
 * promise rejects with the same error.
 *
 * @example
 * Example 1: Renaming a list
 * ```ts
 * const before = list.name;
 * await optimisticUpdate(
 *   () => (list.name = 'Groceries'),
 *   () => api.rename(list.id, 'Groceries'),
 *   () => (list.name = before),
 * );
 * ```
 *
 * @example
 * Example 2: Showing the failure
 * ```ts
 * await optimisticUpdate(apply, commit, (error) => toast(`Not saved: ${(error as Error).message}`)).catch(() => {});
 * ```
 *
 * @template T The result of the commit.
 * @param {() => void} apply Makes the change locally.
 * @param {() => Promise<T>} commit Makes the change on the server.
 * @param {(error: unknown) => void} rollback Undoes the local change.
 * @returns {Promise<T>} The result of `commit`.
 * @throws {unknown} The error of `commit`, after `rollback`.
 *
 * @public
 */
export async function optimisticUpdate<T>(
  apply: () => void,
  commit: () => Promise<T>,
  rollback: (error: unknown) => void,
): Promise<T> {
  apply();
  try {
    return await commit();
  } catch (error) {
    rollback(error);
    throw error;
  }
}
