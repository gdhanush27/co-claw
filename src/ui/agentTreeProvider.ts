import * as vscode from 'vscode';
import { RunRegistry } from '../agents/RunRegistry';
import { AgentStatus, RunState, SubTask } from '../agents/types';

type TreeNode =
    | { kind: 'run'; run: RunState }
    | { kind: 'task'; runId: string; task: SubTask };

export class AgentTreeProvider implements vscode.TreeDataProvider<TreeNode> {
    private readonly _onDidChangeTreeData = new vscode.EventEmitter<TreeNode | undefined>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;
    private readonly disposables: vscode.Disposable[] = [];

    constructor(private readonly registry: RunRegistry) {
        this.disposables.push(
            this.registry.onDidChange(() => this._onDidChangeTreeData.fire(undefined)),
        );
    }

    getTreeItem(node: TreeNode): vscode.TreeItem {
        if (node.kind === 'run') {
            const run = node.run;
            const label = `Run ${run.runId.substring(0, 8)} — ${run.status}`;
            const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.Expanded);
            item.description = run.userPrompt.substring(0, 80);
            item.tooltip = run.userPrompt;
            item.iconPath = statusIcon(run.status);
            item.contextValue = 'CoClaw.agentRun';
            return item;
        }
        const task = node.task;
        const item = new vscode.TreeItem(`${task.id} [${task.agent}]`, vscode.TreeItemCollapsibleState.None);
        item.description = task.status + (task.dependsOn.length ? ` · deps: ${task.dependsOn.join(', ')}` : '');
        item.tooltip = task.error ?? task.output ?? task.prompt;
        item.iconPath = statusIcon(task.status);
        item.contextValue = 'CoClaw.agentTask';
        return item;
    }

    getChildren(node?: TreeNode): TreeNode[] {
        if (!node) {
            return this.registry.getAllRuns().map(run => ({ kind: 'run', run } as TreeNode));
        }
        if (node.kind === 'run') {
            return node.run.tasks.map(task => ({ kind: 'task', runId: node.run.runId, task } as TreeNode));
        }
        return [];
    }

    dispose(): void {
        this._onDidChangeTreeData.dispose();
        for (const d of this.disposables) { d.dispose(); }
    }
}

function statusIcon(status: AgentStatus): vscode.ThemeIcon {
    switch (status) {
        case 'pending': return new vscode.ThemeIcon('circle-outline');
        case 'running': return new vscode.ThemeIcon('sync~spin');
        case 'done': return new vscode.ThemeIcon('pass', new vscode.ThemeColor('charts.green'));
        case 'failed': return new vscode.ThemeIcon('error', new vscode.ThemeColor('charts.red'));
    }
}
