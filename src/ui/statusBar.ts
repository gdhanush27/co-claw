import * as vscode from 'vscode';
import { ModelManager } from '../lm/ModelManager';
import { MemoryEngine } from '../memory/MemoryEngine';

export class StatusBar {
    private readonly item: vscode.StatusBarItem;
    private busy = false;
    private memoryCount = { daily: 0, longterm: 0 };
    private memoryEngine?: MemoryEngine;

    constructor(private readonly modelManager: ModelManager) {
        this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
        this.item.command = 'CoClaw.selectModel';
        this.item.tooltip = 'CoClaw: Click to switch model';
    }

    setMemoryEngine(engine: MemoryEngine): void {
        this.memoryEngine = engine;
    }

    async update(): Promise<void> {
        const family = this.modelManager.getPreferredFamily();

        // Refresh memory count
        if (this.memoryEngine) {
            try {
                this.memoryCount = await this.memoryEngine.getMemoryCount();
            } catch { /* silent */ }
        }

        const memInfo = `\u{1F9E0} ${this.memoryCount.longterm}LT / ${this.memoryCount.daily}D`;

        if (this.busy) {
            this.item.text = `$(debug-stop) Stop ${family || 'CoClaw'}`;
            this.item.tooltip = `CoClaw: Click to stop response\n${memInfo}`;
            this.item.command = 'CoClaw.stop';
            this.item.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
        } else {
            this.item.text = `$(hubot) ${family || 'CoClaw'} | ${this.memoryCount.longterm}M`;
            this.item.tooltip = `CoClaw: Click to switch model\n${memInfo}`;
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
