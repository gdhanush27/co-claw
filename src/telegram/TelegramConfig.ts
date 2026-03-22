import * as vscode from 'vscode';

const TOKEN_KEY = 'CoClaw.telegram.botToken';
const USERID_KEY = 'CoClaw.telegram.userId';

/**
 * Manages Telegram bot credentials.
 * Bot token is stored in VS Code SecretStorage (encrypted).
 * User ID is stored in globalState (non-sensitive numeric identifier).
 */
export class TelegramConfig {
    constructor(
        private readonly secrets: vscode.SecretStorage,
        private readonly globalState: vscode.Memento,
    ) {}

    async getBotToken(): Promise<string | undefined> {
        return this.secrets.get(TOKEN_KEY);
    }

    async setBotToken(token: string): Promise<void> {
        await this.secrets.store(TOKEN_KEY, token);
    }

    async clearBotToken(): Promise<void> {
        await this.secrets.delete(TOKEN_KEY);
    }

    getUserId(): number | undefined {
        return this.globalState.get<number>(USERID_KEY);
    }

    async setUserId(userId: number): Promise<void> {
        await this.globalState.update(USERID_KEY, userId);
    }

    async clearUserId(): Promise<void> {
        await this.globalState.update(USERID_KEY, undefined);
    }

    async isConfigured(): Promise<boolean> {
        const token = await this.getBotToken();
        const userId = this.getUserId();
        return !!token && !!userId;
    }

    async clear(): Promise<void> {
        await this.clearBotToken();
        await this.clearUserId();
    }
}
