import * as vscode from 'vscode';
import { MemoryEngine } from '../memory/MemoryEngine';
import { MemoryEntryType } from '../memory/types';

interface MemoryUpdateInput {
    id?: string;
    query?: string;
    content?: string;
    type?: MemoryEntryType;
    importance?: number;
}

export class MemoryUpdateTool implements vscode.LanguageModelTool<MemoryUpdateInput> {
    constructor(private readonly memoryEngine: MemoryEngine) {}

    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<MemoryUpdateInput>,
        _token: vscode.CancellationToken,
    ): Promise<vscode.LanguageModelToolResult> {
        const { id, query, content, type, importance } = options.input;

        // Find the target entry
        let targetId = id;
        if (!targetId && query) {
            const matches = await this.memoryEngine.searchMemory(query, 'all');
            if (matches.length === 0) {
                return new vscode.LanguageModelToolResult([
                    new vscode.LanguageModelTextPart(`No memory entries matching "${query}" found.`),
                ]);
            }
            if (matches.length > 1) {
                const list = matches.map(m => `- id: ${m.id} | [${m.type}] ${m.content}`).join('\n');
                return new vscode.LanguageModelToolResult([
                    new vscode.LanguageModelTextPart(
                        `Found ${matches.length} matching memories. Call again with a specific id:\n${list}`
                    ),
                ]);
            }
            targetId = matches[0].id;
        }

        if (!targetId) {
            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart('Please provide either an "id" or a "query" to identify the memory to update.'),
            ]);
        }

        // Try to update: delete old entry and create new one with updated fields
        const { daily, longterm } = await this.memoryEngine.getAllMemories();
        const all = [...daily, ...longterm];
        const existing = all.find(e => e.id === targetId);

        if (!existing) {
            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart(`Memory entry with id "${targetId}" not found.`),
            ]);
        }

        // Delete old entry
        await this.memoryEngine.deleteMemory(targetId);

        // Determine which layer the entry was in
        const wasLongterm = longterm.some(e => e.id === targetId);

        // Create updated entry
        const newEntry = await this.memoryEngine.writeMemory(
            content ?? existing.content,
            type ?? existing.type,
            importance ?? existing.importance,
            existing.tags,
            existing.source,
            wasLongterm ? 'longterm' : 'daily',
        );

        return new vscode.LanguageModelToolResult([
            new vscode.LanguageModelTextPart(
                `Memory updated successfully (new id: ${newEntry.id}). Content: [${newEntry.type}] ${newEntry.content}`
            ),
        ]);
    }
}
