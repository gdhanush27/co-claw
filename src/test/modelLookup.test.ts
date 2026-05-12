import * as assert from 'assert';
import { describe, it } from 'mocha';
import { matchModels, ModelLike } from '../lm/modelLookup';

const MODELS: ModelLike[] = [
    { family: 'gpt-4o',            name: 'GPT-4o' },
    { family: 'gpt-4o-mini',       name: 'GPT-4o mini' },
    { family: 'gpt-5',             name: 'GPT-5' },
    { family: 'gpt-5-mini',        name: 'GPT-5 mini' },
    { family: 'claude-3.5-sonnet', name: 'Claude 3.5 Sonnet' },
    { family: 'claude-opus-4',     name: 'Claude Opus 4' },
    { family: 'gemini-2.5-pro',    name: 'Gemini 2.5 Pro' },
];

describe('matchModels', () => {
    it('returns [] for an empty query', () => {
        assert.deepStrictEqual(matchModels(MODELS, ''), []);
        assert.deepStrictEqual(matchModels(MODELS, '   '), []);
    });

    it('prefers exact family match (case-insensitive)', () => {
        const r = matchModels(MODELS, 'GPT-4o');
        assert.strictEqual(r.length, 1);
        assert.strictEqual(r[0].family, 'gpt-4o', 'exact family must win over startsWith/substring');
    });

    it('prefers exact name match when family does not match exactly', () => {
        const r = matchModels(MODELS, 'Claude Opus 4');
        assert.strictEqual(r.length, 1);
        assert.strictEqual(r[0].family, 'claude-opus-4');
    });

    it('falls back to startsWith on family', () => {
        const r = matchModels(MODELS, 'gpt-5');
        // gpt-5 is an exact family match → exactly one result
        assert.strictEqual(r.length, 1);
        assert.strictEqual(r[0].family, 'gpt-5');
    });

    it('returns multiple startsWith matches when a prefix is ambiguous', () => {
        // "claude" doesn't exact-match anything, but startsWith on family
        // matches both claude-3.5-sonnet and claude-opus-4.
        const r = matchModels(MODELS, 'claude');
        assert.strictEqual(r.length, 2);
        const families = r.map(m => m.family).sort();
        assert.deepStrictEqual(families, ['claude-3.5-sonnet', 'claude-opus-4']);
    });

    it('falls back to substring matching as the last resort', () => {
        // Substring tier deliberately scans both family AND name, so a query
        // like "sonnet" hits the family containing "sonnet" anywhere — not
        // just the prefix. (We use "sonnet" instead of "mini" because
        // "Gemini" also contains "mini" in its name, which would correctly
        // but unhelpfully widen the test.)
        const r = matchModels(MODELS, 'sonnet');
        const families = r.map(m => m.family);
        assert.deepStrictEqual(families, ['claude-3.5-sonnet']);
    });

    it('returns [] when nothing plausibly matches', () => {
        assert.deepStrictEqual(matchModels(MODELS, 'phantom-model-xyz'), []);
    });

    it('deduplicates by family when the input lists the same family twice', () => {
        const dup: ModelLike[] = [
            { family: 'gpt-4o', name: 'GPT-4o' },
            { family: 'gpt-4o', name: 'GPT-4o (preview)' },
        ];
        const r = matchModels(dup, 'gpt-4o');
        assert.strictEqual(r.length, 1, 'duplicate families must collapse');
        assert.strictEqual(r[0].family, 'gpt-4o');
    });
});
