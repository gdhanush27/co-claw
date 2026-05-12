import * as assert from 'assert';
import * as vscode from 'vscode';
import { Orchestrator } from '../agents/Orchestrator';
import { RunRegistry } from '../agents/RunRegistry';
import { SharedMemoryStore } from '../agents/SharedMemoryStore';

/**
 * Regression tests for C1: spawnDynamicTask used to hand back a Promise
 * that the DAG loop could never resolve in several edge cases (unknown
 * dependsOn, run already completed, etc.), wedging the entire /agents
 * run. The fix is to validate synchronously and return a failed result
 * instead of constructing a pending promise.
 */
describe('Orchestrator.spawnDynamicTask validation', () => {
    function makeOrchestrator(): { orch: any; registry: RunRegistry } {
        const registry = new RunRegistry();
        const orch = new Orchestrator(
            { getActiveModel: async () => ({}) } as any,
            registry,
            new SharedMemoryStore(vscode.Uri.file('shared-test')),
            { current: undefined },
        );
        return { orch, registry };
    }

    it('throws when the runId does not exist', async () => {
        const { orch } = makeOrchestrator();
        await assert.rejects(
            () => orch.spawnDynamicTask('nonexistent-run', 'coder', 'prompt', []),
            /not found/,
        );
    });

    it('returns a failed result without queuing when the run is already done', async () => {
        const { orch, registry } = makeOrchestrator();
        registry.createRun('r1', 'prompt');
        registry.completeRun('r1', 'done');

        const result = await orch.spawnDynamicTask('r1', 'coder', 'work', []);
        assert.strictEqual(result.status, 'failed');
        assert.match(result.error, /no longer accepting tasks/);
        // No new task should have been pushed onto the (completed) run.
        const run = registry.getRun('r1')!;
        assert.strictEqual(run.tasks.length, 0);
    });

    it('returns a failed result without queuing when the run already failed', async () => {
        const { orch, registry } = makeOrchestrator();
        registry.createRun('r1', 'prompt');
        registry.completeRun('r1', 'failed');

        const result = await orch.spawnDynamicTask('r1', 'coder', 'work', []);
        assert.strictEqual(result.status, 'failed');
        assert.match(result.error, /no longer accepting tasks/);
    });

    it('rejects unknown dependsOn ids synchronously (would otherwise deadlock)', async () => {
        // Before the fix, a spawn with dependsOn: ['nonexistent'] would
        // create a pending task whose isReady() was permanently false.
        // The DAG loop would await the spawn promise (which never
        // resolves), deadlocking the whole /agents run.
        const { orch, registry } = makeOrchestrator();
        const run = registry.createRun('r1', 'prompt');
        registry.setTasks('r1', [
            { id: 'existing-task', agent: 'coder', prompt: 'p', dependsOn: [], status: 'done' },
        ]);
        void run;

        const result = await orch.spawnDynamicTask(
            'r1',
            'coder',
            'work',
            ['existing-task', 'phantom-dep'],
        );
        assert.strictEqual(result.status, 'failed');
        assert.match(result.error, /Unknown dependsOn ids: phantom-dep/);
        // Crucially: no task should have been pushed and no promise
        // should be sitting in spawnWaiters.
        const updated = registry.getRun('r1')!;
        assert.strictEqual(updated.tasks.length, 1);
        assert.strictEqual((orch as { spawnWaiters: Map<string, unknown> }).spawnWaiters.size, 0);
    });

    it('queues a normal spawn (deps satisfied) and registers a pending waiter', async () => {
        const { orch, registry } = makeOrchestrator();
        registry.createRun('r1', 'prompt');
        registry.setTasks('r1', [
            { id: 'parent', agent: 'coder', prompt: 'p', dependsOn: [], status: 'done' },
        ]);

        // Don't await — the promise stays pending until something calls
        // resolveSpawn. We just confirm the task was queued and a waiter
        // is registered.
        let resolved = false;
        const p = orch.spawnDynamicTask('r1', 'reviewer', 'review the parent', ['parent']).then((r: unknown) => {
            resolved = true;
            return r;
        });

        // Microtask flush
        await Promise.resolve();
        assert.strictEqual(resolved, false, 'spawn promise must not resolve before the DAG loop drives it');

        const run = registry.getRun('r1')!;
        assert.strictEqual(run.tasks.length, 2);
        const child = run.tasks[1];
        assert.strictEqual(child.agent, 'reviewer');
        assert.deepStrictEqual(child.dependsOn, ['parent']);
        assert.strictEqual(
            (orch as { spawnWaiters: Map<string, unknown> }).spawnWaiters.size,
            1,
            'a waiter must be registered for the spawned task',
        );

        // Drain the leftover waiter so the test process exits cleanly.
        (orch as any).drainSpawnWaiters('test cleanup');
        await p;
    });
});
