import * as vscode from 'vscode';
import { RunRegistry } from '../agents/RunRegistry';

interface Input {
    runId: string;
    taskId?: string;
}

export class GetTaskStatusTool implements vscode.LanguageModelTool<Input> {
    constructor(private readonly registry: RunRegistry) {}

    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<Input>,
        _token: vscode.CancellationToken,
    ): Promise<vscode.LanguageModelToolResult> {
        const { runId, taskId } = options.input;
        const run = this.registry.getRun(runId);
        if (!run) {
            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart(`No run found for runId=${runId}.`),
            ]);
        }
        if (taskId) {
            const t = run.tasks.find(x => x.id === taskId);
            if (!t) {
                return new vscode.LanguageModelToolResult([
                    new vscode.LanguageModelTextPart(`Task ${taskId} not found in run ${runId}.`),
                ]);
            }
            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart(`Task ${t.id} (${t.agent}): status=${t.status}${t.error ? ` error=${t.error}` : ''}`),
            ]);
        }
        const lines = run.tasks.map(t =>
            `- ${t.id} [${t.agent}] -> ${t.status}${t.dependsOn.length ? ` (deps: ${t.dependsOn.join(', ')})` : ''}`
        );
        return new vscode.LanguageModelToolResult([
            new vscode.LanguageModelTextPart(`Run ${runId} status=${run.status}\n${lines.join('\n')}`),
        ]);
    }
}
