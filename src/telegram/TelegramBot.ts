import * as vscode from 'vscode';
import { TelegramApi, TelegramUpdate, TelegramCallbackQuery } from './TelegramApi';
import { TelegramConfig } from './TelegramConfig';
import { ModelManager } from '../lm/ModelManager';
import { PromptBuilder } from '../lm/PromptBuilder';
import { ToolRunner } from '../lm/ToolRunner';
import { ToolResultCache } from '../lm/ToolResultCache';
import { MemoryEngine } from '../memory/MemoryEngine';
import { MemoryExtractor } from '../memory/MemoryExtractor';
import { WorkspaceMemory } from '../memory/WorkspaceMemory';
import { Heartbeat } from '../heartbeat/Heartbeat';
import { CronScheduler } from '../cron/CronScheduler';
import { CronJobResult } from '../cron/CronJob';
import { buildCronClearConfirmPanel, buildCronControlPanel } from './TelegramCronUi';
import { StatusBar } from '../ui/statusBar';

/**
 * Dual-output stream that writes to both the VS Code chat stream
 * and collects text for Telegram.
 */
class DualStream {
    private parts: string[] = [];

    constructor(private readonly vscodeStream?: vscode.ChatResponseStream) {}

    markdown(text: string): void {
        this.parts.push(text);
        this.vscodeStream?.markdown(text);
    }

    progress(text: string): void {
        this.vscodeStream?.progress(text);
    }

    getText(): string {
        return this.parts.join('');
    }
}

export function extractNaturalLanguageCronDeletionTarget(text: string): string | undefined {
    const normalized = text.trim().replace(/[.!?]+$/g, '');
    const actionMatch = normalized.match(/^(?:please\s+)?(?:delete|remove|cancel|stop)\s+(.+)$/i);
    if (!actionMatch) {
        return undefined;
    }

    const lower = normalized.toLowerCase();
    if (!/(reminder|remainder|cron|job|task)/i.test(lower)) {
        return undefined;
    }

    let target = actionMatch[1]
        .replace(/^(?:the|a|an|my)\s+/i, '')
        .replace(/\b(?:reminder|remainder|cron\s+job|cron\s+jobs|job|jobs|task|tasks)\b/gi, '')
        .replace(/\s+/g, ' ')
        .trim();

    target = target.replace(/^the\s+/i, '').trim();
    return target || undefined;
}

/**
 * Telegram bot that bridges messages to CoClaw's agentic LLM pipeline.
 *
 * Activated via the @CoClaw /auto slash command. Polls Telegram for messages
 * from the authorized user, processes them through the same model + prompt +
 * tool system as the VS Code chat participant, and sends responses to both
 * Telegram AND the VS Code chat panel.
 */
export class TelegramBot {
    private api: TelegramApi | undefined;
    private polling = false;
    private conversationHistory: vscode.LanguageModelChatMessage[] = [];
    private readonly toolRunner = new ToolRunner();
    private readonly cache: ToolResultCache;
    private readonly memoryExtractor = new MemoryExtractor();

    /** The active VS Code chat stream (set when /auto is running). */
    private vscodeStream: vscode.ChatResponseStream | undefined;

    /** Tool invocation token from the /auto chat request — makes tool calls trusted. */
    private toolInvocationToken: vscode.ChatParticipantToolToken | undefined;

    /** Resolves when the polling loop exits. Used by handleAutoCommand to keep the stream alive. */
    private stoppedResolve: (() => void) | undefined;
    private _stoppedPromise: Promise<void> | undefined;

    /** Whether the bot is running in /open (OpenClaw) mode. */
    private _openMode = false;

    /** Heartbeat instance (only active in /open mode). */
    private heartbeat: Heartbeat | undefined;

    /** Cron scheduler (only active in /open mode). */
    private cronScheduler: CronScheduler | undefined;

    /** Pending cron proposals waiting for Y/N confirmation. Key: callback ID prefix. */
    private pendingCronProposals: Map<string, { schedule: string; name: string; prompt: string }> = new Map();

    private static readonly MAX_HISTORY = 20;

    constructor(
        private readonly config: TelegramConfig,
        private readonly modelManager: ModelManager,
        private readonly promptBuilder: PromptBuilder,
        private readonly memoryEngine: MemoryEngine,
        private readonly statusBar?: StatusBar,
        private readonly storageUri?: vscode.Uri,
    ) {
        this.cache = new ToolResultCache(memoryEngine);
        this.toolRunner.setCache(this.cache);
    }

    get isRunning(): boolean {
        return this.polling;
    }

    get isOpenMode(): boolean {
        return this._openMode;
    }

    /** Promise that resolves when the bot stops. Used by /auto handler to keep stream alive. */
    get stoppedPromise(): Promise<void> | undefined {
        return this._stoppedPromise;
    }

    getCronStorageUri(): vscode.Uri | undefined {
        return this.storageUri ? vscode.Uri.joinPath(this.storageUri, 'cron') : undefined;
    }

    async clearAllCronJobs(): Promise<number> {
        if (this.cronScheduler) {
            return this.cronScheduler.clearAllJobs();
        }

        const cronStorageUri = this.getCronStorageUri();
        if (!cronStorageUri) {
            return 0;
        }

        const jobsFileUri = vscode.Uri.joinPath(cronStorageUri, 'jobs.json');

        try {
            const raw = await vscode.workspace.fs.readFile(jobsFileUri);
            const parsed = JSON.parse(Buffer.from(raw).toString('utf-8'));
            const count = Array.isArray(parsed) ? parsed.length : 0;
            await vscode.workspace.fs.writeFile(jobsFileUri, Buffer.from('[]', 'utf-8'));
            return count;
        } catch {
            return 0;
        }
    }

    /**
     * Start the bot with an optional VS Code chat stream for dual output.
     * Called from the /auto or /open slash command handler.
     * @param openMode If true, enables OpenClaw mode (heartbeat + workspace memory)
     */
    async start(stream?: vscode.ChatResponseStream, toolToken?: vscode.ChatParticipantToolToken, openMode = false): Promise<void> {
        const token = await this.config.getBotToken();
        const userId = this.config.getUserId();
        if (!token || !userId) {
            throw new Error('Telegram bot is not configured. Use "CoClaw: Link Telegram" first.');
        }

        this.api = new TelegramApi(token);
        this.vscodeStream = stream;
        this.toolInvocationToken = toolToken;
        this._openMode = openMode;

        // Verify the token works
        const me = await this.api.getMe();
        const botName = `@${me.username ?? me.first_name}`;

        // Flush any stale updates from the Telegram queue (old /stop, messages
        // sent while bot was offline, etc.) so they don't fire on reconnect.
        await this.flushPendingUpdates();

        if (openMode) {
            // Ensure workspace files exist
            await WorkspaceMemory.ensureMemoryMd();
            await Heartbeat.ensureHeartbeatMd();

            const startMsg = `🦞 **CoClaw OpenClaw mode active as ${botName}**\n\n` +
                `✅ Telegram bridge connected\n` +
                `✅ Workspace memory (MEMORY.md + daily logs)\n` +
                `✅ Heartbeat system active\n\n` +
                `Send messages in Telegram — full agentic mode with proactive monitoring.\n\n---\n\n`;
            stream?.markdown(startMsg);

            // Start heartbeat
            this.heartbeat = new Heartbeat(this.modelManager, this.promptBuilder, this.memoryEngine);
            this.heartbeat.setStream(stream);
            this.heartbeat.setFindingCallback(async (message: string) => {
                if (this.api && userId) {
                    await this.api.sendMessage(userId, message);
                }
            });
            this.heartbeat.start();

            // Start cron scheduler
            if (this.storageUri) {
                this.cronScheduler = new CronScheduler(this.modelManager, this.storageUri);
                this.cronScheduler.setStream(stream);
                this.cronScheduler.setResultCallback(async (result: CronJobResult) => {
                    if (this.api && userId) {
                        await this.api.sendMessage(userId, `⏰ **${result.jobName}**\n\n${result.response}`);
                    }
                });
                await this.cronScheduler.start();
            }

            // Log session start to workspace daily log
            await WorkspaceMemory.appendToDailyLog(`🦞 OpenClaw session started (bot: ${botName})`);
        } else {
            const startMsg = `🐾 **CoClaw Telegram bot connected as ${botName}**\n\nSend messages to your bot in Telegram — responses will appear here and in Telegram.\n\n---\n\n`;
            stream?.markdown(startMsg);
        }

        this.polling = true;

        // Create the stopped promise BEFORE starting the poll loop
        this._stoppedPromise = new Promise<void>((resolve) => {
            this.stoppedResolve = resolve;
        });

        this.poll(userId);
    }

    /** Stop the bot and clean up. */
    stop(): void {
        if (!this.polling) { return; }
        this.polling = false;
        // Stop heartbeat if running
        if (this.heartbeat) {
            this.heartbeat.stop();
            this.heartbeat = undefined;
        }
        // Stop cron scheduler if running
        if (this.cronScheduler) {
            this.cronScheduler.stop();
            this.cronScheduler = undefined;
        }
        this._openMode = false;
        // Abort the pending long-poll HTTP request immediately
        this.api?.abortPendingPoll();
        this.api = undefined;
        this.conversationHistory = [];
        // Signal the stopped promise (handleAutoCommand is awaiting this)
        if (this.stoppedResolve) {
            this.stoppedResolve();
            this.stoppedResolve = undefined;
        }
    }

    dispose(): void {
        this.stop();
    }

    // ── Polling Loop ──────────────────────────────────────────────
    /**
     * Drain all pending updates from Telegram so old messages
     * (especially /stop) don't fire when the bot reconnects.
     */
    private async flushPendingUpdates(): Promise<void> {
        try {
            // Use timeout=0 for an immediate, non-blocking fetch
            const stale = await this.api!.getUpdates(undefined, 0);
            if (stale.length > 0) {
                // Acknowledge them by requesting with offset past the last update
                const lastId = stale[stale.length - 1].update_id;
                await this.api!.getUpdates(lastId + 1, 0);
            }
        } catch {
            // Not critical — worst case we process a few old messages
        }
    }
    private async poll(authorizedUserId: number): Promise<void> {
        let offset: number | undefined;

        while (this.polling) {
            try {
                const updates = await this.api!.getUpdates(offset, 30);

                for (const update of updates) {
                    if (!this.polling) { break; }
                    offset = update.update_id + 1;
                    await this.handleUpdate(update, authorizedUserId);
                }
            } catch (err) {
                if (!this.polling) { break; }
                const msg = err instanceof Error ? err.message : String(err);
                console.error(`[CoClaw Telegram] Poll error: ${msg}`);
                await this.sleep(5000);
            }
        }

        // Clean up the vscodeStream reference after the loop exits
        this.vscodeStream = undefined;
        this._stoppedPromise = undefined;
    }

    private async handleUpdate(update: TelegramUpdate, authorizedUserId: number): Promise<void> {
        // Handle callback queries (inline button presses)
        if (update.callback_query) {
            await this.handleCallbackQuery(update.callback_query, authorizedUserId);
            return;
        }

        const msg = update.message;
        if (!msg?.text || !msg.from) { return; }

        // Security: only respond to the authorized user
        if (msg.from.id !== authorizedUserId) {
            await this.api?.sendMessage(msg.chat.id, '⛔ Unauthorized. This bot is linked to a specific user.');
            return;
        }

        const text = msg.text.trim();
        const chatId = msg.chat.id;

        // Handle bot commands
        if (text === '/start') {
            const reply = '🐾 CoClaw is connected! Send any prompt — I have full tool access (terminal, file edits, etc).';
            await this.api!.sendMessage(chatId, reply);
            this.vscodeStream?.markdown(`> **Telegram:** /start\n\n${reply}\n\n---\n\n`);
            return;
        }
        if (text === '/stop') {
            if (!this.polling) { return; } // Already stopping, ignore duplicate
            const reply = '🛑 Telegram bridge stopped.';
            // Send reply BEFORE stopping (stop() nulls the api)
            await this.api!.sendMessage(chatId, reply);
            this.vscodeStream?.markdown(`> **Telegram:** /stop\n\n${reply}\n\n`);
            this.stop();
            return;
        }
        if (text === '/status') {
            await this.sendStatus(chatId);
            return;
        }
        if (text === '/clear') {
            this.conversationHistory = [];
            const reply = '🧹 Conversation history cleared.';
            await this.api!.sendMessage(chatId, reply);
            this.vscodeStream?.markdown(`> **Telegram:** /clear\n\n${reply}\n\n---\n\n`);
            return;
        }
        if (text === '/help') {
            const helpLines = [
                '🐾 *CoClaw Telegram Commands*',
                '',
                'Just send any message — full agentic mode with all tools.',
                '/status — Show connection status',
                '/clear — Clear conversation history',
                '/stop — Stop the Telegram bridge',
                '/memory — Show memory summary',
            ];
            if (this._openMode) {
                helpLines.push(
                    '/cron — Open cron control panel',
                    '/heartbeat — Force a heartbeat check now',
                    '/heartbeat on — Enable heartbeat',
                    '/heartbeat off — Disable heartbeat',
                    '/cron list — Open cron control panel',
                    '/cron add <schedule> <name> | <prompt> — Add a job',
                    '/cron delete <name> — Delete a job',
                    '/cron pause <name> — Pause a job',
                    '/cron resume <name> — Resume a job',
                );
            }
            helpLines.push('/help — This message');
            const help = helpLines.join('\n');
            await this.api!.sendMessage(chatId, help);
            this.vscodeStream?.markdown(`> **Telegram:** /help\n\n${help}\n\n---\n\n`);
            return;
        }
        if (text === '/memory') {
            await this.sendMemorySummary(chatId);
            return;
        }
        // Heartbeat commands (/open mode only)
        if (text.startsWith('/heartbeat') && this._openMode) {
            await this.handleHeartbeatCommand(chatId, text);
            return;
        }
        // Cron commands (/open mode only)
        if (text.startsWith('/cron') && this._openMode) {
            await this.handleCronCommand(chatId, text);
            return;
        }

        if (this._openMode) {
            const cronDeletionTarget = extractNaturalLanguageCronDeletionTarget(text);
            if (cronDeletionTarget) {
                await this.deleteCronJobs(chatId, cronDeletionTarget, text);
                return;
            }
        }

        // All messages get full agentic mode (tools, terminal, file edits)
        await this.processPrompt(chatId, text);
    }

    // ── LLM Pipeline ─────────────────────────────────────────────

    private async processPrompt(chatId: number, prompt: string): Promise<void> {
        // Show the incoming message in VS Code chat
        this.vscodeStream?.markdown(`> **📩 Telegram:** ${prompt}\n\n`);

        try {
            await this.api!.sendChatAction(chatId, 'typing');

            const model = await this.modelManager.getActiveModel();

            // Build memory-augmented system prompt (telegram mode = true, openMode if active)
            const systemPrompt = await this.promptBuilder.build(prompt, model, true, this._openMode);

            // Assemble messages
            const messages: vscode.LanguageModelChatMessage[] = [
                vscode.LanguageModelChatMessage.User(systemPrompt),
            ];

            // Add conversation history
            for (const msg of this.conversationHistory) {
                messages.push(msg);
            }

            // Add current message
            messages.push(vscode.LanguageModelChatMessage.User(prompt));

            // Full tool access — always
            const tools = vscode.lm.tools.map(t => t as vscode.LanguageModelChatTool);

            const tokenSource = new vscode.CancellationTokenSource();
            const token = tokenSource.token;

            // Keep sending "typing" while we process
            const typingInterval = setInterval(() => {
                this.api?.sendChatAction(chatId, 'typing').catch(() => {});
            }, 4000);

            let responseText: string;
            try {
                const response = await model.sendRequest(messages, { tools }, token);

                // Use DualStream so output goes to both VS Code chat and Telegram
                const dual = new DualStream(this.vscodeStream);
                responseText = await this.toolRunner.processToolCalls(
                    response,
                    dual as unknown as vscode.ChatResponseStream,
                    model,
                    messages,
                    tools,
                    token,
                    this.toolInvocationToken,
                    undefined,
                );
            } finally {
                clearInterval(typingInterval);
                tokenSource.dispose();
            }

            // Update conversation history
            this.conversationHistory.push(vscode.LanguageModelChatMessage.User(prompt));
            if (responseText.trim()) {
                this.conversationHistory.push(vscode.LanguageModelChatMessage.Assistant(responseText));
            }

            // Trim history
            while (this.conversationHistory.length > TelegramBot.MAX_HISTORY * 2) {
                this.conversationHistory.shift();
            }

            // Send response to Telegram
            if (responseText.trim()) {
                await this.api!.sendMessage(chatId, responseText);
            } else {
                await this.api!.sendMessage(chatId, '(No response generated)');
            }

            // Separator in VS Code chat
            this.vscodeStream?.markdown('\n\n---\n\n');

            // Extract and store memories (fire-and-forget)
            const extractionToken = new vscode.CancellationTokenSource();
            this.memoryEngine.extractAndStore(prompt, responseText, extractionToken.token)
                .catch(() => {})
                .finally(() => extractionToken.dispose());

            // In /open mode: log to daily log AND auto-sync facts to MEMORY.md
            if (this._openMode) {
                WorkspaceMemory.appendToDailyLog(`User: ${prompt.substring(0, 100)}`).catch(() => {});
                WorkspaceMemory.appendToDailyLog(`Assistant: ${responseText.substring(0, 150)}`).catch(() => {});

                // Extract facts and sync to MEMORY.md (fire-and-forget)
                this.syncToWorkspaceMemory(prompt, responseText).catch(() => {});
            }

            // In /open mode, check if the response contains a CRON_PROPOSAL
            if (this._openMode && responseText.includes('```cron')) {
                await this.handleCronProposals(chatId, responseText);
            }

        } catch (err) {
            const errMsg = err instanceof Error ? err.message : String(err);
            await this.api!.sendMessage(chatId, `❌ Error: ${errMsg}`).catch(() => {});
            this.vscodeStream?.markdown(`\n\n❌ **Error:** ${errMsg}\n\n---\n\n`);
        }
    }

    // ── Utility Commands ─────────────────────────────────────────

    private async sendStatus(chatId: number): Promise<void> {
        const { daily, longterm } = await this.memoryEngine.getAllMemories();
        const model = await this.modelManager.getActiveModel().catch(() => null);

        const statusLines = [
            '🐾 CoClaw Status',
            '',
            `Mode: ${this._openMode ? '🦞 OpenClaw (/open)' : '📡 Auto (/auto)'}`,
            `Model: ${model?.name ?? 'unavailable'}`,
            `Long-term memories: ${longterm.length}`,
            `Today's log entries: ${daily.length}`,
            `Conversation turns: ${Math.floor(this.conversationHistory.length / 2)}`,
            `Tools available: ${vscode.lm.tools.length}`,
        ];

        if (this._openMode && this.heartbeat) {
            const hbStatus = this.heartbeat.getStatus();
            statusLines.push('');
            statusLines.push(`Heartbeat: ${hbStatus.running ? '✅ Active' : '⏸️ Paused'}`);
            statusLines.push(`Interval: ${hbStatus.intervalMinutes}m`);
            if (hbStatus.lastCheck > 0) {
                const ago = Math.round((Date.now() - hbStatus.lastCheck) / 60000);
                statusLines.push(`Last check: ${ago}m ago`);
            }
            const hasMemoryMd = await WorkspaceMemory.memoryMdExists();
            statusLines.push(`MEMORY.md: ${hasMemoryMd ? '✅' : '❌ not found'}`);

            if (this.cronScheduler) {
                const jobs = this.cronScheduler.getJobs();
                statusLines.push(`Cron jobs: ${jobs.length} (${jobs.filter(j => j.enabled).length} active)`);
            }
        }

        const status = statusLines.join('\n');
        await this.api!.sendMessage(chatId, status);
        this.vscodeStream?.markdown(`> **Telegram:** /status\n\n${status}\n\n---\n\n`);
    }

    private async sendMemorySummary(chatId: number): Promise<void> {
        const { daily, longterm } = await this.memoryEngine.getAllMemories();
        const lines: string[] = ['🧠 CoClaw Memory', ''];

        if (longterm.length > 0) {
            lines.push(`Long-Term (${longterm.length}):`);
            for (const entry of longterm.slice(0, 15)) {
                lines.push(`• [${entry.type}] ${entry.content.substring(0, 100)}`);
            }
            if (longterm.length > 15) {
                lines.push(`...and ${longterm.length - 15} more`);
            }
        } else {
            lines.push('No long-term memories yet.');
        }

        lines.push('');
        if (daily.length > 0) {
            lines.push(`Today's Log (${daily.length}):`);
            for (const entry of daily.slice(0, 10)) {
                lines.push(`• [${entry.type}] ${entry.content.substring(0, 100)}`);
            }
        }

        const text = lines.join('\n');
        await this.api!.sendMessage(chatId, text);
        this.vscodeStream?.markdown(`> **Telegram:** /memory\n\n${text}\n\n---\n\n`);
    }

    // ── Callback Query Handler ───────────────────────────────────

    private async handleCallbackQuery(query: TelegramCallbackQuery, authorizedUserId: number): Promise<void> {
        if (!query.from || query.from.id !== authorizedUserId) {
            await this.api?.answerCallbackQuery(query.id, '⛔ Unauthorized');
            return;
        }

        const data = query.data;
        if (!data) {
            await this.api?.answerCallbackQuery(query.id);
            return;
        }

        const chatId = query.message?.chat.id;
        const messageId = query.message?.message_id;

        if (data.startsWith('cron_ui:')) {
            await this.handleCronUiCallback(query.id, data, chatId, messageId);
            return;
        }

        // Handle cron confirmation: cron_yes:<proposalId> or cron_no:<proposalId>
        if (data.startsWith('cron_yes:') || data.startsWith('cron_no:')) {
            const [action, proposalId] = data.split(':');
            const proposal = this.pendingCronProposals.get(proposalId);

            if (!proposal) {
                await this.api?.answerCallbackQuery(query.id, '⏰ Proposal expired');
                return;
            }

            this.pendingCronProposals.delete(proposalId);

            if (action === 'cron_yes' && this.cronScheduler) {
                try {
                    const job = await this.cronScheduler.addJob(proposal.name, proposal.schedule, proposal.prompt);
                    const scheduleDesc = job.cron ?? (job.fireAt ? new Date(job.fireAt).toLocaleTimeString() : 'unknown');
                    const confirmText = `✅ Cron job created!\n\nName: ${job.name}\nSchedule: ${scheduleDesc}\nPrompt: ${job.prompt}`;
                    await this.api?.answerCallbackQuery(query.id, '✅ Created!');
                    if (chatId && messageId) {
                        await this.api?.editMessageText(chatId, messageId, confirmText);
                    }
                    this.vscodeStream?.markdown(`\n✅ Cron job "${job.name}" confirmed and created.\n\n---\n\n`);
                } catch (err) {
                    const msg = err instanceof Error ? err.message : String(err);
                    await this.api?.answerCallbackQuery(query.id, `❌ Error: ${msg}`);
                }
            } else {
                await this.api?.answerCallbackQuery(query.id, '❌ Cancelled');
                if (chatId && messageId) {
                    await this.api?.editMessageText(chatId, messageId, '❌ Cron job cancelled.');
                }
                this.vscodeStream?.markdown(`\n❌ Cron job "${proposal.name}" cancelled by user.\n\n---\n\n`);
            }
            return;
        }

        // Unknown callback
        await this.api?.answerCallbackQuery(query.id);
    }

    // ── Cron Proposal Parser ─────────────────────────────────────

    /**
     * Parse CRON_PROPOSAL blocks from LLM response and send Y/N confirmation buttons.
     */
    private async handleCronProposals(chatId: number, responseText: string): Promise<void> {
        const cronBlockRegex = /```cron\n([\s\S]*?)```/g;
        let match;

        while ((match = cronBlockRegex.exec(responseText)) !== null) {
            const block = match[1].trim();

            // Parse fields
            const scheduleLine = block.match(/SCHEDULE:\s*(.+)/i);
            const nameLine = block.match(/NAME:\s*(.+)/i);
            const promptLine = block.match(/PROMPT:\s*(.+)/i);

            if (!scheduleLine || !nameLine || !promptLine) { continue; }

            const schedule = scheduleLine[1].trim();
            const name = nameLine[1].trim();
            const prompt = promptLine[1].trim();

            // Generate a unique proposal ID
            const proposalId = `p${Date.now().toString(36)}${Math.random().toString(36).substring(2, 5)}`;

            // Store the pending proposal
            this.pendingCronProposals.set(proposalId, { schedule, name, prompt });

            // Auto-expire after 5 minutes
            setTimeout(() => {
                this.pendingCronProposals.delete(proposalId);
            }, 5 * 60 * 1000);

            // Send confirmation message with inline buttons
            const confirmMsg = `⏰ Schedule cron job?\n\nName: ${name}\nSchedule: ${schedule}\nTask: ${prompt}`;
            const buttons = [
                [
                    { text: '✅ Yes, create it', callback_data: `cron_yes:${proposalId}` },
                    { text: '❌ No, cancel', callback_data: `cron_no:${proposalId}` },
                ],
            ];

            await this.api!.sendMessageWithButtons(chatId, confirmMsg, buttons);
            this.vscodeStream?.markdown(`\n⏰ Cron proposal sent to Telegram for confirmation: "${name}"\n\n`);
        }
    }

    // ── Cron Commands ────────────────────────────────────────────

    private async handleCronCommand(chatId: number, text: string): Promise<void> {
        if (!this.cronScheduler) {
            await this.api!.sendMessage(chatId, '⚠️ Cron scheduler is not active.');
            return;
        }

        const args = text.replace('/cron', '').trim();
        const firstWord = args.split(/\s+/)[0]?.toLowerCase() ?? '';

        // /cron, /cron list, /cron gui
        if (!args || firstWord === 'list' || firstWord === 'ls' || firstWord === 'gui' || firstWord === 'menu') {
            await this.sendCronControlPanel(chatId);
            this.vscodeStream?.markdown(`> **Telegram:** ${text}\n\n`);
            return;
        }

        // /cron add <schedule> <name> | <prompt>
        // Example: /cron add 0 7 * * * Morning briefing | Summarize today's tasks
        // Example: /cron add 20m Reminder | Check if build passed
        if (firstWord === 'add' || firstWord === 'new' || firstWord === 'create') {
            const rest = args.replace(/^(add|new|create)\s+/i, '').trim();
            const pipeIdx = rest.indexOf('|');
            if (pipeIdx === -1) {
                await this.api!.sendMessage(chatId,
                    '❌ Format: /cron add <schedule> <name> | <prompt>\n\n' +
                    'Examples:\n' +
                    '• /cron add 0 7 * * * Morning briefing | Summarize inbox and calendar\n' +
                    '• /cron add 20m Reminder | Check if the build passed\n' +
                    '• /cron add 0 */2 * * * Health check | Check if the server is up'
                );
                return;
            }

            const beforePipe = rest.substring(0, pipeIdx).trim();
            const prompt = rest.substring(pipeIdx + 1).trim();

            if (!prompt) {
                await this.api!.sendMessage(chatId, '❌ Prompt is required after the | separator.');
                return;
            }

            // Parse: schedule is everything except the last word(s) which form the name
            // Heuristic: if it looks like a cron expression (contains * or starts with digits followed by space+digits),
            // take 5 fields as schedule, rest as name. Otherwise, first token is schedule, rest is name.
            const { schedule, name } = this.parseCronAddArgs(beforePipe);

            if (!schedule || !name) {
                await this.api!.sendMessage(chatId,
                    '❌ Could not parse schedule and name.\n\n' +
                    'Format: /cron add <schedule> <name> | <prompt>\n' +
                    'Schedule can be a cron expression (5 fields) or relative time (20m, 1h, etc.)'
                );
                return;
            }

            try {
                const job = await this.cronScheduler.addJob(name, schedule, prompt);
                const scheduleDesc = job.cron ?? (job.fireAt ? `fires at ${new Date(job.fireAt).toLocaleTimeString()}` : 'unknown');
                const reply = `✅ Cron job created!\n\nName: ${job.name}\nSchedule: ${scheduleDesc}\nPrompt: ${job.prompt}`;
                await this.api!.sendMessage(chatId, reply);
                this.vscodeStream?.markdown(`> **Telegram:** ${text}\n\n${reply}\n\n---\n\n`);
            } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                await this.api!.sendMessage(chatId, `❌ Failed to create job: ${msg}`);
            }
            return;
        }

        // /cron delete <name or id>
        if (firstWord === 'delete' || firstWord === 'del' || firstWord === 'rm' || firstWord === 'remove') {
            const nameOrId = args.replace(/^(delete|del|rm|remove)\s+/i, '').trim();
            await this.deleteCronJobs(chatId, nameOrId, text);
            return;
        }

        // /cron pause <name>
        if (firstWord === 'pause' || firstWord === 'disable' || firstWord === 'off') {
            const nameOrId = args.replace(/^(pause|disable|off)\s+/i, '').trim();
            const job = this.cronScheduler.getJob(nameOrId) ?? this.cronScheduler.findJobByName(nameOrId);
            if (!job) {
                await this.api!.sendMessage(chatId, `❌ Job not found: "${nameOrId}"`);
                return;
            }
            await this.cronScheduler.toggleJob(job.id, false);
            await this.api!.sendMessage(chatId, `⏸️ Paused job: ${job.name}`);
            return;
        }

        // /cron resume <name>
        if (firstWord === 'resume' || firstWord === 'enable' || firstWord === 'on') {
            const nameOrId = args.replace(/^(resume|enable|on)\s+/i, '').trim();
            const job = this.cronScheduler.getJob(nameOrId) ?? this.cronScheduler.findJobByName(nameOrId);
            if (!job) {
                await this.api!.sendMessage(chatId, `❌ Job not found: "${nameOrId}"`);
                return;
            }
            await this.cronScheduler.toggleJob(job.id, true);
            await this.api!.sendMessage(chatId, `▶️ Resumed job: ${job.name}`);
            return;
        }

        // Unknown sub-command
        await this.api!.sendMessage(chatId,
            '📋 Cron commands:\n\n' +
            '/cron — Open cron control panel\n' +
            '/cron list — Open cron control panel\n' +
            '/cron add <schedule> <name> | <prompt> — Add a job\n' +
            '/cron delete <name> — Delete a job\n' +
            '/cron pause <name> — Pause a job\n' +
            '/cron resume <name> — Resume a job\n\n' +
            'Schedule can be:\n' +
            '• Cron expression: 0 7 * * * (every day at 7am)\n' +
            '• Relative time: 20m, 1h, 2h30m (one-shot)\n'
        );
    }

    /**
     * Parse the before-pipe part of /cron add into schedule + name.
     * Handles both cron expressions (5 fields) and relative times (single token).
     */
    private parseCronAddArgs(beforePipe: string): { schedule: string; name: string } {
        const tokens = beforePipe.trim().split(/\s+/);

        // Try to detect a 5-field cron expression
        // A cron field looks like: *, a number, */n, n-m, or n,m,...
        const cronFieldPattern = /^(\*|(\*\/\d+)|\d+(-\d+)?(,\d+(-\d+)?)*)$/;
        if (tokens.length >= 6) {
            const first5 = tokens.slice(0, 5);
            if (first5.every(t => cronFieldPattern.test(t))) {
                return {
                    schedule: first5.join(' '),
                    name: tokens.slice(5).join(' ') || 'Unnamed job',
                };
            }
        }

        // Otherwise, first token is schedule (relative time), rest is name
        if (tokens.length >= 2) {
            return {
                schedule: tokens[0],
                name: tokens.slice(1).join(' '),
            };
        }

        // Only one token — it's the schedule, no name
        return {
            schedule: tokens[0] || '',
            name: 'Unnamed job',
        };
    }

    // ── Workspace Memory Sync ────────────────────────────────────

    /**
     * Extract facts from a conversation turn and sync to MEMORY.md.
     * Runs after each LLM response in /open mode (fire-and-forget).
     */
    private async syncToWorkspaceMemory(userMessage: string, assistantResponse: string): Promise<void> {
        try {
            const tokenSource = new vscode.CancellationTokenSource();
            const facts = await this.memoryExtractor.extract(userMessage, assistantResponse, tokenSource.token);
            tokenSource.dispose();

            if (facts.length > 0) {
                const synced = await WorkspaceMemory.syncFactsToMemoryMd(facts);
                if (synced > 0) {
                    console.log(`[CoClaw] Synced ${synced} facts to MEMORY.md`);
                }
            }
        } catch {
            // Silent failure — memory sync is best-effort
        }
    }

    // ── Heartbeat Commands ───────────────────────────────────────

    private async handleHeartbeatCommand(chatId: number, text: string): Promise<void> {
        const arg = text.replace('/heartbeat', '').trim().toLowerCase();

        if (arg === 'off' || arg === 'stop' || arg === 'pause') {
            if (this.heartbeat) {
                this.heartbeat.stop();
                const reply = '⏸️ Heartbeat paused.';
                await this.api!.sendMessage(chatId, reply);
                this.vscodeStream?.markdown(`> **Telegram:** ${text}\n\n${reply}\n\n---\n\n`);
            }
            return;
        }

        if (arg === 'on' || arg === 'start' || arg === 'resume') {
            if (this.heartbeat) {
                this.heartbeat.start();
                const reply = '✅ Heartbeat resumed.';
                await this.api!.sendMessage(chatId, reply);
                this.vscodeStream?.markdown(`> **Telegram:** ${text}\n\n${reply}\n\n---\n\n`);
            }
            return;
        }

        // Default: force a heartbeat check now
        if (this.heartbeat) {
            await this.api!.sendChatAction(chatId, 'typing');
            this.vscodeStream?.markdown(`> **Telegram:** /heartbeat\n\n`);
            const result = await this.heartbeat.forceCheck();
            if (result === 'HEARTBEAT_OK') {
                const reply = '💓 Heartbeat: All clear — nothing needs attention.';
                await this.api!.sendMessage(chatId, reply);
                this.vscodeStream?.markdown(`${reply}\n\n---\n\n`);
            }
            // If there's a finding, the heartbeat callback already sent it
        } else {
            await this.api!.sendMessage(chatId, '⚠️ Heartbeat is not active. Use /open mode to enable it.');
        }
    }

    private async deleteCronJobs(chatId: number, nameOrId: string, originalText: string): Promise<void> {
        if (!this.cronScheduler) {
            await this.api!.sendMessage(chatId, '⚠️ Cron scheduler is not active.');
            return;
        }

        const job = this.cronScheduler.getJob(nameOrId);
        if (job) {
            await this.cronScheduler.deleteJob(job.id);
            await this.api!.sendMessage(chatId, `🗑️ Deleted job: ${job.name}`);
            this.vscodeStream?.markdown(`> **Telegram:** ${originalText}\n\nDeleted cron job: ${job.name}\n\n---\n\n`);
            return;
        }

        const matches = this.cronScheduler.findJobsByName(nameOrId);
        if (matches.length === 0) {
            await this.api!.sendMessage(chatId, `❌ Job not found: "${nameOrId}"`);
            return;
        }

        const hasExactMatch = matches.some(jobMatch => jobMatch.name.toLowerCase() === nameOrId.toLowerCase());
        if (!hasExactMatch && matches.length > 1) {
            const options = matches.map(jobMatch => `• ${jobMatch.name} (${jobMatch.id})`).join('\n');
            await this.api!.sendMessage(
                chatId,
                `❌ Multiple jobs match "${nameOrId}". Use a more exact name or the job id:\n\n${options}`,
            );
            return;
        }

        for (const jobMatch of matches) {
            await this.cronScheduler.deleteJob(jobMatch.id);
        }

        const reply = matches.length === 1
            ? `🗑️ Deleted job: ${matches[0].name}`
            : `🗑️ Deleted ${matches.length} jobs named "${matches[0].name}"`;
        await this.api!.sendMessage(chatId, reply);
        this.vscodeStream?.markdown(`> **Telegram:** ${originalText}\n\n${reply}\n\n---\n\n`);
    }

    private async sendCronControlPanel(chatId: number, messageId?: number): Promise<void> {
        if (!this.cronScheduler) {
            await this.api!.sendMessage(chatId, '⚠️ Cron scheduler is not active.');
            return;
        }

        const { text, buttons } = buildCronControlPanel(this.cronScheduler.getJobs());

        if (messageId !== undefined) {
            await this.api!.editMessageText(chatId, messageId, text, 'HTML', buttons);
            return;
        }

        await this.api!.sendMessageWithButtons(chatId, text, buttons);
    }

    private async handleCronUiCallback(
        callbackQueryId: string,
        data: string,
        chatId?: number,
        messageId?: number,
    ): Promise<void> {
        if (!chatId || !messageId) {
            await this.api?.answerCallbackQuery(callbackQueryId, '⚠️ Cron panel unavailable');
            return;
        }

        if (!this.cronScheduler) {
            await this.api?.answerCallbackQuery(callbackQueryId, '⚠️ Cron scheduler inactive');
            await this.api?.editMessageText(chatId, messageId, '⚠️ Cron scheduler is not active.');
            return;
        }

        const [, action, jobId] = data.split(':');

        if (action === 'refresh') {
            await this.api?.answerCallbackQuery(callbackQueryId, '🔄 Refreshed');
            await this.sendCronControlPanel(chatId, messageId);
            return;
        }

        if (action === 'confirm_clear') {
            const panel = buildCronClearConfirmPanel(this.cronScheduler.getJobs().length);
            await this.api?.answerCallbackQuery(callbackQueryId, '⚠️ Confirm clear');
            await this.api?.editMessageText(chatId, messageId, panel.text, 'HTML', panel.buttons);
            return;
        }

        if (action === 'clear_all') {
            const cleared = await this.cronScheduler.clearAllJobs();
            await this.api?.answerCallbackQuery(callbackQueryId, `🧹 Cleared ${cleared}`);
            await this.sendCronControlPanel(chatId, messageId);
            return;
        }

        if (action === 'close') {
            await this.api?.answerCallbackQuery(callbackQueryId, '✖ Closed');
            await this.api?.editMessageText(chatId, messageId, '✖ Cron control panel closed. Send /cron to open it again.');
            return;
        }

        if (!jobId) {
            await this.api?.answerCallbackQuery(callbackQueryId, '⚠️ Invalid cron action');
            return;
        }

        const job = this.cronScheduler.getJob(jobId);
        if (!job) {
            await this.api?.answerCallbackQuery(callbackQueryId, '❌ Job not found');
            await this.sendCronControlPanel(chatId, messageId);
            return;
        }

        if (action === 'delete') {
            await this.cronScheduler.deleteJob(job.id);
            await this.api?.answerCallbackQuery(callbackQueryId, `🗑️ Deleted ${job.name}`);
            await this.sendCronControlPanel(chatId, messageId);
            return;
        }

        if (action === 'pause') {
            await this.cronScheduler.toggleJob(job.id, false);
            await this.api?.answerCallbackQuery(callbackQueryId, `⏸️ Paused ${job.name}`);
            await this.sendCronControlPanel(chatId, messageId);
            return;
        }

        if (action === 'resume') {
            await this.cronScheduler.toggleJob(job.id, true);
            await this.api?.answerCallbackQuery(callbackQueryId, `▶️ Resumed ${job.name}`);
            await this.sendCronControlPanel(chatId, messageId);
            return;
        }

        await this.api?.answerCallbackQuery(callbackQueryId, '⚠️ Unknown cron action');
    }

    private sleep(ms: number): Promise<void> {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}
