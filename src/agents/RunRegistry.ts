import * as vscode from 'vscode';
import { RunState, SubTask, AgentStatus } from './types';

const MAX_COMPLETED_RUNS = 5;

/**
 * In-process registry of agent runs. Emits change events so the
 * sidebar TreeView can refresh live.
 */
export class RunRegistry {
    private readonly runs = new Map<string, RunState>();
    private readonly completedOrder: string[] = [];
    private activeRunId: string | undefined;

    private readonly _onDidChange = new vscode.EventEmitter<string | undefined>();
    readonly onDidChange = this._onDidChange.event;

    createRun(runId: string, userPrompt: string): RunState {
        const run: RunState = {
            runId,
            userPrompt,
            tasks: [],
            createdAt: Date.now(),
            status: 'pending',
        };
        this.runs.set(runId, run);
        this.activeRunId = runId;
        this._onDidChange.fire(runId);
        return run;
    }

    setTasks(runId: string, tasks: SubTask[]): void {
        const run = this.runs.get(runId);
        if (!run) { return; }
        run.tasks = tasks;
        run.status = 'running';
        this._onDidChange.fire(runId);
    }

    updateTask(runId: string, taskId: string, patch: Partial<SubTask>): void {
        const run = this.runs.get(runId);
        if (!run) { return; }
        const task = run.tasks.find(t => t.id === taskId);
        if (!task) { return; }
        Object.assign(task, patch);
        this._onDidChange.fire(runId);
    }

    completeRun(runId: string, status: AgentStatus): void {
        const run = this.runs.get(runId);
        if (!run) { return; }
        run.status = status;
        run.completedAt = Date.now();
        if (this.activeRunId === runId) { this.activeRunId = undefined; }
        this.completedOrder.push(runId);
        this.evictOldCompleted();
        this._onDidChange.fire(runId);
    }

    private evictOldCompleted(): void {
        while (this.completedOrder.length > MAX_COMPLETED_RUNS) {
            const oldId = this.completedOrder.shift();
            if (oldId) { this.runs.delete(oldId); }
        }
    }

    getRun(runId: string): RunState | undefined {
        return this.runs.get(runId);
    }

    getActiveRun(): RunState | undefined {
        return this.activeRunId ? this.runs.get(this.activeRunId) : undefined;
    }

    getAllRuns(): RunState[] {
        // Active first, then completed newest-first
        const all = Array.from(this.runs.values());
        return all.sort((a, b) => (b.createdAt - a.createdAt));
    }

    dispose(): void {
        this._onDidChange.dispose();
    }
}
