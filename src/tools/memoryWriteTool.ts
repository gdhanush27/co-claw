import * as vscode from 'vscode';
import { MemoryEngine } from '../memory/MemoryEngine';
import { MemoryEntryType } from '../memory/types';

interface MemoryWriteInput {
    content: string;
    type: MemoryEntryType;
    importance?: number;
}

export class MemoryWriteTool implements vscode.LanguageModelTool<MemoryWriteInput> {
    constructor(private readonly memoryEngine: MemoryEngine) {}

    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<MemoryWriteInput>,
        _token: vscode.CancellationToken,
    ): Promise<vscode.LanguageModelToolResult> {
        const { content, type, importance } = options.input;

        const entry = await this.memoryEngine.writeMemory(
            content,
            type,
            importance ?? 0.5,
            [],
            'manual',
            'longterm',
        );

        return new vscode.LanguageModelToolResult([
            new vscode.LanguageModelTextPart(
                `Memory saved successfully (id: ${entry.id}, type: ${entry.type}, importance: ${entry.importance}).`
            ),
        ]);
    }
}
