import * as assert from 'assert';
import { describe, it } from 'mocha';
import { splitCoderTask } from '../agents/CoderSplitter';
import { SubTask } from '../agents/types';

function task(prompt: string, units?: string[]): SubTask {
    return {
        id: 'c1',
        agent: 'coder',
        prompt,
        units,
        dependsOn: [],
        status: 'pending',
    };
}

describe('CoderSplitter splitCoderTask', () => {
    it('returns the original task untouched when no units and no min floor (atomic work)', () => {
        const t = task('fix the typo in line 42 of README.md');
        const r = splitCoderTask(t, '', 4, 1);
        assert.strictEqual(r.didSplit, false);
        assert.strictEqual(r.replacements.length, 1);
        assert.strictEqual(r.replacements[0].id, 'c1');
    });

    it('honors planner-provided units up to the cap', () => {
        const t = task('implement feature', ['frontend.tsx', 'backend.ts', 'schema.sql', 'tests.ts', 'docs.md']);
        const r = splitCoderTask(t, '', 3, 1);
        assert.strictEqual(r.didSplit, true);
        assert.strictEqual(r.replacements.length, 3, 'cap of 3 should win over 5 units');
    });

    it('pads up to minParallel with generic lanes when the task is atomic', () => {
        const t = task('fix the typo');
        const r = splitCoderTask(t, '', 4, 3);
        assert.strictEqual(r.didSplit, true);
        assert.strictEqual(r.replacements.length, 3, `expected 3 padded coders; got ${r.replacements.length}`);
        // Pad order = implementation, tests, docs (per PAD_LANES order).
        const units = r.replacements.map(c => c.units?.[0]);
        assert.deepStrictEqual(units, ['implementation', 'tests', 'docs']);
    });

    it('does not duplicate a lane that already came from the prompt when padding', () => {
        const t = task('add unit tests');
        const r = splitCoderTask(t, '', 4, 3);
        assert.strictEqual(r.didSplit, true);
        const units = r.replacements.map(c => c.units?.[0]);
        // 'tests' was auto-decomposed from the prompt; padder must NOT add it again.
        const testsCount = units.filter(u => u === 'tests').length;
        assert.strictEqual(testsCount, 1, `'tests' should appear exactly once; got ${units.join(', ')}`);
    });

    it('clamps minParallel to maxParallel when min > max', () => {
        const t = task('fix the typo');
        const r = splitCoderTask(t, '', 2, 8);
        assert.strictEqual(r.replacements.length, 2, 'min=8 with max=2 should clamp to 2 coders');
    });

    it('clamps minParallel below 1 to 1 (treats absurd values as default)', () => {
        const t = task('fix the typo');
        const r = splitCoderTask(t, '', 4, 0);
        assert.strictEqual(r.didSplit, false);
        assert.strictEqual(r.replacements.length, 1);
    });

    it('leaves natural fan-out alone when units already meet the floor', () => {
        const t = task('build feature', ['ui.tsx', 'api.ts']);
        const r = splitCoderTask(t, '', 4, 2);
        assert.strictEqual(r.replacements.length, 2);
        assert.strictEqual(r.replacements[0].units?.[0], 'ui.tsx');
        assert.strictEqual(r.replacements[1].units?.[0], 'api.ts');
    });

    it('chains coders that target the same file path sequentially (no parallel writes)', () => {
        const t = task('split work', ['src/app.ts: add header', 'src/app.ts: add footer']);
        const r = splitCoderTask(t, '', 4, 1);
        assert.strictEqual(r.replacements.length, 2);
        // The second coder should depend on the first because both touch src/app.ts.
        assert.deepStrictEqual(r.replacements[0].dependsOn, []);
        assert.ok(r.replacements[1].dependsOn.includes(r.replacements[0].id),
            'second coder should depend on first to serialize same-file writes');
    });

    it('skips non-coder agents entirely', () => {
        const t: SubTask = { ...task(''), agent: 'reviewer' };
        const r = splitCoderTask(t, '', 4, 4);
        assert.strictEqual(r.didSplit, false);
        assert.strictEqual(r.replacements.length, 1);
        assert.strictEqual(r.replacements[0], t, 'non-coder tasks should be returned unchanged');
    });

    it('propagates parent difficulty into split child tasks', () => {
        // Per-tier model routing relies on every fanned-out coder inheriting
        // the parent's difficulty; if this regresses, all child coders silently
        // run on the default tier instead of the requested one.
        const t: SubTask = { ...task('build feature', ['ui.tsx', 'api.ts']), difficulty: 'hard' };
        const r = splitCoderTask(t, '', 4, 1);
        assert.strictEqual(r.didSplit, true);
        for (const child of r.replacements) {
            assert.strictEqual(child.difficulty, 'hard',
                `child ${child.id} should inherit parent's 'hard' difficulty`);
        }
    });

    it('leaves child difficulty undefined when parent has none', () => {
        const t = task('build feature', ['ui.tsx', 'api.ts']);
        const r = splitCoderTask(t, '', 4, 1);
        assert.strictEqual(r.didSplit, true);
        for (const child of r.replacements) {
            assert.strictEqual(child.difficulty, undefined,
                'absent parent difficulty must not be invented by the splitter');
        }
    });
});
