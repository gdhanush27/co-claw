import * as vscode from 'vscode';
import { TelegramBot } from '../telegram/TelegramBot';
import { TelegramConfig } from '../telegram/TelegramConfig';

export function registerLinkTelegramCommand(
    bot: TelegramBot,
    config: TelegramConfig,
): vscode.Disposable {
    return vscode.commands.registerCommand('CoClaw.linkTelegram', async () => {
        if (bot.isRunning) {
            const action = await vscode.window.showWarningMessage(
                'Telegram bot is already running. Relink with new credentials?',
                'Relink', 'Cancel',
            );
            if (action !== 'Relink') { return; }
            bot.stop();
        }

        // Prompt for bot token
        const token = await vscode.window.showInputBox({
            title: 'CoClaw: Link Telegram (1/2)',
            prompt: 'Enter your Telegram Bot Token (from @BotFather)',
            placeHolder: '123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11',
            password: true,
            ignoreFocusOut: true,
            validateInput: (value) => {
                if (!value.trim()) { return 'Bot token is required'; }
                if (!/^\d+:[A-Za-z0-9_-]+$/.test(value.trim())) {
                    return 'Invalid bot token format. Should be like 123456:ABCdef...';
                }
                return undefined;
            },
        });
        if (!token) { return; }

        // Prompt for user ID
        const userIdStr = await vscode.window.showInputBox({
            title: 'CoClaw: Link Telegram (2/2)',
            prompt: 'Enter your Telegram User ID (numeric). You can get it from @userinfobot',
            placeHolder: '123456789',
            ignoreFocusOut: true,
            validateInput: (value) => {
                if (!value.trim()) { return 'User ID is required'; }
                if (!/^\d+$/.test(value.trim())) {
                    return 'User ID must be a number';
                }
                return undefined;
            },
        });
        if (!userIdStr) { return; }

        const userId = parseInt(userIdStr.trim(), 10);

        // Save credentials
        await config.setBotToken(token.trim());
        await config.setUserId(userId);

        // Start the bot
        try {
            await bot.start();
            vscode.window.showInformationMessage(
                `CoClaw Telegram bot is now linked! Send messages to your bot to interact with CoClaw.`,
            );
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            await config.clear();
            vscode.window.showErrorMessage(`Failed to start Telegram bot: ${msg}`);
        }
    });
}

export function registerUnlinkTelegramCommand(
    bot: TelegramBot,
    config: TelegramConfig,
): vscode.Disposable {
    return vscode.commands.registerCommand('CoClaw.unlinkTelegram', async () => {
        if (!bot.isRunning && !(await config.isConfigured())) {
            vscode.window.showInformationMessage('No Telegram bot is linked.');
            return;
        }

        const action = await vscode.window.showWarningMessage(
            'Unlink Telegram bot? This will stop the bot and remove saved credentials.',
            'Unlink', 'Cancel',
        );
        if (action !== 'Unlink') { return; }

        bot.stop();
        await config.clear();
        vscode.window.showInformationMessage('Telegram bot has been unlinked.');
    });
}

export function registerClearAllCronJobsCommand(bot: TelegramBot): vscode.Disposable {
    return vscode.commands.registerCommand('CoClaw.clearCronJobs', async () => {
        const action = await vscode.window.showWarningMessage(
            'Clear all saved cron jobs? This removes scheduled jobs from VS Code storage.',
            { modal: true },
            'Clear All',
        );
        if (action !== 'Clear All') { return; }

        const removed = await bot.clearAllCronJobs();
        const suffix = removed === 1 ? 'job' : 'jobs';
        vscode.window.showInformationMessage(`CoClaw: Cleared ${removed} cron ${suffix}.`);
    });
}

export function registerOpenCronStorageCommand(bot: TelegramBot): vscode.Disposable {
    return vscode.commands.registerCommand('CoClaw.openCronStorage', async () => {
        const cronStorageUri = bot.getCronStorageUri();
        if (!cronStorageUri) {
            vscode.window.showErrorMessage('CoClaw: Cron storage is not available yet.');
            return;
        }

        try {
            await vscode.workspace.fs.createDirectory(cronStorageUri);
        } catch {
            // Directory may already exist.
        }

        await vscode.commands.executeCommand('revealFileInOS', cronStorageUri);
    });
}
