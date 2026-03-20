import * as vscode from 'vscode';
import { ModelManager } from '../lm/ModelManager';

export class StatusBar {
    private readonly item: vscode.StatusBarItem;
    private busy = false;

    constructor(private readonly modelManager: ModelManager) {
        this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
        this.item.command = 'CoClaw.selectModel';
        this.item.tooltip = 'CoClaw: Click to switch model';
    }

    async update(): Promise<void> {
        const family = this.modelManager.getPreferredFamily();
        if (this.busy) {
            this.item.text = `$(debug-stop) Stop ${family || 'CoClaw'}`;
            this.item.tooltip = 'CoClaw: Click to stop response';
            this.item.command = 'CoClaw.stop';
            this.item.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
        } else {
            this.item.text = `$(hubot) ${family || 'CoClaw'}`;
            this.item.tooltip = 'CoClaw: Click to switch model';
            this.item.command = 'CoClaw.selectModel';
            this.item.backgroundColor = undefined;
        }
        this.item.show();
    }

    setBusy(busy: boolean): void {
        this.busy = busy;
        this.update();
    }

    show(): void {
        this.item.show();
    }

    hide(): void {
        this.item.hide();
    }

    dispose(): void {
        this.item.dispose();
    }
}
