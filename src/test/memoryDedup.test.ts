import * as assert from 'assert';

// We test isSimilar by extracting the logic (it's the same algorithm in MemoryEngine)
// Since MemoryEngine requires vscode, we test the similarity algorithm in isolation.

function isSimilar(a: string, b: string): boolean {
    const wordsA = new Set(a.toLowerCase().split(/\s+/).filter(w => w.length > 2));
    const wordsB = new Set(b.toLowerCase().split(/\s+/).filter(w => w.length > 2));
    if (wordsA.size === 0 || wordsB.size === 0) { return false; }
    let overlap = 0;
    for (const w of wordsA) {
        if (wordsB.has(w)) { overlap++; }
    }
    const smaller = Math.min(wordsA.size, wordsB.size);
    return overlap / smaller > 0.6;
}

function estimateTokens(text: string): number {
    return Math.ceil(text.length / 4);
}

describe('Memory Deduplication', () => {
    describe('isSimilar()', () => {
        it('should detect identical content', () => {
            assert.ok(isSimilar('uses typescript with strict mode', 'uses typescript with strict mode'));
        });

        it('should detect very similar content', () => {
            assert.ok(isSimilar(
                'User prefers TypeScript with strict mode enabled',
                'User prefers TypeScript with strict mode'
            ));
        });

        it('should reject dissimilar content', () => {
            assert.ok(!isSimilar(
                'Uses PostgreSQL for database',
                'Prefers dark theme in VS Code'
            ));
        });

        it('should handle empty or short strings', () => {
            assert.ok(!isSimilar('', ''));
            assert.ok(!isSimilar('a', 'b'));
            assert.ok(!isSimilar('hi', 'hi')); // words too short (< 3 chars)
        });

        it('should be case-insensitive', () => {
            assert.ok(isSimilar(
                'Uses TYPESCRIPT Strict Mode',
                'uses typescript strict mode'
            ));
        });
    });
});

describe('Token Budget', () => {
    describe('estimateTokens()', () => {
        it('should estimate ~4 chars per token', () => {
            assert.strictEqual(estimateTokens(''), 0);
            assert.strictEqual(estimateTokens('test'), 1);
            assert.strictEqual(estimateTokens('hello world!'), 3); // 12 chars / 4 = 3
        });

        it('should handle long strings', () => {
            const longText = 'a'.repeat(1000);
            assert.strictEqual(estimateTokens(longText), 250);
        });
    });
});
