import * as assert from 'assert';
import { injectFinalReviewer, isFinalReviewTask } from '../agents/Orchestrator';
import { SubTask } from '../agents/types';

/**
 * Unit tests for the pure, configurable injection of an automatic final
 * reviewer at the end of an /agents plan. The orchestrator wires this up
 * via `ensureFinalReviewer()`; here we exercise the pure function directly
 * to keep tests free of vscode workspace configuration mocking.
 */
describe('injectFinalReviewer', () => {
    function task(over: Partial<SubTask> & Pick<SubTask, 'id' | 'agent'>): SubTask {
        return {
            prompt: 'do work',
            dependsOn: [],
            status: 'pending',
            ...over,
        };
    }

    it('is a no-op when mode is "off"', () => {
        const tasks = [task({ id: 'c1', agent: 'coder' })];
        const out = injectFinalReviewer(tasks, 'off');
        assert.strictEqual(out.length, 1);
        assert.strictEqual(out[0].id, 'c1');
    });

    it('does nothing if there are no code-producing tasks (auto)', () => {
        const tasks = [
            task({ id: 'm1', agent: 'memory' }),
            task({ id: 'r1', agent: 'reviewer' }),
        ];
        const out = injectFinalReviewer(tasks, 'auto');
        assert.strictEqual(out.length, tasks.length);
        assert.ok(!out.some(t => isFinalReviewTask(t)), 'no final reviewer should be added');
    });

    it('does nothing if there are no code-producing tasks (always)', () => {
        const tasks = [task({ id: 'm1', agent: 'memory' })];
        const out = injectFinalReviewer(tasks, 'always');
        assert.strictEqual(out.length, tasks.length);
        assert.ok(!out.some(t => isFinalReviewTask(t)));
    });

    it('injects a final reviewer when mode=auto and no reviewer covers all coders', () => {
        const tasks = [
            task({ id: 'c1', agent: 'coder' }),
            task({ id: 'c2', agent: 'coder' }),
            task({ id: 't1', agent: 'tester', dependsOn: ['c1', 'c2'] }),
        ];
        const out = injectFinalReviewer(tasks, 'auto');
        assert.strictEqual(out.length, 4);
        const fr = out[out.length - 1];
        assert.ok(isFinalReviewTask(fr));
        assert.strictEqual(fr.agent, 'reviewer');
        assert.strictEqual(fr.difficulty, 'hard');
        // Depends on every code-producing task (coders + testers).
        assert.deepStrictEqual([...fr.dependsOn].sort(), ['c1', 'c2', 't1']);
    });

    it('skips injection in auto mode when an existing reviewer transitively covers everything', () => {
        const tasks = [
            task({ id: 'c1', agent: 'coder' }),
            task({ id: 'c2', agent: 'coder' }),
            task({ id: 't1', agent: 'tester', dependsOn: ['c1', 'c2'] }),
            // The existing reviewer depends directly on t1 which transitively
            // covers c1 and c2 — so a final reviewer would be redundant.
            task({ id: 'r1', agent: 'reviewer', dependsOn: ['t1'] }),
        ];
        const out = injectFinalReviewer(tasks, 'auto');
        assert.strictEqual(out.length, tasks.length, 'should not append a final reviewer');
        assert.ok(!out.some(t => isFinalReviewTask(t)));
    });

    it('still injects in auto mode when the existing reviewer covers only some coders', () => {
        const tasks = [
            task({ id: 'c1', agent: 'coder' }),
            task({ id: 'c2', agent: 'coder' }), // <- not covered by r1
            task({ id: 'r1', agent: 'reviewer', dependsOn: ['c1'] }),
        ];
        const out = injectFinalReviewer(tasks, 'auto');
        assert.strictEqual(out.length, 4);
        const fr = out[out.length - 1];
        assert.ok(isFinalReviewTask(fr));
        assert.deepStrictEqual([...fr.dependsOn].sort(), ['c1', 'c2']);
    });

    it('always-mode injects a final reviewer even when a covering reviewer already exists', () => {
        const tasks = [
            task({ id: 'c1', agent: 'coder' }),
            task({ id: 'r1', agent: 'reviewer', dependsOn: ['c1'] }),
        ];
        const out = injectFinalReviewer(tasks, 'always');
        assert.strictEqual(out.length, 3);
        const fr = out[out.length - 1];
        assert.ok(isFinalReviewTask(fr));
        assert.deepStrictEqual(fr.dependsOn, ['c1']);
    });

    it('chooses a unique id when "final-review" collides', () => {
        const tasks = [
            task({ id: 'final-review', agent: 'coder' }), // intentionally collides
            task({ id: 'final-review-2', agent: 'tester' }), // and so does this one
        ];
        const out = injectFinalReviewer(tasks, 'auto');
        assert.strictEqual(out.length, 3);
        const fr = out[out.length - 1];
        assert.strictEqual(fr.id, 'final-review-3');
        assert.ok(isFinalReviewTask(fr));
    });

    it('uses the same prompt body every time so model caches can reuse it', () => {
        const a = injectFinalReviewer([task({ id: 'c1', agent: 'coder' })], 'auto');
        const b = injectFinalReviewer([task({ id: 'c1', agent: 'coder' })], 'always');
        const aFinal = a[a.length - 1];
        const bFinal = b[b.length - 1];
        assert.strictEqual(aFinal.prompt, bFinal.prompt);
        assert.match(aFinal.prompt, /Final consolidated review/);
        assert.match(aFinal.prompt, /APPROVED/);
        assert.match(aFinal.prompt, /CHANGES_REQUESTED/);
    });

    it('does not mutate the input task list', () => {
        const tasks = [task({ id: 'c1', agent: 'coder' })];
        const before = tasks.length;
        injectFinalReviewer(tasks, 'auto');
        assert.strictEqual(tasks.length, before, 'input should be left untouched');
    });
});

describe('isFinalReviewTask', () => {
    it('matches the canonical final-review id', () => {
        assert.ok(isFinalReviewTask({ id: 'final-review', agent: 'reviewer', prompt: '', dependsOn: [], status: 'pending' }));
    });

    it('matches numbered fallback ids like final-review-2', () => {
        assert.ok(isFinalReviewTask({ id: 'final-review-2', agent: 'reviewer', prompt: '', dependsOn: [], status: 'pending' }));
        assert.ok(isFinalReviewTask({ id: 'final-review-37', agent: 'reviewer', prompt: '', dependsOn: [], status: 'pending' }));
    });

    it('does not match other reviewer ids', () => {
        assert.ok(!isFinalReviewTask({ id: 'reviewer-1', agent: 'reviewer', prompt: '', dependsOn: [], status: 'pending' }));
        assert.ok(!isFinalReviewTask({ id: 'final-review-suffix', agent: 'reviewer', prompt: '', dependsOn: [], status: 'pending' }));
    });

    it('does not match non-reviewer agents even with a matching id', () => {
        assert.ok(!isFinalReviewTask({ id: 'final-review', agent: 'coder', prompt: '', dependsOn: [], status: 'pending' }));
    });
});
