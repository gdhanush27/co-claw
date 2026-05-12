import * as vscode from 'vscode';
import { AgentRole, TaskDifficulty } from '../agents/types';

const VALID_DIFFICULTIES: ReadonlySet<TaskDifficulty> = new Set(['light', 'medium', 'hard']);

export interface AgentSpawner {
    /**
     * Spawn a new agent task within the active run. Returns the new task id.
     * Resolves once the dynamic task has finished (done or failed).
     */
    spawnDynamicTask(
        runId: string,
        role: AgentRole,
        prompt: string,
        dependsOn?: string[],
        difficulty?: TaskDifficulty,
    ): Promise<{ taskId: string; status: string; output?: string; error?: string }>;
}

interface Input {
    runId: string;
    agent: AgentRole;
    prompt: string;
    dependsOn?: string[];
    difficulty?: string;
}

export class SpawnAgentTool implements vscode.LanguageModelTool<Input> {
    constructor(private readonly spawner: { current: AgentSpawner | undefined }) {}

    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<Input>,
        _token: vscode.CancellationToken,
    ): Promise<vscode.LanguageModelToolResult> {
        const { runId, agent: rawAgent, prompt, dependsOn, difficulty } = options.input;
        const sp = this.spawner.current;
        if (!sp) {
            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart('Error: no active orchestrator. spawn_agent can only be used during an active multi-agent run.'),
            ]);
        }
        if (!runId || !rawAgent || !prompt) {
            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart('Error: "runId", "agent", and "prompt" are required.'),
            ]);
        }
        // Normalize the role to lowercase before comparing. The role denylist
        // below is a security boundary — a case-sensitive comparison can be
        // bypassed by a model emitting `Orchestrator` or `PLANNER`, which then
        // recurses into a planner sub-task or escapes the agent sandbox.
        const agent = String(rawAgent).trim().toLowerCase() as AgentRole;
        if (agent === 'orchestrator' || agent === 'planner') {
            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart(`Error: cannot spawn ${agent} as a dynamic task.`),
            ]);
        }
        const KNOWN_AGENTS: ReadonlySet<AgentRole> = new Set<AgentRole>(['coder', 'reviewer', 'tester', 'memory']);
        if (!KNOWN_AGENTS.has(agent)) {
            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart(`Error: unknown agent role "${rawAgent}". Expected one of: coder, reviewer, tester, memory.`),
            ]);
        }
        // Validate the optional `difficulty` field against the allow-list so
        // unknown values fall through to the default tier instead of
        // poisoning per-task model routing downstream.
        let coercedDifficulty: TaskDifficulty | undefined;
        if (difficulty !== undefined) {
            const v = String(difficulty).trim().toLowerCase();
            if (!VALID_DIFFICULTIES.has(v as TaskDifficulty)) {
                return new vscode.LanguageModelToolResult([
                    new vscode.LanguageModelTextPart(
                        `Error: invalid "difficulty" value "${difficulty}". Expected one of: light, medium, hard.`,
                    ),
                ]);
            }
            coercedDifficulty = v as TaskDifficulty;
        }
        try {
            const result = await sp.spawnDynamicTask(runId, agent, prompt, dependsOn ?? [], coercedDifficulty);
            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart(
                    `Spawned ${agent} task ${result.taskId} -> ${result.status}\n${result.output ?? result.error ?? ''}`
                ),
            ]);
        } catch (e) {
            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart(`Spawn failed: ${e instanceof Error ? e.message : String(e)}`),
            ]);
        }
    }
}
