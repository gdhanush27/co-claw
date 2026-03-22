import * as vscode from 'vscode';
import { MemoryEngine } from '../memory/MemoryEngine';

export function registerClearMemoryCommand(memoryEngine: MemoryEngine): vscode.Disposable {
    return vscode.commands.registerCommand('CoClaw.clearMemory', async () => {
        const choice = await vscode.window.showWarningMessage(
            'What would you like to clear?',
            { modal: true },
            'Daily Only',
            'Long-Term Only',
            'All Memory',
        );

        if (choice === 'Daily Only') {
            await memoryEngine.clearDailyLogs();
            vscode.window.showInformationMessage('CoClaw: Daily memory cleared.');
        } else if (choice === 'Long-Term Only') {
            await memoryEngine.clearLongTermMemory();
            vscode.window.showInformationMessage('CoClaw: Long-term memory cleared.');
        } else if (choice === 'All Memory') {
            await memoryEngine.clearAllMemory();
            vscode.window.showInformationMessage('CoClaw: All memory cleared.');
        }
    });
}
