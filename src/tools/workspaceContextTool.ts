import * as vscode from 'vscode';
import { isPathInsideAny } from '../util/pathSafety';

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
        // Delegated to the shared `pathSafety` helper so symlinks are
        // resolved and Windows drive-letter casing differences don't cause
        // false negatives (or — more dangerously — false positives if a
        // symlink inside the workspace escapes it).
        return isPathInsideAny(fsPath, folders.map(wf => wf.uri.fsPath));
    }
}
