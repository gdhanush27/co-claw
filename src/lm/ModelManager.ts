import * as vscode from 'vscode';
import type { TaskDifficulty } from '../agents/types';
import { Logger } from '../util/Logger';

/** All known difficulty tiers. Single source of truth for UI iteration. */
export const TIERS: readonly TaskDifficulty[] = ['light', 'medium', 'hard'] as const;

/**
 * Short cache for `vscode.lm.selectChatModels`. The Copilot model list rarely
 * changes within a session and Telegram's settings UI can ask for it 4× when
 * the user is flipping between tier panels. A few seconds is enough.
 */
const MODELS_CACHE_TTL_MS = 5_000;

export class ModelManager {
    private static readonly SELECTED_FAMILY_KEY = 'selectedFamily';

    private modelsCache: { fetchedAt: number; models: vscode.LanguageModelChat[] } | undefined;
    /** Track tier families we have already warned about being unavailable. */
    private readonly warnedMissingFamilies = new Set<string>();

    constructor(private readonly globalState: vscode.Memento) {}

    async getAvailableModels(forceRefresh = false): Promise<vscode.LanguageModelChat[]> {
        if (!forceRefresh && this.modelsCache && Date.now() - this.modelsCache.fetchedAt < MODELS_CACHE_TTL_MS) {
            return this.modelsCache.models;
        }
        const models = await vscode.lm.selectChatModels({ vendor: 'copilot' });
        this.modelsCache = { fetchedAt: Date.now(), models };
        return models;
    }

    async getActiveModel(): Promise<vscode.LanguageModelChat> {
        const models = await this.getAvailableModels();
        if (models.length === 0) {
            throw new Error('No Copilot models available. Ensure GitHub Copilot is installed and active.');
        }

        const preferredFamily = this.getPreferredFamily();
        if (preferredFamily) {
            const match = models.find(m => m.family === preferredFamily);
            if (match) {
                return match;
            }
        }

        return models[0];
    }

    async selectModelViaQuickPick(): Promise<vscode.LanguageModelChat | undefined> {
        const models = await this.getAvailableModels(true);
        if (models.length === 0) {
            vscode.window.showWarningMessage('No Copilot models available.');
            return undefined;
        }

        const currentFamily = this.getPreferredFamily();

        const items: vscode.QuickPickItem[] = models.map(m => ({
            label: m.name,
            description: m.family,
            detail: `Max tokens: ${m.maxInputTokens}`,
            picked: m.family === currentFamily,
        }));

        const selected = await vscode.window.showQuickPick(items, {
            placeHolder: 'Select a Copilot model',
            title: 'CoClaw: Model Selection',
        });

        if (!selected) {
            return undefined;
        }

        const model = models.find(m => m.name === selected.label);
        if (model) {
            await this.setPreferredFamily(model.family);
        }
        return model;
    }

    getPreferredFamily(): string | undefined {
        const workspaceSetting = vscode.workspace.getConfiguration('CoClaw.model').get<string>('family');
        if (workspaceSetting) {
            return workspaceSetting;
        }
        return this.globalState.get<string>(ModelManager.SELECTED_FAMILY_KEY);
    }

    async setPreferredFamily(family: string): Promise<void> {
        await this.globalState.update(ModelManager.SELECTED_FAMILY_KEY, family);
    }

    // ── Tier-based model selection ──────────────────────────────────────
    //
    // Tier overrides are persisted exclusively through VS Code settings
    // (`CoClaw.models.<tier>`). Both the Telegram /settings UI and the VS Code
    // QuickPick write through this same path, so there is exactly one source
    // of truth and no risk of two stores drifting apart.

    /** Return the model family configured for a given difficulty tier, if any. */
    getTierFamily(tier: TaskDifficulty): string | undefined {
        const setting = vscode.workspace.getConfiguration('CoClaw.models').get<string>(tier);
        return setting && setting.trim().length > 0 ? setting : undefined;
    }

    /** Persist the model family for a difficulty tier. */
    async setTierFamily(tier: TaskDifficulty, family: string | undefined): Promise<void> {
        await vscode.workspace.getConfiguration('CoClaw.models')
            .update(tier, family && family.length > 0 ? family : undefined, vscode.ConfigurationTarget.Global);
    }

    /** Get all tier assignments in a single pass (one config read per tier). */
    getAllTierFamilies(): Record<TaskDifficulty, string | undefined> {
        const cfg = vscode.workspace.getConfiguration('CoClaw.models');
        const read = (t: TaskDifficulty): string | undefined => {
            const v = cfg.get<string>(t);
            return v && v.trim().length > 0 ? v : undefined;
        };
        return { light: read('light'), medium: read('medium'), hard: read('hard') };
    }

    /**
     * Resolve the active model for a specific task difficulty tier.
     * Falls back to `getActiveModel()` when no tier-specific override is set,
     * or when the configured family isn't currently available (with a
     * one-shot warning so silent fallback doesn't go unnoticed).
     */
    async getModelForTier(tier: TaskDifficulty): Promise<vscode.LanguageModelChat> {
        const tierFamily = this.getTierFamily(tier);
        if (tierFamily) {
            const models = await this.getAvailableModels();
            const match = models.find(m => m.family === tierFamily);
            if (match) {
                return match;
            }
            const warnKey = `${tier}:${tierFamily}`;
            if (!this.warnedMissingFamilies.has(warnKey)) {
                this.warnedMissingFamilies.add(warnKey);
                Logger.warn(
                    'ModelManager',
                    `Configured model family for tier '${tier}' is '${tierFamily}' but no such Copilot model is available; ` +
                    `falling back to the default model. Update 'CoClaw.models.${tier}' or run 'CoClaw: Select Tier Models'.`,
                );
            }
        }
        return this.getActiveModel();
    }

    /**
     * Show a QuickPick to assign a Copilot model to a single tier.
     * Returns the picked model (or undefined if the user cancelled).
     */
    async selectTierModelViaQuickPick(tier: TaskDifficulty): Promise<vscode.LanguageModelChat | undefined> {
        const models = await this.getAvailableModels(true);
        if (models.length === 0) {
            vscode.window.showWarningMessage('No Copilot models available.');
            return undefined;
        }

        const currentFamily = this.getTierFamily(tier);
        // Dedupe by family so the picker doesn't show the same family twice.
        const seen = new Set<string>();
        const uniqueModels = models.filter(m => (seen.has(m.family) ? false : (seen.add(m.family), true)));

        type Item = vscode.QuickPickItem & { family?: string; clear?: boolean };
        const items: Item[] = [
            ...uniqueModels.map<Item>(m => ({
                label: m.name,
                description: m.family,
                detail: `Max tokens: ${m.maxInputTokens}${m.family === currentFamily ? ' • current' : ''}`,
                family: m.family,
                picked: m.family === currentFamily,
            })),
            { label: '$(close) Clear override', description: 'Use the default model for this tier', clear: true },
        ];

        const selected = await vscode.window.showQuickPick(items, {
            placeHolder: `Select model for ${tier}-difficulty tasks`,
            title: `CoClaw: ${tier[0].toUpperCase() + tier.slice(1)} Tier Model`,
        });
        if (!selected) { return undefined; }

        if (selected.clear) {
            await this.setTierFamily(tier, undefined);
            return undefined;
        }
        if (selected.family) {
            await this.setTierFamily(tier, selected.family);
            return models.find(m => m.family === selected.family);
        }
        return undefined;
    }

    /**
     * Walk all three tiers through QuickPick, in order. Useful for a single
     * "configure tier models" command.
     */
    async selectAllTierModelsViaQuickPick(): Promise<void> {
        for (const tier of TIERS) {
            const picked = await this.selectTierModelViaQuickPick(tier);
            // If the user dismissed (Escape) on any step, stop the wizard
            // rather than silently advancing — matches VS Code conventions.
            if (picked === undefined && this.getTierFamily(tier) === undefined) {
                // user cancelled OR cleared — either way they made a choice;
                // continue to next tier instead of aborting.
                continue;
            }
        }
    }
}
