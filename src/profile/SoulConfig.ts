import * as vscode from 'vscode';
import { SoulConfigData } from '../memory/types';

const DEFAULT_SOUL: SoulConfigData = {
    name: 'CoClaw',
    role: 'AI pair programmer with persistent memory',
    instructions: 'You remember past conversations. Reference stored memories when relevant. Be concise and helpful.',
    tone: 'professional, direct',
};

export class SoulConfig {
    constructor(private readonly storageUri: vscode.Uri) {}

    private get fileUri(): vscode.Uri {
        return vscode.Uri.joinPath(this.storageUri, 'profile', 'SOUL.json');
    }

    async load(): Promise<SoulConfigData> {
        try {
            const data = await vscode.workspace.fs.readFile(this.fileUri);
            return { ...DEFAULT_SOUL, ...JSON.parse(Buffer.from(data).toString('utf-8')) };
        } catch {
            return { ...DEFAULT_SOUL };
        }
    }

    async save(config: SoulConfigData): Promise<void> {
        const dir = vscode.Uri.joinPath(this.storageUri, 'profile');
        try {
            await vscode.workspace.fs.createDirectory(dir);
        } catch {
            // directory may already exist
        }
        await vscode.workspace.fs.writeFile(this.fileUri, Buffer.from(JSON.stringify(config, null, 2), 'utf-8'));
    }

    async openInEditor(): Promise<void> {
        // Ensure file exists
        try {
            await vscode.workspace.fs.readFile(this.fileUri);
        } catch {
            await this.save(await this.load());
        }
        const doc = await vscode.workspace.openTextDocument(this.fileUri);
        await vscode.window.showTextDocument(doc);
    }
}
