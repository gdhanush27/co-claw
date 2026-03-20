import * as vscode from 'vscode';
import { randomBytes } from 'crypto';
import { MemoryEngine } from '../memory/MemoryEngine';
import { MemoryEntry } from '../memory/types';

export class MemoryPanel {
    private panel: vscode.WebviewPanel | undefined;

    constructor(
        private readonly memoryEngine: MemoryEngine,
        private readonly extensionUri: vscode.Uri,
    ) {}

    async show(): Promise<void> {
        if (this.panel) {
            this.panel.reveal();
            await this.refresh();
            return;
        }

        this.panel = vscode.window.createWebviewPanel(
            'CoClawMemory',
            'CoClaw Memory',
            vscode.ViewColumn.One,
            {
                enableScripts: true,
                retainContextWhenHidden: true,
            },
        );

        this.panel.onDidDispose(() => {
            this.panel = undefined;
        });

        this.panel.webview.onDidReceiveMessage(async (msg) => {
            switch (msg.command) {
                case 'delete':
                    await this.memoryEngine.deleteMemory(msg.id);
                    await this.refresh();
                    break;
                case 'promote':
                    await this.memoryEngine.promoteToLongTerm(msg.id);
                    await this.refresh();
                    break;
                case 'updateImportance':
                    await this.memoryEngine.longTermMemory.updateImportance(msg.id, msg.importance);
                    await this.refresh();
                    break;
                case 'refresh':
                    await this.refresh();
                    break;
            }
        });

        await this.refresh();
    }

    private async refresh(): Promise<void> {
        if (!this.panel) { return; }

        const { daily, longterm } = await this.memoryEngine.getAllMemories();
        this.panel.webview.html = this.getHtml(daily, longterm);
    }

    private getHtml(daily: MemoryEntry[], longterm: MemoryEntry[]): string {
        const nonce = randomBytes(16).toString('base64');
        const escape = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

        const renderEntry = (entry: MemoryEntry, layer: string) => `
            <tr data-id="${escape(entry.id)}" data-layer="${layer}">
                <td><span class="badge badge-${escape(entry.type)}">${escape(entry.type)}</span></td>
                <td>${escape(entry.content)}</td>
                <td>${escape(entry.tags.join(', '))}</td>
                <td>
                    <input type="range" min="0" max="1" step="0.1" value="${entry.importance}"
                        data-action="updateImportance" data-id="${escape(entry.id)}"
                        ${layer === 'daily' ? 'disabled' : ''} />
                    <span>${entry.importance.toFixed(1)}</span>
                </td>
                <td>${new Date(entry.createdAt).toLocaleDateString()}</td>
                <td>
                    ${layer === 'daily' ? `<button class="btn btn-promote" data-action="promote" data-id="${escape(entry.id)}">Promote</button>` : ''}
                    <button class="btn btn-delete" data-action="delete" data-id="${escape(entry.id)}">Delete</button>
                </td>
            </tr>`;

        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';" />
    <title>CoClaw Memory</title>
    <style nonce="${nonce}">
        body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); background: var(--vscode-editor-background); padding: 16px; }
        h1 { font-size: 1.4em; margin-bottom: 8px; }
        h2 { font-size: 1.1em; margin-top: 24px; margin-bottom: 8px; color: var(--vscode-descriptionForeground); }
        .stats { margin-bottom: 16px; color: var(--vscode-descriptionForeground); }
        table { width: 100%; border-collapse: collapse; margin-bottom: 16px; }
        th, td { text-align: left; padding: 6px 10px; border-bottom: 1px solid var(--vscode-widget-border); }
        th { font-weight: 600; color: var(--vscode-descriptionForeground); font-size: 0.85em; text-transform: uppercase; }
        .badge { padding: 2px 6px; border-radius: 3px; font-size: 0.8em; font-weight: 600; }
        .badge-fact { background: var(--vscode-charts-blue); color: white; }
        .badge-decision { background: var(--vscode-charts-orange); color: white; }
        .badge-preference { background: var(--vscode-charts-green); color: white; }
        .badge-code_context { background: var(--vscode-charts-purple); color: white; }
        .badge-convention { background: var(--vscode-charts-yellow); color: black; }
        .badge-pattern { background: var(--vscode-charts-red); color: white; }
        .btn { padding: 3px 8px; border: 1px solid var(--vscode-button-border); border-radius: 3px; cursor: pointer; font-size: 0.85em; }
        .btn-delete { background: transparent; color: var(--vscode-errorForeground); }
        .btn-delete:hover { background: var(--vscode-errorForeground); color: white; }
        .btn-promote { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; }
        .btn-promote:hover { background: var(--vscode-button-hoverBackground); }
        .btn-refresh { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; padding: 6px 12px; cursor: pointer; border-radius: 3px; }
        input[type="range"] { width: 60px; vertical-align: middle; }
        .filter { margin-bottom: 12px; }
        .filter input { padding: 4px 8px; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border); border-radius: 3px; width: 250px; }
        .empty { color: var(--vscode-descriptionForeground); font-style: italic; padding: 16px 0; }
    </style>
</head>
<body>
    <h1>CoClaw Memory Browser</h1>
    <div class="stats">
        Long-term: ${longterm.length} entries | Daily logs: ${daily.length} entries
        <button class="btn-refresh" data-action="refresh" style="margin-left: 12px;">Refresh</button>
    </div>
    <div class="filter">
        <input type="text" id="filterInput" placeholder="Filter entries..." />
    </div>

    <h2>Long-Term Memory</h2>
    ${longterm.length === 0 ? '<p class="empty">No long-term memories yet.</p>' : `
    <table id="longtermTable">
        <thead>
            <tr><th>Type</th><th>Content</th><th>Tags</th><th>Importance</th><th>Created</th><th>Actions</th></tr>
        </thead>
        <tbody>
            ${longterm.map(e => renderEntry(e, 'longterm')).join('')}
        </tbody>
    </table>`}

    <h2>Daily Session Log</h2>
    ${daily.length === 0 ? '<p class="empty">No daily log entries yet.</p>' : `
    <table id="dailyTable">
        <thead>
            <tr><th>Type</th><th>Content</th><th>Tags</th><th>Importance</th><th>Created</th><th>Actions</th></tr>
        </thead>
        <tbody>
            ${daily.map(e => renderEntry(e, 'daily')).join('')}
        </tbody>
    </table>`}

    <script nonce="${nonce}">
        const vscode = acquireVsCodeApi();

        document.addEventListener('click', (e) => {
            const target = e.target.closest('[data-action]');
            if (!target) { return; }
            const action = target.dataset.action;
            const id = target.dataset.id;
            switch (action) {
                case 'delete': vscode.postMessage({ command: 'delete', id }); break;
                case 'promote': vscode.postMessage({ command: 'promote', id }); break;
                case 'refresh': vscode.postMessage({ command: 'refresh' }); break;
            }
        });

        document.addEventListener('input', (e) => {
            const target = e.target;
            if (target.dataset && target.dataset.action === 'updateImportance') {
                vscode.postMessage({ command: 'updateImportance', id: target.dataset.id, importance: parseFloat(target.value) });
            }
            if (target.id === 'filterInput') {
                const lower = target.value.toLowerCase();
                document.querySelectorAll('tbody tr').forEach(row => {
                    row.style.display = row.textContent.toLowerCase().includes(lower) ? '' : 'none';
                });
            }
        });
    </script>
</body>
</html>`;
    }

    dispose(): void {
        this.panel?.dispose();
    }
}
