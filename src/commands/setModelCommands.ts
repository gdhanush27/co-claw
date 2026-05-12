import * as vscode from 'vscode';
import { ModelManager, TIERS } from '../lm/ModelManager';
import type { TaskDifficulty } from '../agents/types';
import { StatusBar } from '../ui/statusBar';

const VALID_TIERS: ReadonlySet<TaskDifficulty> = new Set(TIERS);

/**
 * Internal command invoked by chat buttons from `/model`. Persists the
 * general model preference, refreshes the status bar, and surfaces a
 * confirmation toast. Not contributed in `package.json#contributes.commands`
 * on purpose — it's not meant for the Command Palette.
 */
export function registerSetModelFamilyCommand(
    modelManager: ModelManager,
    statusBar: StatusBar,
): vscode.Disposable {
    return vscode.commands.registerCommand('CoClaw.setModelFamily', async (familyArg: unknown) => {
        const family = typeof familyArg === 'string' ? familyArg.trim() : '';
        if (!family) {
            vscode.window.showWarningMessage('CoClaw: missing model family.');
            return;
        }
        // Verify the family is actually available before we persist it so a
        // bogus button payload doesn't silently mis-route every subsequent
        // request to the default model via getModelForTier's fallback.
        const models = await modelManager.getAvailableModels(true);
        const match = models.find(m => m.family === family);
        if (!match) {
            vscode.window.showWarningMessage(
                `CoClaw: model family "${family}" is not available from Copilot right now.`,
            );
            return;
        }
        await modelManager.setPreferredFamily(family);
        await statusBar.update();
        vscode.window.showInformationMessage(
            `CoClaw: Switched to ${match.name} (${match.family}).`,
        );
    });
}

/**
 * Internal command invoked by chat buttons from `/model tier ...`. Persists
 * the tier model and surfaces a confirmation toast.
 */
export function registerSetTierModelCommand(
    modelManager: ModelManager,
): vscode.Disposable {
    return vscode.commands.registerCommand(
        'CoClaw.setTierModel',
        async (tierArg: unknown, familyArg: unknown) => {
            const tier = typeof tierArg === 'string' ? tierArg.toLowerCase() : '';
            const family = typeof familyArg === 'string' ? familyArg.trim() : '';
            if (!VALID_TIERS.has(tier as TaskDifficulty)) {
                vscode.window.showWarningMessage(`CoClaw: unknown tier "${tierArg}".`);
                return;
            }
            if (!family) {
                vscode.window.showWarningMessage('CoClaw: missing model family.');
                return;
            }
            const models = await modelManager.getAvailableModels(true);
            const match = models.find(m => m.family === family);
            if (!match) {
                vscode.window.showWarningMessage(
                    `CoClaw: model family "${family}" is not available from Copilot right now.`,
                );
                return;
            }
            await modelManager.setTierFamily(tier as TaskDifficulty, family);
            vscode.window.showInformationMessage(
                `CoClaw: ${capitalize(tier)} tier set to ${match.name} (${match.family}).`,
            );
        },
    );
}

function capitalize(s: string): string {
    return s.length === 0 ? s : s[0].toUpperCase() + s.slice(1);
}
