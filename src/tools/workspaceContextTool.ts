import * as vscode from 'vscode';
import * as path from 'path';

export class WorkspaceContextTool implements vscode.LanguageModelTool<Record<string, never>> {
    async invoke(
        _options: vscode.LanguageModelToolInvocationOptions<Record<string, never>>,
        _token: vscode.CancellationToken,
    ): Promise<vscode.LanguageModelToolResult> {
        const workspaceFolders = vscode.workspace.workspaceFolders ?? [];
        const editor = vscode.window.activeTextEditor;

        // Only include tabs whose files are inside a workspace folder
        const openTabs = vscode.window.tabGroups.all
            .flatMap(g => g.tabs)
            .map(t => {
                const input = t.input;
                if (input && typeof input === 'object' && 'uri' in input) {
                    return (input as { uri: vscode.Uri }).uri.fsPath;
                }
                return undefined;
            })
            .filter((fsPath): fsPath is string => {
                if (!fsPath) { return false; }
                return this.isInsideWorkspace(fsPath, workspaceFolders);
            });

        const context: Record<string, unknown> = {
            workspaceFolders: workspaceFolders.map(f => f.uri.fsPath),
            openTabs: openTabs.slice(0, 20), // limit to 20
        };

        if (editor && this.isInsideWorkspace(editor.document.uri.fsPath, workspaceFolders)) {
            context.activeFile = editor.document.uri.fsPath;
            context.language = editor.document.languageId;
            context.lineCount = editor.document.lineCount;

            const selection = editor.selection;
            if (!selection.isEmpty) {
                context.selectedText = editor.document.getText(selection).substring(0, 2000);
            }
        }

        return new vscode.LanguageModelToolResult([
            new vscode.LanguageModelTextPart(JSON.stringify(context, null, 2)),
        ]);
    }

    private isInsideWorkspace(fsPath: string, folders: readonly vscode.WorkspaceFolder[]): boolean {
        const normalized = path.normalize(fsPath);
        return folders.some(wf => {
            const root = path.normalize(wf.uri.fsPath);
            return normalized.startsWith(root + path.sep) || normalized === root;
        });
    }
}
