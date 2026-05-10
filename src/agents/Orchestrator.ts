import * as vscode from 'vscode';
import { randomUUID } from 'crypto';
import { ModelManager } from '../lm/ModelManager';
import { SpecializedAgent } from './SpecializedAgent';
import { RunRegistry } from './RunRegistry';
import { SharedMemoryStore } from './SharedMemoryStore';
import { splitCoderTask } from './CoderSplitter';
import { AGENT_DEFINITIONS } from './AgentDefinitions';
import { AgentRole, PlanDocument, SubTask } from './types';
import { AgentSpawner } from '../tools/spawnAgentTool';

export interface SpawnerHolder {
    current: AgentSpawner | undefined;
}

interface PendingSpawn {
    resolve: (value: { taskId: string; status: string; output?: string; error?: string }) => void;
}

export class Orchestrator implements AgentSpawner {
    private maxParallelCoders = 4;
    private spawnWaiters = new Map<string, PendingSpawn>();

    constructor(
        private readonly modelManager: ModelManager,
        private readonly registry: RunRegistry,
        private readonly sharedStore: SharedMemoryStore,
        private readonly spawnerHolder: SpawnerHolder,
    ) {}

    async run(
        userPrompt: string,
        stream: vscode.ChatResponseStream,
        token: vscode.CancellationToken,
        toolInvocationToken?: vscode.ChatParticipantToolToken,
    ): Promise<void> {
        this.maxParallelCoders = vscode.workspace.getConfiguration('CoClaw.agents')
            .get<number>('maxParallelCoders', 4);

        const runId = randomUUID();
        const run = this.registry.createRun(runId, userPrompt);
        this.spawnerHolder.current = this;

        try {
            const model = await this.modelManager.getActiveModel();
            const agentRunner = new SpecializedAgent(model);

            stream.markdown(`### Multi-agent run \`${runId.substring(0, 8)}\`\n\n`);
            stream.progress('Planner: decomposing task...');

            // --- Step A: Planner ---
            const plannerResult = await agentRunner.runAgent(
                'planner',
                `User task:\n${userPrompt}\n\nProduce the JSON DAG now.`,
                runId,
                'planner',
                token,
                toolInvocationToken,
            );

            let plan = this.parsePlan(plannerResult.text);
            if (!plan) {
                stream.markdown('_Planner did not return valid JSON; retrying with strict reminder..._\n\n');
                const retry = await agentRunner.runAgent(
                    'planner',
                    `Your previous output was not valid JSON. Output ONLY a JSON object matching the required schema. User task:\n${userPrompt}`,
                    runId,
                    'planner',
                    token,
                    toolInvocationToken,
                );
                plan = this.parsePlan(retry.text);
            }
            if (!plan || plan.tasks.length === 0) {
                stream.markdown('_Planner failed; falling back to a single coder task._\n\n');
                plan = {
                    tasks: [{
                        id: 'coder-1',
                        agent: 'coder',
                        prompt: userPrompt,
                        dependsOn: [],
                        status: 'pending',
                    }],
                };
            }

            // --- Step A.5: Auto-fanout coder tasks ---
            plan.tasks = this.applyAutoFanout(plan.tasks, userPrompt);

            // Cycle check
            if (this.hasCycle(plan.tasks)) {
                stream.markdown('_Plan contains cyclic dependencies; aborting._\n\n');
                this.registry.completeRun(runId, 'failed');
                return;
            }

            this.registry.setTasks(runId, plan.tasks);
            this.renderPlan(plan.tasks, stream);

            // --- Step B: Dependency loop ---
            await this.executeDag(runId, plan.tasks, agentRunner, stream, token, toolInvocationToken);

            // --- Step C: Summary ---
            const finalRun = this.registry.getRun(runId)!;
            const anyFailed = finalRun.tasks.some(t => t.status === 'failed');
            this.registry.completeRun(runId, anyFailed ? 'failed' : 'done');
            this.renderSummary(finalRun.tasks, stream);
        } catch (e) {
            stream.markdown(`\n\n_Orchestrator error: ${e instanceof Error ? e.message : String(e)}_`);
            this.registry.completeRun(runId, 'failed');
        } finally {
            this.spawnerHolder.current = undefined;
        }
    }

    // --- AgentSpawner ---
    async spawnDynamicTask(runId: string, role: AgentRole, prompt: string, dependsOn: string[] = []): Promise<{ taskId: string; status: string; output?: string; error?: string }> {
        const run = this.registry.getRun(runId);
        if (!run) { throw new Error(`Run ${runId} not found`); }
        const taskId = `dyn-${role}-${run.tasks.length + 1}`;
        const newTask: SubTask = { id: taskId, agent: role, prompt, dependsOn, status: 'pending' };
        run.tasks.push(newTask);
        this.registry.updateTask(runId, taskId, {});

        return new Promise(resolve => {
            this.spawnWaiters.set(taskId, { resolve });
        });
    }

    // --- helpers ---
    private parsePlan(text: string): PlanDocument | undefined {
        // Find first '{' and matching last '}'
        const start = text.indexOf('{');
        const end = text.lastIndexOf('}');
        if (start < 0 || end <= start) { return undefined; }
        try {
            const obj = JSON.parse(text.slice(start, end + 1)) as { tasks?: unknown };
            if (!Array.isArray(obj.tasks)) { return undefined; }
            const tasks: SubTask[] = [];
            for (const raw of obj.tasks as Array<Record<string, unknown>>) {
                if (!raw || typeof raw !== 'object') { continue; }
                const id = String(raw.id ?? '').trim();
                const agent = String(raw.agent ?? '').trim() as AgentRole;
                const prompt = String(raw.prompt ?? '').trim();
                if (!id || !prompt) { continue; }
                if (!AGENT_DEFINITIONS[agent] || agent === 'planner' || agent === 'orchestrator') { continue; }
                const dependsOn = Array.isArray(raw.dependsOn) ? (raw.dependsOn as unknown[]).map(String) : [];
                const units = Array.isArray(raw.units) ? (raw.units as unknown[]).map(String) : undefined;
                tasks.push({ id, agent, prompt, units, dependsOn, status: 'pending' });
            }
            return tasks.length > 0 ? { tasks } : undefined;
        } catch {
            return undefined;
        }
    }

    private applyAutoFanout(tasks: SubTask[], userPrompt: string): SubTask[] {
        const out: SubTask[] = [];
        const remap = new Map<string, string[]>(); // originalId -> child ids

        for (const t of tasks) {
            if (t.agent !== 'coder') { out.push(t); continue; }
            const split = splitCoderTask(t, userPrompt, this.maxParallelCoders);
            if (split.didSplit) {
                remap.set(t.id, split.replacements.map(r => r.id));
                out.push(...split.replacements);
            } else {
                out.push(t);
            }
        }

        // Rewire downstream dependencies: any task that depended on a split parent
        // now depends on ALL children.
        if (remap.size > 0) {
            for (const t of out) {
                const newDeps: string[] = [];
                for (const dep of t.dependsOn) {
                    const children = remap.get(dep);
                    if (children) { newDeps.push(...children); }
                    else { newDeps.push(dep); }
                }
                t.dependsOn = Array.from(new Set(newDeps));
            }
        }

        return out;
    }

    private hasCycle(tasks: SubTask[]): boolean {
        const byId = new Map(tasks.map(t => [t.id, t]));
        const WHITE = 0, GRAY = 1, BLACK = 2;
        const color = new Map<string, number>();
        for (const t of tasks) { color.set(t.id, WHITE); }
        const visit = (id: string): boolean => {
            const c = color.get(id);
            if (c === GRAY) { return true; }
            if (c === BLACK) { return false; }
            color.set(id, GRAY);
            const t = byId.get(id);
            if (t) {
                for (const dep of t.dependsOn) {
                    if (byId.has(dep) && visit(dep)) { return true; }
                }
            }
            color.set(id, BLACK);
            return false;
        };
        for (const t of tasks) {
            if (visit(t.id)) { return true; }
        }
        return false;
    }

    private renderPlan(tasks: SubTask[], stream: vscode.ChatResponseStream): void {
        stream.markdown(`**Plan (${tasks.length} tasks):**\n`);
        for (const t of tasks) {
            const deps = t.dependsOn.length > 0 ? ` _(depends on: ${t.dependsOn.join(', ')})_` : '';
            const unit = (t.units && t.units.length > 0) ? ` — _focus: ${t.units.join(', ').substring(0, 80)}_` : '';
            // Use the first non-empty line that isn't the FOCUS UNIT marker for the title
            const lines = t.prompt.split('\n').map(l => l.trim()).filter(l => l.length > 0 && !l.startsWith('FOCUS UNIT:'));
            const title = (lines[0] ?? t.prompt).substring(0, 100);
            stream.markdown(`- \`${t.id}\` **${t.agent}** — ${title}${unit}${deps}\n`);
        }
        stream.markdown('\n');
    }

    private renderSummary(tasks: SubTask[], stream: vscode.ChatResponseStream): void {
        const counts = { done: 0, failed: 0, pending: 0, running: 0 };
        for (const t of tasks) { counts[t.status]++; }
        stream.markdown(`\n### Summary\n`);
        stream.markdown(`Done: ${counts.done} · Failed: ${counts.failed}${counts.pending ? ` · Skipped: ${counts.pending}` : ''}\n\n`);
        for (const t of tasks) {
            const icon = t.status === 'done' ? '✓' : t.status === 'failed' ? '✗' : '·';
            stream.markdown(`**${icon} ${t.id} [${t.agent}]**\n`);
            if (t.output) {
                const snippet = t.output.length > 400 ? t.output.substring(0, 400) + '…' : t.output;
                stream.markdown(`\n${snippet}\n\n`);
            } else if (t.error) {
                stream.markdown(`\n_${t.error}_\n\n`);
            }
        }
    }

    private async executeDag(
        runId: string,
        tasks: SubTask[],
        agentRunner: SpecializedAgent,
        stream: vscode.ChatResponseStream,
        token: vscode.CancellationToken,
        toolInvocationToken?: vscode.ChatParticipantToolToken,
    ): Promise<void> {
        const byId = () => new Map(this.registry.getRun(runId)!.tasks.map(t => [t.id, t]));
        const inFlight = new Map<string, Promise<void>>();

        const isReady = (t: SubTask, idx: Map<string, SubTask>): boolean => {
            if (t.status !== 'pending') { return false; }
            for (const dep of t.dependsOn) {
                const d = idx.get(dep);
                if (!d || d.status !== 'done') { return false; }
            }
            return true;
        };

        const cascadeFail = (failedId: string, idx: Map<string, SubTask>) => {
            for (const t of idx.values()) {
                if (t.status === 'pending' && this.transitivelyDependsOn(t, failedId, idx)) {
                    this.registry.updateTask(runId, t.id, {
                        status: 'failed',
                        error: `Skipped: depends on failed task ${failedId}`,
                        finishedAt: Date.now(),
                    });
                    this.resolveSpawn(t.id, 'failed', undefined, `Skipped (dep ${failedId} failed)`);
                }
            }
        };

        const launchTask = (task: SubTask): Promise<void> => {
            this.registry.updateTask(runId, task.id, { status: 'running', startedAt: Date.now() });
            stream.markdown(`▶ \`${task.id}\` (${task.agent}) started\n`);

            const work = (async () => {
                try {
                    if (token.isCancellationRequested) {
                        throw new Error('cancelled');
                    }
                    const result = await agentRunner.runAgent(
                        task.agent,
                        task.prompt,
                        runId,
                        task.id,
                        token,
                        toolInvocationToken,
                    );
                    // Persist the agent's text output to shared memory automatically
                    if (result.text.trim()) {
                        await this.sharedStore.write(runId, `${task.agent}:${task.id}`, result.text.substring(0, 4000), task.agent);
                    }
                    this.registry.updateTask(runId, task.id, {
                        status: 'done',
                        output: result.text,
                        finishedAt: Date.now(),
                    });
                    stream.markdown(`✓ \`${task.id}\` done\n`);
                    this.resolveSpawn(task.id, 'done', result.text);
                } catch (e) {
                    const msg = e instanceof Error ? e.message : String(e);
                    this.registry.updateTask(runId, task.id, {
                        status: 'failed',
                        error: msg,
                        finishedAt: Date.now(),
                    });
                    stream.markdown(`✗ \`${task.id}\` failed: ${msg}\n`);
                    this.resolveSpawn(task.id, 'failed', undefined, msg);
                    cascadeFail(task.id, byId());
                } finally {
                    inFlight.delete(task.id);
                }
            })();

            inFlight.set(task.id, work);
            return work;
        };

        // Main loop
        while (true) {
            if (token.isCancellationRequested) {
                // Mark all pending/running as failed
                for (const t of byId().values()) {
                    if (t.status === 'pending' || t.status === 'running') {
                        this.registry.updateTask(runId, t.id, { status: 'failed', error: 'cancelled', finishedAt: Date.now() });
                        this.resolveSpawn(t.id, 'failed', undefined, 'cancelled');
                    }
                }
                break;
            }

            const idx = byId();
            const ready = Array.from(idx.values()).filter(t => isReady(t, idx));

            if (ready.length === 0) {
                if (inFlight.size === 0) { break; }
                // Wait for any in-flight to finish, then re-check
                await Promise.race(inFlight.values());
                continue;
            }

            // Launch all ready in parallel
            const launches = ready.map(t => launchTask(t));
            // Don't await all here — we want the loop to re-check as new dynamic
            // tasks may have been added by spawn_agent. Race on first completion.
            await Promise.race([...launches, ...inFlight.values()]);
        }

        // Drain any leftover (defensive)
        if (inFlight.size > 0) {
            await Promise.allSettled(inFlight.values());
        }
    }

    private transitivelyDependsOn(task: SubTask, ancestorId: string, idx: Map<string, SubTask>): boolean {
        const seen = new Set<string>();
        const stack = [...task.dependsOn];
        while (stack.length > 0) {
            const id = stack.pop()!;
            if (seen.has(id)) { continue; }
            seen.add(id);
            if (id === ancestorId) { return true; }
            const t = idx.get(id);
            if (t) { stack.push(...t.dependsOn); }
        }
        return false;
    }

    private resolveSpawn(taskId: string, status: string, output?: string, error?: string): void {
        const w = this.spawnWaiters.get(taskId);
        if (w) {
            w.resolve({ taskId, status, output, error });
            this.spawnWaiters.delete(taskId);
        }
    }
}
