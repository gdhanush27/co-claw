import * as assert from 'assert';
import * as vscode from 'vscode';
import { Orchestrator, parseRunFlags, resolveOutputCap } from '../agents/Orchestrator';
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

    it('parses a valid `difficulty` field on each task', () => {
        const orch = makeOrchestrator();
        const text = JSON.stringify({
            tasks: [
                { id: 't1', agent: 'coder',    prompt: 'fix typo', difficulty: 'light',  dependsOn: [] },
                { id: 't2', agent: 'reviewer', prompt: 'audit',    difficulty: 'hard',   dependsOn: ['t1'] },
                { id: 't3', agent: 'tester',   prompt: 'add test', difficulty: 'medium', dependsOn: ['t2'] },
            ],
        });
        const plan = orch.parsePlan(text);
        assert.ok(plan);
        assert.strictEqual(plan!.tasks[0].difficulty, 'light');
        assert.strictEqual(plan!.tasks[1].difficulty, 'hard');
        assert.strictEqual(plan!.tasks[2].difficulty, 'medium');
    });

    it('drops invalid `difficulty` values instead of poisoning the task', () => {
        // Critical: an unknown difficulty string MUST NOT survive into the
        // SubTask, otherwise getModelForTier() would either explode or fall
        // through silently to the default tier without warning.
        const orch = makeOrchestrator();
        const text = JSON.stringify({
            tasks: [
                { id: 't1', agent: 'coder', prompt: 'build',   difficulty: 'hardest', dependsOn: [] },
                { id: 't2', agent: 'coder', prompt: 'build 2', difficulty: 42,        dependsOn: [] },
                { id: 't3', agent: 'coder', prompt: 'build 3',                         dependsOn: [] },
            ],
        });
        const plan = orch.parsePlan(text);
        assert.ok(plan);
        for (const t of plan!.tasks) {
            assert.strictEqual(t.difficulty, undefined,
                `task ${t.id} should have undefined difficulty for invalid/missing values`);
        }
    });

    it('normalizes `difficulty` casing so "HARD" still routes to the hard tier', () => {
        const orch = makeOrchestrator();
        const text = JSON.stringify({
            tasks: [
                { id: 't1', agent: 'coder', prompt: 'build', difficulty: 'HARD', dependsOn: [] },
                { id: 't2', agent: 'coder', prompt: 'fix',   difficulty: ' Light ', dependsOn: [] },
            ],
        });
        const plan = orch.parsePlan(text);
        assert.ok(plan);
        assert.strictEqual(plan!.tasks[0].difficulty, 'hard');
        assert.strictEqual(plan!.tasks[1].difficulty, 'light');
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

describe('Orchestrator parseRunFlags', () => {
    it('returns the prompt unchanged when no flags are present', () => {
        const r = parseRunFlags('investigate the workflow files');
        assert.strictEqual(r.fullOutput, false);
        assert.strictEqual(r.prompt, 'investigate the workflow files');
    });

    it('strips a leading --full and sets fullOutput', () => {
        const r = parseRunFlags('--full investigate the workflow files');
        assert.strictEqual(r.fullOutput, true);
        assert.strictEqual(r.prompt, 'investigate the workflow files');
    });

    it('strips a trailing --full and sets fullOutput', () => {
        const r = parseRunFlags('investigate the workflow files --full');
        assert.strictEqual(r.fullOutput, true);
        assert.strictEqual(r.prompt, 'investigate the workflow files');
    });

    it('accepts the --all and --no-truncate aliases', () => {
        for (const flag of ['--all', '--no-truncate', '--notrunc']) {
            const r = parseRunFlags(`${flag} ship it`);
            assert.strictEqual(r.fullOutput, true, `expected ${flag} to set fullOutput`);
            assert.strictEqual(r.prompt, 'ship it');
        }
    });

    it('strips multiple stacked flags from either end', () => {
        const r = parseRunFlags('--full --all do the thing --no-truncate');
        assert.strictEqual(r.fullOutput, true);
        assert.strictEqual(r.prompt, 'do the thing');
    });

    it('preserves a mid-prompt --full so prompts about the flag itself are not munged', () => {
        const r = parseRunFlags('explain what --full does in /agents');
        assert.strictEqual(r.fullOutput, false);
        assert.strictEqual(r.prompt, 'explain what --full does in /agents');
    });

    it('handles flag-only prompts gracefully (empty stripped result)', () => {
        const r = parseRunFlags('--full');
        assert.strictEqual(r.fullOutput, true);
        assert.strictEqual(r.prompt, '');
    });
});

describe('Orchestrator resolveOutputCap', () => {
    const originalGetConfig = vscode.workspace.getConfiguration;

    function stubConfig(values: { summaryMaxChars?: number; alwaysShowFullOutput?: boolean }): void {
        (vscode.workspace as any).getConfiguration = (section?: string) => ({
            get: <T>(key: string, defaultValue: T): T => {
                if (section === 'CoClaw.agents' && key in values) {
                    return (values as any)[key] as T;
                }
                return defaultValue;
            },
        });
    }

    afterEach(() => {
        (vscode.workspace as any).getConfiguration = originalGetConfig;
    });

    it('returns the configured cap when nothing forces full output', () => {
        stubConfig({ summaryMaxChars: 1234 });
        assert.strictEqual(resolveOutputCap(false), 1234);
    });

    it('returns Infinity when the per-run flag is true (highest precedence)', () => {
        stubConfig({ summaryMaxChars: 1234, alwaysShowFullOutput: false });
        assert.strictEqual(resolveOutputCap(true), Number.POSITIVE_INFINITY);
    });

    it('returns Infinity when alwaysShowFullOutput is on, even with a finite cap', () => {
        stubConfig({ summaryMaxChars: 500, alwaysShowFullOutput: true });
        assert.strictEqual(resolveOutputCap(false), Number.POSITIVE_INFINITY);
    });

    it('treats summaryMaxChars=0 as unlimited', () => {
        stubConfig({ summaryMaxChars: 0 });
        assert.strictEqual(resolveOutputCap(false), Number.POSITIVE_INFINITY);
    });

    it('falls back to the 8000 default when no settings are present', () => {
        stubConfig({});
        assert.strictEqual(resolveOutputCap(false), 8000);
    });

    it('floors fractional caps to a safe integer', () => {
        stubConfig({ summaryMaxChars: 1234.9 });
        assert.strictEqual(resolveOutputCap(false), 1234);
    });
});
