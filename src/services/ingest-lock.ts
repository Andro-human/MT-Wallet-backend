/**
 * Serialize ingest per user so parallel SMS + email batches don't race past
 * cross-channel dedup checks before either row is committed.
 */
const userLocks = new Map<string, Promise<unknown>>();

export function withUserIngestLock<T>(userId: string, fn: () => Promise<T>): Promise<T> {
  const prev = userLocks.get(userId) ?? Promise.resolve();
  const run = prev.catch(() => undefined).then(fn);
  userLocks.set(userId, run);
  return run.finally(() => {
    if (userLocks.get(userId) === run) {
      userLocks.delete(userId);
    }
  });
}
