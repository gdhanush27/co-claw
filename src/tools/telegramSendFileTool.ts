import * as vscode from 'vscode';
import * as path from 'path';
import { TelegramBot } from '../telegram/TelegramBot';

interface Input {
    /** Workspace-relative path (preferred) or absolute path inside the workspace. */
    path: string;
    /** Optional caption (HTML, max ~1000 chars). */
    caption?: string;
}

const MAX_BYTES = 50 * 1024 * 1024; // Telegram bot upload limit

/**
 * Lets the model send a file from the workspace to the linked Telegram user.
 * Path is constrained to the current workspace folder for safety.
 */
export class TelegramSendFileTool implements vscode.LanguageModelTool<Input> {
    constructor(private readonly bot: TelegramBot) {}

    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<Input>,
        _token: vscode.CancellationToken,
    ): Promise<vscode.LanguageModelToolResult> {
        const { path: rawPath, caption } = options.input;
        if (!rawPath || typeof rawPath !== 'string') {
            return text('Error: "path" is required.');
        }
        const folders = vscode.workspace.workspaceFolders;
        if (!folders || folders.length === 0) {
            return text('Error: no workspace folder open.');
        }
        const root = folders[0].uri;
        const rootFs = root.fsPath;

        // Resolve to an absolute path inside the workspace.
        const abs = path.isAbsolute(rawPath) ? path.normalize(rawPath) : path.normalize(path.join(rootFs, rawPath));
        const relCheck = path.relative(rootFs, abs);
        if (relCheck.startsWith('..') || path.isAbsolute(relCheck)) {
            return text(`Error: path must be inside the workspace folder. Got: ${rawPath}`);
        }

        let content: Uint8Array;
        try {
            content = await vscode.workspace.fs.readFile(vscode.Uri.file(abs));
        } catch (err) {
            return text(`Error: could not read file "${rawPath}": ${err instanceof Error ? err.message : String(err)}`);
        }
        if (content.byteLength > MAX_BYTES) {
            return text(`Error: file too large (${content.byteLength} bytes). Telegram bot upload limit is 50 MB.`);
        }

        const fileName = path.basename(abs);
        try {
            const ok = await this.bot.sendFileToAuthorizedUser(
                fileName,
                Buffer.from(content),
                caption,
            );
            if (!ok) {
                return text('Error: Telegram bot is not running or no user is linked. Run /linkTelegram first.');
            }
            return text(`Sent file "${fileName}" (${content.byteLength} bytes) to Telegram.`);
        } catch (err) {
            return text(`Error sending file: ${err instanceof Error ? err.message : String(err)}`);
        }
    }
}

function text(s: string): vscode.LanguageModelToolResult {
    return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(s)]);
}
