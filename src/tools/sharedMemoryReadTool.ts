import * as vscode from 'vscode';
import { SharedMemoryStore } from '../agents/SharedMemoryStore';

interface Input {
    runId: string;
    key?: string;
}

export class SharedMemoryReadTool implements vscode.LanguageModelTool<Input> {
    constructor(private readonly store: SharedMemoryStore) {}

    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<Input>,
        _token: vscode.CancellationToken,
    ): Promise<vscode.LanguageModelToolResult> {
        const { runId, key } = options.input;
        if (!runId) {
            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart('Error: "runId" is required.'),
            ]);
        }
        const values = await this.store.read(runId, key);
        if (values.length === 0) {
            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart(`No shared memory entries found for runId=${runId}${key ? `, key=${key}` : ''}.`),
            ]);
        }
        const text = values.map(v =>
            `[${v.writtenBy} @ ${new Date(v.writtenAt).toISOString()}] ${v.key} = ${v.value}`
        ).join('\n');
        return new vscode.LanguageModelToolResult([
            new vscode.LanguageModelTextPart(`${values.length} shared entries:\n${text}`),
        ]);
    }
}
