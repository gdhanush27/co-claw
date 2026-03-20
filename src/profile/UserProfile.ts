import * as vscode from 'vscode';
import { UserProfileData } from '../memory/types';

const DEFAULT_PROFILE: UserProfileData = {
    preferredLanguage: '',
    codeStyle: '',
    indentation: '',
    verbosity: '',
    frameworks: [],
};

export class UserProfile {
    constructor(private readonly storageUri: vscode.Uri) {}

    private get fileUri(): vscode.Uri {
        return vscode.Uri.joinPath(this.storageUri, 'profile', 'USER.json');
    }

    async load(): Promise<UserProfileData> {
        try {
            const data = await vscode.workspace.fs.readFile(this.fileUri);
            return { ...DEFAULT_PROFILE, ...JSON.parse(Buffer.from(data).toString('utf-8')) };
        } catch {
            return { ...DEFAULT_PROFILE };
        }
    }

    async save(profile: UserProfileData): Promise<void> {
        const dir = vscode.Uri.joinPath(this.storageUri, 'profile');
        try {
            await vscode.workspace.fs.createDirectory(dir);
        } catch {
            // directory may already exist
        }
        await vscode.workspace.fs.writeFile(this.fileUri, Buffer.from(JSON.stringify(profile, null, 2), 'utf-8'));
    }

    async update(partial: Partial<UserProfileData>): Promise<UserProfileData> {
        const current = await this.load();
        const updated = { ...current, ...partial };
        await this.save(updated);
        return updated;
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
