/**
 * Per-key serial async lock.
 *
 * Memory storage files (`longterm.json`, `<date>.json`) are mutated through
 * read-modify-write cycles. Without serialization, two concurrent extractions
 * (e.g. one from the chat participant and one from the Telegram bridge) can
 * both load the same snapshot, mutate independently, and the second write
 * silently overwrites the first — losing entries.
 *
 * Usage:
 *   await withLock(uri.toString(), async () => {
 *       const file = await load();
 *       file.entries.push(...);
 *       await save(file);
 *   });
 *
 * Implementation note: each key holds the tail of a promise chain. New
 * callers attach to the tail and replace it; the chain self-cleans when
 * the last waiter completes.
 */
const inFlight = new Map<string, Promise<unknown>>();

export async function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const previous = inFlight.get(key) ?? Promise.resolve();
    // We deliberately do NOT propagate previous rejection into our own
    // execution: a prior caller's failure should not block subsequent work.
    const next = previous
        .catch(() => undefined)
        .then(() => fn());
    inFlight.set(key, next);
    try {
        return await next;
    } finally {
        // Only clear if we are still the tail — another caller may have
        // appended after us and we mustn't drop their handle.
        if (inFlight.get(key) === next) {
            inFlight.delete(key);
        }
    }
}
