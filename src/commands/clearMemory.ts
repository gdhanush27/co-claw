import * as vscode from 'vscode';
import { MemoryEngine } from '../memory/MemoryEngine';

export function registerClearMemoryCommand(memoryEngine: MemoryEngine): vscode.Disposable {
    return vscode.commands.registerCommand('CoClaw.clearMemory', async () => {
        const choice = await vscode.window.showWarningMessage(
            'Clear today\'s session memory?',
            { modal: true },
            'Clear',
        );

        if (choice === 'Clear') {
            await memoryEngine.clearDailyLogs();
            vscode.window.showInformationMessage('CoClaw: Session memory cleared.');
        }
    });
}
