import * as vscode from 'vscode';
import { ModelManager, TIERS } from '../lm/ModelManager';
import type { TaskDifficulty } from '../agents/types';

const VALID_TIERS: ReadonlySet<TaskDifficulty> = new Set(TIERS);

function isValidTier(v: unknown): v is TaskDifficulty {
    return typeof v === 'string' && VALID_TIERS.has(v as TaskDifficulty);
}

/**
 * Register the `CoClaw: Select Tier Models` command.
 *
 * Without arguments the command asks which tier to configure (light/medium/
 * hard) and then shows a model QuickPick for that tier. When invoked with
 * a tier argument — e.g. from a settings.json command link like
 * `command:CoClaw.selectTierModels?%5B%22hard%22%5D` — the tier picker is
 * skipped and we jump straight to the model picker for that tier.
 *
 * Persistence flows through {@link ModelManager.setTierFamily} which writes
 * VS Code workspace settings — the same store used by the Telegram
 * /settings → Model Tiers UI, so both surfaces stay in sync.
 */
export function registerSelectTierModelsCommand(
    modelManager: ModelManager,
): vscode.Disposable {
    return vscode.commands.registerCommand('CoClaw.selectTierModels', async (tierArg?: unknown) => {
        let tier: TaskDifficulty | undefined = isValidTier(tierArg) ? tierArg : undefined;

        if (!tier) {
            type TierItem = vscode.QuickPickItem & { tier: TaskDifficulty };
            const current = modelManager.getAllTierFamilies();
            const tierItems: TierItem[] = TIERS.map(t => ({
                tier: t,
                label: `${tierIcon(t)}  ${capitalize(t)}`,
                description: current[t] ? `current: ${current[t]}` : 'current: (default)',
                detail: tierBlurb(t),
            }));

            const picked = await vscode.window.showQuickPick(tierItems, {
                placeHolder: 'Which difficulty tier do you want to configure?',
                title: 'CoClaw: Select Tier Models',
            });
            if (!picked) { return; }
            tier = picked.tier;
        }

        const before = modelManager.getTierFamily(tier);
        const model = await modelManager.selectTierModelViaQuickPick(tier);
        if (model) {
            vscode.window.showInformationMessage(
                `CoClaw: ${capitalize(tier)} tier set to ${model.name} (${model.family}).`,
            );
        } else if (before !== undefined && modelManager.getTierFamily(tier) === undefined) {
            // Re-read so we can tell whether the user actively cleared the
            // override vs. just dismissed the QuickPick (Escape).
            vscode.window.showInformationMessage(
                `CoClaw: ${capitalize(tier)} tier override cleared.`,
            );
        }
    });
}

function tierIcon(t: TaskDifficulty): string {
    switch (t) {
        case 'light':  return '$(zap)';
        case 'medium': return '$(symbol-method)';
        case 'hard':   return '$(rocket)';
    }
}

function tierBlurb(t: TaskDifficulty): string {
    switch (t) {
        case 'light':  return 'Trivial / formulaic work: typos, rename, version bumps, mechanical formatting.';
        case 'medium': return 'Typical implementation, review, and test work. The default.';
        case 'hard':   return 'Multi-file refactors, architectural design, security review, complex reasoning.';
    }
}

function capitalize(s: string): string {
    return s.length === 0 ? s : s[0].toUpperCase() + s.slice(1);
}
