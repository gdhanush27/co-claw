import * as vscode from 'vscode';
import { MemoryPanel } from '../ui/memoryPanel';

export function registerShowMemoryCommand(memoryPanel: MemoryPanel): vscode.Disposable {
    return vscode.commands.registerCommand('CoClaw.showMemory', async () => {
        await memoryPanel.show();
    });
}
