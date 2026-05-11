import * as assert from 'assert';
import { withLock } from '../memory/fileLock';

describe('withLock', () => {
    it('serializes concurrent operations on the same key', async () => {
        const order: string[] = [];
        const key = 'serial-test';

        await Promise.all([
            withLock(key, async () => {
                order.push('a-start');
                await new Promise(r => setTimeout(r, 20));
                order.push('a-end');
            }),
            withLock(key, async () => {
                order.push('b-start');
                await new Promise(r => setTimeout(r, 5));
                order.push('b-end');
            }),
            withLock(key, async () => {
                order.push('c-start');
                order.push('c-end');
            }),
        ]);

        // The three operations must execute non-overlapping: each *-start is
        // immediately followed by its *-end before the next *-start.
        assert.deepStrictEqual(order, [
            'a-start', 'a-end',
            'b-start', 'b-end',
            'c-start', 'c-end',
        ]);
    });

    it('runs different keys in parallel', async () => {
        const order: string[] = [];
        await Promise.all([
            withLock('alpha', async () => {
                order.push('alpha-start');
                await new Promise(r => setTimeout(r, 30));
                order.push('alpha-end');
            }),
            withLock('beta', async () => {
                order.push('beta-start');
                await new Promise(r => setTimeout(r, 5));
                order.push('beta-end');
            }),
        ]);

        // Beta must complete while alpha is still running, otherwise the
        // helper is over-locking.
        assert.strictEqual(order[0], 'alpha-start');
        assert.strictEqual(order[1], 'beta-start');
        assert.strictEqual(order[2], 'beta-end');
        assert.strictEqual(order[3], 'alpha-end');
    });

    it('does not propagate a previous failure to subsequent callers', async () => {
        const key = 'isolation-test';
        const results: string[] = [];

        await Promise.all([
            withLock(key, async () => { throw new Error('first fails'); })
                .catch((e: Error) => { results.push(`err:${e.message}`); }),
            withLock(key, async () => { results.push('second-ran'); }),
        ]);

        assert.deepStrictEqual(results, ['err:first fails', 'second-ran']);
    });

    it('returns the value produced by the wrapped function', async () => {
        const value = await withLock('value-test', async () => 42);
        assert.strictEqual(value, 42);
    });
});
