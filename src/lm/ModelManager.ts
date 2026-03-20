import * as vscode from 'vscode';

export class ModelManager {
    private static readonly SELECTED_FAMILY_KEY = 'selectedFamily';

    constructor(private readonly globalState: vscode.Memento) {}

    async getAvailableModels(): Promise<vscode.LanguageModelChat[]> {
        return vscode.lm.selectChatModels({ vendor: 'copilot' });
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

        // Fallback to first available
        return models[0];
    }

    async selectModelViaQuickPick(): Promise<vscode.LanguageModelChat | undefined> {
        const models = await this.getAvailableModels();
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
        // Workspace setting takes priority
        const workspaceSetting = vscode.workspace.getConfiguration('CoClaw.model').get<string>('family');
        if (workspaceSetting) {
            return workspaceSetting;
        }
        return this.globalState.get<string>(ModelManager.SELECTED_FAMILY_KEY);
    }

    async setPreferredFamily(family: string): Promise<void> {
        await this.globalState.update(ModelManager.SELECTED_FAMILY_KEY, family);
    }
}
