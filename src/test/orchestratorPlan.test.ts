import * as assert from 'assert';
import * as vscode from 'vscode';
import { Orchestrator } from '../agents/Orchestrator';
import { RunRegistry } from '../agents/RunRegistry';
import { SharedMemoryStore } from '../agents/SharedMemoryStore';

/**
 * Validate the planner-output parser. We deliberately exercise it through the
 * private `parsePlan` method (via bracket-access) because that's the riskiest
 * surface — the rest of the orchestrator only matters once a plan exists.
 */
describe('Orchestrator.parsePlan', () => {
    function makeOrchestrator(): any {
        return new Orchestrator(
            { getActiveModel: async () => ({}) } as any,
            new RunRegistry(),
            new SharedMemoryStore(vscode.Uri.file('shared-test')),
            { current: undefined },
        );
    }

    it('extracts a plan when JSON is wrapped in prose / code fences', () => {
        const orch = makeOrchestrator();
        const text = 'Here is the plan:\n\n```json\n{ "tasks": [' +
            '{ "id": "t1", "agent": "coder", "prompt": "Implement feature A", "dependsOn": [] },' +
            '{ "id": "t2", "agent": "reviewer", "prompt": "Review t1", "dependsOn": ["t1"] }' +
            '] }\n```\n\nLet me know if that works.';
        const plan = orch.parsePlan(text);
        assert.ok(plan, 'expected a plan');
        assert.strictEqual(plan!.tasks.length, 2);
        assert.strictEqual(plan!.tasks[0].agent, 'coder');
        assert.strictEqual(plan!.tasks[1].dependsOn[0], 't1');
    });

    it('returns undefined for non-JSON output', () => {
        const orch = makeOrchestrator();
        assert.strictEqual(orch.parsePlan('I refuse to plan this.'), undefined);
        assert.strictEqual(orch.parsePlan(''), undefined);
        assert.strictEqual(orch.parsePlan('{ broken json'), undefined);
    });

    it('drops tasks that name unknown / forbidden agents', () => {
        const orch = makeOrchestrator();
        // 'planner' and 'orchestrator' are not eligible roles for sub-tasks.
        // 'wizard' is not a registered role at all.
        const text = JSON.stringify({
            tasks: [
                { id: 't1', agent: 'wizard', prompt: 'cast spells', dependsOn: [] },
                { id: 't2', agent: 'planner', prompt: 'self-loop', dependsOn: [] },
                { id: 't3', agent: 'orchestrator', prompt: 'recurse', dependsOn: [] },
                { id: 't4', agent: 'tester', prompt: 'run tests', dependsOn: [] },
            ],
        });
        const plan = orch.parsePlan(text);
        assert.ok(plan);
        assert.strictEqual(plan!.tasks.length, 1);
        assert.strictEqual(plan!.tasks[0].id, 't4');
    });

    it('drops tasks missing id or prompt', () => {
        const orch = makeOrchestrator();
        const text = JSON.stringify({
            tasks: [
                { id: '', agent: 'coder', prompt: 'no id', dependsOn: [] },
                { id: 't1', agent: 'coder', prompt: '', dependsOn: [] },
                { id: 't2', agent: 'coder', prompt: 'good', dependsOn: [] },
            ],
        });
        const plan = orch.parsePlan(text);
        assert.ok(plan);
        assert.strictEqual(plan!.tasks.length, 1);
        assert.strictEqual(plan!.tasks[0].id, 't2');
    });

    it('returns undefined when every task is invalid (so caller can fall back)', () => {
        const orch = makeOrchestrator();
        const text = JSON.stringify({
            tasks: [
                { id: '', agent: 'coder', prompt: '', dependsOn: [] },
                { id: 't1', agent: 'unknown', prompt: 'foo', dependsOn: [] },
            ],
        });
        const plan = orch.parsePlan(text);
        assert.strictEqual(plan, undefined);
    });
});

describe('Orchestrator.hasCycle', () => {
    function makeOrchestrator(): any {
        return new Orchestrator(
            { getActiveModel: async () => ({}) } as any,
            new RunRegistry(),
            new SharedMemoryStore(vscode.Uri.file('shared-test')),
            { current: undefined },
        );
    }

    it('detects a 2-node cycle', () => {
        const orch = makeOrchestrator();
        const tasks = [
            { id: 'a', agent: 'coder', prompt: '', dependsOn: ['b'], status: 'pending' },
            { id: 'b', agent: 'coder', prompt: '', dependsOn: ['a'], status: 'pending' },
        ];
        assert.strictEqual(orch.hasCycle(tasks), true);
    });

    it('accepts a linear DAG', () => {
        const orch = makeOrchestrator();
        const tasks = [
            { id: 'a', agent: 'coder', prompt: '', dependsOn: [], status: 'pending' },
            { id: 'b', agent: 'reviewer', prompt: '', dependsOn: ['a'], status: 'pending' },
            { id: 'c', agent: 'tester', prompt: '', dependsOn: ['b'], status: 'pending' },
        ];
        assert.strictEqual(orch.hasCycle(tasks), false);
    });
});
