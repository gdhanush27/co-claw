import * as assert from 'assert';
import { MemoryRecall } from '../memory/MemoryRecall';
import { MemoryEntry } from '../memory/types';

function makeEntry(overrides: Partial<MemoryEntry> = {}): MemoryEntry {
    return {
        id: 'test-' + Math.random().toString(36).substring(7),
        content: 'test content',
        type: 'fact',
        tags: [],
        importance: 0.5,
        createdAt: Date.now(),
        lastUsedAt: Date.now(),
        source: 'manual',
        ...overrides,
    };
}

describe('MemoryRecall', () => {
    let recall: MemoryRecall;

    beforeEach(() => {
        recall = new MemoryRecall();
    });

    describe('recall()', () => {
        it('should return entries matching query terms', () => {
            const daily = [makeEntry({ content: 'uses typescript with strict mode', importance: 0.8 })];
            const longterm = [makeEntry({ content: 'prefers react over angular', importance: 0.9 })];

            const results = recall.recall('typescript strict', daily, longterm, 10000);
            assert.ok(results.length > 0);
            assert.ok(results[0].entry.content.includes('typescript'));
        });

        it('should return top by importance when no query terms', () => {
            const daily = [makeEntry({ content: 'a', importance: 0.3 })];
            const longterm = [
                makeEntry({ content: 'b', importance: 0.9 }),
                makeEntry({ content: 'c', importance: 0.5 }),
            ];

            const results = recall.recall('', daily, longterm, 10000);
            assert.ok(results.length > 0);
            assert.strictEqual(results[0].entry.content, 'b');
        });

        it('should respect token budget', () => {
            const longterm = Array.from({ length: 50 }, (_, i) =>
                makeEntry({ content: `entry ${i} with matching keyword`, importance: 0.8 })
            );

            // Budget for ~2 entries only (each ~10 tokens)
            const results = recall.recall('keyword', [], longterm, 20);
            assert.ok(results.length < 50);
            assert.ok(results.length <= 5); // Should fit very few entries in 20 tokens
        });

        it('should score higher for recent entries', () => {
            const old = makeEntry({
                content: 'uses typescript',
                importance: 0.8,
                lastUsedAt: Date.now() - 29 * 24 * 60 * 60 * 1000, // 29 days ago
            });
            const recent = makeEntry({
                content: 'uses typescript',
                importance: 0.8,
                lastUsedAt: Date.now(), // now
            });

            const resultsOld = recall.recall('typescript', [old], [], 10000);
            const resultsRecent = recall.recall('typescript', [recent], [], 10000);

            assert.ok(resultsOld.length > 0);
            assert.ok(resultsRecent.length > 0);
            assert.ok(resultsRecent[0].score > resultsOld[0].score);
        });
    });

    describe('searchByKeyword()', () => {
        it('should find entries by content', () => {
            const entries = [
                makeEntry({ content: 'uses PostgreSQL for database' }),
                makeEntry({ content: 'prefers dark theme' }),
            ];

            const results = recall.searchByKeyword(entries, 'postgresql');
            assert.strictEqual(results.length, 1);
            assert.ok(results[0].content.includes('PostgreSQL'));
        });

        it('should find entries by tag', () => {
            const entries = [
                makeEntry({ content: 'some fact', tags: ['database', 'postgresql'] }),
                makeEntry({ content: 'another fact', tags: ['ui', 'theme'] }),
            ];

            const results = recall.searchByKeyword(entries, 'database');
            assert.strictEqual(results.length, 1);
        });

        it('should be case-insensitive', () => {
            const entries = [makeEntry({ content: 'Uses TypeScript' })];
            const results = recall.searchByKeyword(entries, 'TYPESCRIPT');
            assert.strictEqual(results.length, 1);
        });
    });
});
