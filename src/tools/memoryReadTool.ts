import * as vscode from 'vscode';
import { MemoryEngine } from '../memory/MemoryEngine';
import { MemoryLayer } from '../memory/types';

export class MemoryReadTool implements vscode.LanguageModelTool<{ query?: string; layer?: MemoryLayer }> {
    constructor(private readonly memoryEngine: MemoryEngine) {}

    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<{ query?: string; layer?: MemoryLayer }>,
        _token: vscode.CancellationToken,
    ): Promise<vscode.LanguageModelToolResult> {
        const { query, layer } = options.input;

        let entries;
        if (query) {
            entries = await this.memoryEngine.searchMemory(query, layer ?? 'all');
        } else {
            const all = await this.memoryEngine.getAllMemories();
            entries = layer === 'daily' ? all.daily
                : layer === 'longterm' ? all.longterm
                : [...all.daily, ...all.longterm];
        }

        if (entries.length === 0) {
            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart('No matching memory entries found.'),
            ]);
        }

        const text = entries.map(e =>
            `[${e.type}] (importance: ${e.importance.toFixed(1)}) ${e.content} [tags: ${e.tags.join(', ')}]`
        ).join('\n');

        return new vscode.LanguageModelToolResult([
            new vscode.LanguageModelTextPart(`Found ${entries.length} memory entries:\n${text}`),
        ]);
    }
}
