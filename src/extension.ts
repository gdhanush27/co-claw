import * as vscode from 'vscode';
import { ModelManager } from './lm/ModelManager';
import { PromptBuilder } from './lm/PromptBuilder';
import { MemoryEngine } from './memory/MemoryEngine';
import { UserProfile } from './profile/UserProfile';
import { SoulConfig } from './profile/SoulConfig';
import { ParticipantHandler } from './participant/handler';
import { createFollowUpProvider } from './participant/followUps';
import { StatusBar } from './ui/statusBar';
import { MemoryPanel } from './ui/memoryPanel';
import { MemoryReadTool } from './tools/memoryReadTool';
import { MemoryWriteTool } from './tools/memoryWriteTool';
import { MemoryDeleteTool } from './tools/memoryDeleteTool';
import { MemoryUpdateTool } from './tools/memoryUpdateTool';
import { WorkspaceContextTool } from './tools/workspaceContextTool';
import { SharedMemoryReadTool } from './tools/sharedMemoryReadTool';
import { SharedMemoryWriteTool } from './tools/sharedMemoryWriteTool';
import { GetTaskStatusTool } from './tools/getTaskStatusTool';
import { SpawnAgentTool } from './tools/spawnAgentTool';
import { TelegramSendFileTool } from './tools/telegramSendFileTool';
import { RunRegistry } from './agents/RunRegistry';
import { SharedMemoryStore } from './agents/SharedMemoryStore';
import { Orchestrator, SpawnerHolder } from './agents/Orchestrator';
import { AgentTreeProvider } from './ui/agentTreeProvider';
import { registerSelectModelCommand } from './commands/selectModel';
import { registerShowMemoryCommand } from './commands/showMemory';
import { registerClearMemoryCommand } from './commands/clearMemory';
import { registerEditSoulCommand, registerEditProfileCommand } from './commands/editSoul';
import { registerDistillCommand, registerImportCommand, registerExportCommand, registerDeduplicateCommand } from './commands/memoryCommands';
import {
    registerClearAllCronJobsCommand,
    registerLinkTelegramCommand,
    registerOpenCronStorageCommand,
    registerUnlinkTelegramCommand,
} from './commands/telegramCommands';
import { TelegramBot } from './telegram/TelegramBot';
import { TelegramConfig } from './telegram/TelegramConfig';
import { createHash } from 'crypto';

function getWorkspaceId(): string | undefined {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) { return undefined; }
    const paths = folders.map(f => f.uri.toString()).sort().join('|');
    return createHash('sha256').update(paths).digest('hex').substring(0, 12);
}

export function activate(context: vscode.ExtensionContext) {
    const storageUri = context.globalStorageUri;

    // Core services
    const modelManager = new ModelManager(context.globalState);
    const memoryEngine = new MemoryEngine(storageUri, getWorkspaceId());
    const userProfile = new UserProfile(storageUri);
    const soulConfig = new SoulConfig(storageUri);
    const promptBuilder = new PromptBuilder(memoryEngine, soulConfig, userProfile);

    // UI
    const statusBar = new StatusBar(modelManager);
    statusBar.setMemoryEngine(memoryEngine);
    statusBar.update();
    context.subscriptions.push({ dispose: () => statusBar.dispose() });

    const memoryPanel = new MemoryPanel(memoryEngine, context.extensionUri);
    context.subscriptions.push({ dispose: () => memoryPanel.dispose() });

    // Multi-agent orchestration
    const runRegistry = new RunRegistry();
    context.subscriptions.push({ dispose: () => runRegistry.dispose() });
    const sharedMemoryStore = new SharedMemoryStore(memoryEngine);
    const spawnerHolder: SpawnerHolder = { current: undefined };
    const orchestrator = new Orchestrator(modelManager, runRegistry, sharedMemoryStore, spawnerHolder);

    // Chat participant
    const participantHandler = new ParticipantHandler(modelManager, promptBuilder, memoryEngine, statusBar, orchestrator);
    const participant = vscode.chat.createChatParticipant('CoClaw.assistant', participantHandler.handler);
    participant.iconPath = new vscode.ThemeIcon('hubot');
    participant.followupProvider = createFollowUpProvider();
    context.subscriptions.push(participant);

    // Stop command
    context.subscriptions.push(
        vscode.commands.registerCommand('CoClaw.stop', () => {
            participantHandler.stop();
        }),
    );

    // LM Tools
    context.subscriptions.push(
        vscode.lm.registerTool('CoClaw_memory_read', new MemoryReadTool(memoryEngine)),
        vscode.lm.registerTool('CoClaw_memory_write', new MemoryWriteTool(memoryEngine)),
        vscode.lm.registerTool('CoClaw_memory_delete', new MemoryDeleteTool(memoryEngine)),
        vscode.lm.registerTool('CoClaw_memory_update', new MemoryUpdateTool(memoryEngine)),
        vscode.lm.registerTool('CoClaw_workspace_context', new WorkspaceContextTool()),
        vscode.lm.registerTool('CoClaw_shared_memory_read', new SharedMemoryReadTool(sharedMemoryStore)),
        vscode.lm.registerTool('CoClaw_shared_memory_write', new SharedMemoryWriteTool(sharedMemoryStore)),
        vscode.lm.registerTool('CoClaw_get_task_status', new GetTaskStatusTool(runRegistry)),
        vscode.lm.registerTool('CoClaw_spawn_agent', new SpawnAgentTool(spawnerHolder)),
    );

    // Agent sidebar TreeView
    const agentTreeProvider = new AgentTreeProvider(runRegistry);
    context.subscriptions.push(
        vscode.window.registerTreeDataProvider('CoClaw.agentsView', agentTreeProvider),
        { dispose: () => agentTreeProvider.dispose() },
    );

    // Telegram bot
    const telegramConfig = new TelegramConfig(context.secrets, context.globalState);
    const telegramBot = new TelegramBot(telegramConfig, modelManager, promptBuilder, memoryEngine, statusBar, storageUri);
    participantHandler.setTelegramBot(telegramBot);
    context.subscriptions.push({ dispose: () => telegramBot.dispose() });

    // Telegram-aware LM tool (must be registered after bot construction)
    context.subscriptions.push(
        vscode.lm.registerTool('CoClaw_telegram_send_file', new TelegramSendFileTool(telegramBot)),
    );

    // Commands
    context.subscriptions.push(
        registerSelectModelCommand(modelManager, statusBar),
        registerShowMemoryCommand(memoryPanel),
        registerClearMemoryCommand(memoryEngine),
        registerEditSoulCommand(soulConfig),
        registerEditProfileCommand(userProfile),
        registerDistillCommand(memoryEngine),
        registerImportCommand(memoryEngine),
        registerExportCommand(memoryEngine),
        registerDeduplicateCommand(memoryEngine),
        registerLinkTelegramCommand(telegramBot, telegramConfig),
        registerUnlinkTelegramCommand(telegramBot, telegramConfig),
        registerClearAllCronJobsCommand(telegramBot),
        registerOpenCronStorageCommand(telegramBot),
        vscode.commands.registerCommand('CoClaw.openSettings', () => {
            vscode.commands.executeCommand('workbench.action.openSettings', 'CoClaw');
        }),
    );

    // Enable Settings Sync for model preference
    context.globalState.setKeysForSync(['selectedFamily']);

    // Prune old daily logs on activation
    const retentionDays = vscode.workspace.getConfiguration('CoClaw.memory').get<number>('dailyLogsRetentionDays', 30);
    memoryEngine.dailyLog.pruneOldLogs(retentionDays).catch(() => { /* silent */ });

    // Apply decay to long-term memory periodically
    memoryEngine.longTermMemory.applyDecay().catch(() => { /* silent */ });

    // --- Auto-Distill Triggers ---
    const autoDistillThreshold = vscode.workspace.getConfiguration('CoClaw.memory').get<number>('autoDistillThreshold', 20);
    const autoDistillIntervalHours = vscode.workspace.getConfiguration('CoClaw.memory').get<number>('autoDistillIntervalHours', 24);

    // Threshold-based: check after each extraction cycle via a periodic poll
    let autoDistillTimer: ReturnType<typeof setInterval> | undefined;
    if (autoDistillThreshold > 0) {
        // Check every 5 minutes if threshold is exceeded
        autoDistillTimer = setInterval(async () => {
            try {
                const todayEntries = await memoryEngine.dailyLog.getTodayEntries();
                if (todayEntries.length >= autoDistillThreshold) {
                    const tokenSource = new vscode.CancellationTokenSource();
                    const count = await memoryEngine.distill(tokenSource.token);
                    tokenSource.dispose();
                    if (count > 0) {
                        vscode.window.showInformationMessage(`CoClaw: Auto-distilled ${count} entries (threshold: ${autoDistillThreshold}).`);
                    }
                }
            } catch { /* silent */ }
        }, 5 * 60 * 1000);
    }

    // Scheduled: distill on a configurable interval
    let scheduledDistillTimer: ReturnType<typeof setInterval> | undefined;
    if (autoDistillIntervalHours > 0) {
        scheduledDistillTimer = setInterval(async () => {
            try {
                const tokenSource = new vscode.CancellationTokenSource();
                const count = await memoryEngine.distill(tokenSource.token);
                tokenSource.dispose();
                if (count > 0) {
                    vscode.window.showInformationMessage(`CoClaw: Scheduled distill — ${count} entries consolidated.`);
                }
            } catch { /* silent */ }
        }, autoDistillIntervalHours * 60 * 60 * 1000);
    }

    context.subscriptions.push({
        dispose: () => {
            if (autoDistillTimer) { clearInterval(autoDistillTimer); }
            if (scheduledDistillTimer) { clearInterval(scheduledDistillTimer); }
        }
    });
}

export function deactivate() {
    // Note: VS Code disposes subscriptions automatically.
    // Auto-distill timers disposed via subscriptions above.
}
