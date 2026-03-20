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
import { registerSelectModelCommand } from './commands/selectModel';
import { registerShowMemoryCommand } from './commands/showMemory';
import { registerClearMemoryCommand } from './commands/clearMemory';
import { registerEditSoulCommand, registerEditProfileCommand } from './commands/editSoul';
import { registerDistillCommand, registerImportCommand, registerExportCommand } from './commands/memoryCommands';
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
    statusBar.update();
    context.subscriptions.push({ dispose: () => statusBar.dispose() });

    const memoryPanel = new MemoryPanel(memoryEngine, context.extensionUri);
    context.subscriptions.push({ dispose: () => memoryPanel.dispose() });

    // Chat participant
    const participantHandler = new ParticipantHandler(modelManager, promptBuilder, memoryEngine, statusBar);
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
    );

    // Enable Settings Sync for model preference
    context.globalState.setKeysForSync(['selectedFamily']);

    // Prune old daily logs on activation
    const retentionDays = vscode.workspace.getConfiguration('CoClaw.memory').get<number>('dailyLogsRetentionDays', 30);
    memoryEngine.dailyLog.pruneOldLogs(retentionDays).catch(() => { /* silent */ });

    // Apply decay to long-term memory periodically
    memoryEngine.longTermMemory.applyDecay().catch(() => { /* silent */ });
}

export function deactivate() {
    // Cleanup handled by disposables
}
