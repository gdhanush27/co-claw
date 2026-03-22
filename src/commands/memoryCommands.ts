import * as vscode from 'vscode';
import { MemoryEngine } from '../memory/MemoryEngine';

export function registerDistillCommand(memoryEngine: MemoryEngine): vscode.Disposable {
    return vscode.commands.registerCommand('CoClaw.distill', async () => {
        const tokenSource = new vscode.CancellationTokenSource();
        try {
            const count = await memoryEngine.distill(tokenSource.token);
            // Auto-dedup after distill to clean up any duplicates
            const removed = await memoryEngine.deduplicateLongTerm();
            if (count > 0) {
                const msg = removed > 0
                    ? `CoClaw: Distilled ${count} entries into long-term memory (removed ${removed} duplicates).`
                    : `CoClaw: Distilled ${count} entries into long-term memory.`;
                vscode.window.showInformationMessage(msg);
            } else {
                vscode.window.showInformationMessage('CoClaw: No entries to distill.');
            }
        } finally {
            tokenSource.dispose();
        }
    });
}

export function registerImportCommand(memoryEngine: MemoryEngine): vscode.Disposable {
    return vscode.commands.registerCommand('CoClaw.importMemories', async () => {
        const uris = await vscode.window.showOpenDialog({
            canSelectFiles: true,
            canSelectMany: false,
            filters: { 'JSON Files': ['json'] },
            title: 'Import Memories',
        });

        if (!uris || uris.length === 0) { return; }

        try {
            const data = await vscode.workspace.fs.readFile(uris[0]);
            const parsed = JSON.parse(Buffer.from(data).toString('utf-8'));

            if (!Array.isArray(parsed)) {
                vscode.window.showErrorMessage('CoClaw: Import file must contain a JSON array of memory entries.');
                return;
            }

            let imported = 0;
            const validTypes = ['fact', 'decision', 'preference', 'code_context', 'convention', 'pattern'];
            const maxContentLength = 2000;
            const maxTagLength = 50;
            const maxTags = 20;
            for (const item of parsed) {
                if (typeof item.content === 'string'
                    && typeof item.type === 'string'
                    && validTypes.includes(item.type)
                    && item.content.length <= maxContentLength) {
                    const tags = Array.isArray(item.tags)
                        ? item.tags.filter((t: unknown) => typeof t === 'string' && (t as string).length <= maxTagLength).slice(0, maxTags)
                        : [];
                    const importance = typeof item.importance === 'number'
                        ? Math.max(0, Math.min(1, item.importance))
                        : 0.5;
                    await memoryEngine.writeMemory(
                        item.content,
                        item.type,
                        importance,
                        tags,
                        'manual',
                        'longterm',
                    );
                    imported++;
                }
            }

            vscode.window.showInformationMessage(`CoClaw: Imported ${imported} memories.`);
        } catch (e) {
            vscode.window.showErrorMessage(`CoClaw: Failed to import — ${e instanceof Error ? e.message : String(e)}`);
        }
    });
}

export function registerExportCommand(memoryEngine: MemoryEngine): vscode.Disposable {
    return vscode.commands.registerCommand('CoClaw.exportMemories', async () => {
        const uri = await vscode.window.showSaveDialog({
            filters: { 'JSON Files': ['json'] },
            title: 'Export Memories',
            defaultUri: vscode.Uri.file('CoClaw-memories.json'),
        });

        if (!uri) { return; }

        try {
            const { daily, longterm } = await memoryEngine.getAllMemories();
            const allEntries = [...longterm, ...daily];
            await vscode.workspace.fs.writeFile(uri, Buffer.from(JSON.stringify(allEntries, null, 2), 'utf-8'));
            vscode.window.showInformationMessage(`CoClaw: Exported ${allEntries.length} memories.`);
        } catch (e) {
            vscode.window.showErrorMessage(`CoClaw: Failed to export — ${e instanceof Error ? e.message : String(e)}`);
        }
    });
}

export function registerDeduplicateCommand(memoryEngine: MemoryEngine): vscode.Disposable {
    return vscode.commands.registerCommand('CoClaw.deduplicateMemory', async () => {
        const [longtermRemoved, dailyRemoved] = await Promise.all([
            memoryEngine.deduplicateLongTerm(),
            memoryEngine.deduplicateDaily(),
        ]);
        const total = longtermRemoved + dailyRemoved;
        if (total > 0) {
            vscode.window.showInformationMessage(`CoClaw: Removed ${total} duplicate memories (${longtermRemoved} long-term, ${dailyRemoved} daily).`);
        } else {
            vscode.window.showInformationMessage('CoClaw: No duplicates found.');
        }
    });
}
