import * as vscode from 'vscode';
import { MemoryEngine } from '../memory/MemoryEngine';

interface MemoryDeleteInput {
    id?: string;
    query?: string;
}

export class MemoryDeleteTool implements vscode.LanguageModelTool<MemoryDeleteInput> {
    constructor(private readonly memoryEngine: MemoryEngine) {}

    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<MemoryDeleteInput>,
        _token: vscode.CancellationToken,
    ): Promise<vscode.LanguageModelToolResult> {
        const { id, query } = options.input;

        // Delete by ID if provided
        if (id) {
            const deleted = await this.memoryEngine.deleteMemory(id);
            if (deleted) {
                return new vscode.LanguageModelToolResult([
                    new vscode.LanguageModelTextPart(`Memory entry ${id} deleted successfully.`),
                ]);
            }
            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart(`Memory entry with id "${id}" not found.`),
            ]);
        }

        // Search and delete by query
        if (query) {
            const matches = await this.memoryEngine.searchMemory(query, 'all');
            if (matches.length === 0) {
                return new vscode.LanguageModelToolResult([
                    new vscode.LanguageModelTextPart(`No memory entries matching "${query}" found.`),
                ]);
            }

            if (matches.length === 1) {
                await this.memoryEngine.deleteMemory(matches[0].id);
                return new vscode.LanguageModelToolResult([
                    new vscode.LanguageModelTextPart(`Deleted memory: [${matches[0].type}] ${matches[0].content}`),
                ]);
            }

            // Multiple matches — return list so model can pick
            const list = matches.map(m => `- id: ${m.id} | [${m.type}] ${m.content}`).join('\n');
            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart(
                    `Found ${matches.length} matching memories. Call again with a specific id to delete:\n${list}`
                ),
            ]);
        }

        return new vscode.LanguageModelToolResult([
            new vscode.LanguageModelTextPart('Please provide either an "id" or a "query" to identify the memory to delete.'),
        ]);
    }
}
