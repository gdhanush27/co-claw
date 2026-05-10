import * as vscode from 'vscode';
import { SharedMemoryStore } from '../agents/SharedMemoryStore';
import { AgentRole } from '../agents/types';

interface Input {
    runId: string;
    key: string;
    value: string;
    writtenBy?: AgentRole;
}

export class SharedMemoryWriteTool implements vscode.LanguageModelTool<Input> {
    constructor(private readonly store: SharedMemoryStore) {}

    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<Input>,
        _token: vscode.CancellationToken,
    ): Promise<vscode.LanguageModelToolResult> {
        const { runId, key, value, writtenBy } = options.input;
        if (!runId || !key || value === undefined) {
            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart('Error: "runId", "key", and "value" are required.'),
            ]);
        }
        await this.store.write(runId, key, value, writtenBy ?? 'coder');
        return new vscode.LanguageModelToolResult([
            new vscode.LanguageModelTextPart(`Wrote shared memory: ${key}`),
        ]);
    }
}
