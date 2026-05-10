export type AgentRole = 'planner' | 'coder' | 'reviewer' | 'tester' | 'memory' | 'orchestrator';

export type AgentStatus = 'pending' | 'running' | 'done' | 'failed';

export interface SubTask {
    id: string;
    agent: AgentRole;
    prompt: string;
    /** Optional list of file paths or feature slices the planner suggests. */
    units?: string[];
    dependsOn: string[];
    status: AgentStatus;
    output?: string;
    error?: string;
    startedAt?: number;
    finishedAt?: number;
}

export interface PlanDocument {
    tasks: SubTask[];
}

export interface RunState {
    runId: string;
    userPrompt: string;
    tasks: SubTask[];
    createdAt: number;
    completedAt?: number;
    status: AgentStatus;
}

export interface SharedValue {
    key: string;
    value: string;
    writtenBy: AgentRole;
    writtenAt: number;
}
