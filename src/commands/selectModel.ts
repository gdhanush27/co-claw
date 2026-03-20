import * as vscode from 'vscode';
import { ModelManager } from '../lm/ModelManager';
import { StatusBar } from '../ui/statusBar';

export function registerSelectModelCommand(
    modelManager: ModelManager,
    statusBar: StatusBar,
): vscode.Disposable {
    return vscode.commands.registerCommand('CoClaw.selectModel', async () => {
        const model = await modelManager.selectModelViaQuickPick();
        if (model) {
            await statusBar.update();
            vscode.window.showInformationMessage(`CoClaw: Switched to ${model.name} (${model.family})`);
        }
    });
}
