import * as vscode from 'vscode';
import { SoulConfig } from '../profile/SoulConfig';
import { UserProfile } from '../profile/UserProfile';

export function registerEditSoulCommand(soulConfig: SoulConfig): vscode.Disposable {
    return vscode.commands.registerCommand('CoClaw.editSoul', async () => {
        await soulConfig.openInEditor();
    });
}

export function registerEditProfileCommand(userProfile: UserProfile): vscode.Disposable {
    return vscode.commands.registerCommand('CoClaw.editProfile', async () => {
        await userProfile.openInEditor();
    });
}
