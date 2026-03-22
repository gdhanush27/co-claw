import * as vscode from 'vscode';
import { TelegramApi, TelegramUpdate, TelegramCallbackQuery } from './TelegramApi';
import { TelegramConfig } from './TelegramConfig';
import { ModelManager } from '../lm/ModelManager';
import { PromptBuilder } from '../lm/PromptBuilder';
import { ToolRunner } from '../lm/ToolRunner';
import { ToolResultCache } from '../lm/ToolResultCache';
import { MemoryEngine } from '../memory/MemoryEngine';
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

    /** The active VS Code chat stream (set when /auto is running). */
    private vscodeStream: vscode.ChatResponseStream | undefined;

    /** Tool invocation token from the /auto chat request — makes tool calls trusted. */
    private toolInvocationToken: vscode.ChatParticipantToolToken | undefined;

    /** Resolves when the polling loop exits. Used by handleAutoCommand to keep the stream alive. */
    private stoppedResolve: (() => void) | undefined;
    private _stoppedPromise: Promise<void> | undefined;

    private static readonly MAX_HISTORY = 20;

    constructor(
        private readonly config: TelegramConfig,
        private readonly modelManager: ModelManager,
        private readonly promptBuilder: PromptBuilder,
        private readonly memoryEngine: MemoryEngine,
        private readonly statusBar?: StatusBar,
    ) {
        this.cache = new ToolResultCache(memoryEngine);
        this.toolRunner.setCache(this.cache);
    }

    get isRunning(): boolean {
        return this.polling;
    }

    /** Promise that resolves when the bot stops. Used by /auto handler to keep stream alive. */
    get stoppedPromise(): Promise<void> | undefined {
        return this._stoppedPromise;
    }

    /**
     * Start the bot with an optional VS Code chat stream for dual output.
     * Called from the /auto slash command handler.
     */
    async start(stream?: vscode.ChatResponseStream, toolToken?: vscode.ChatParticipantToolToken): Promise<void> {
        const token = await this.config.getBotToken();
        const userId = this.config.getUserId();
        if (!token || !userId) {
            throw new Error('Telegram bot is not configured. Use "CoClaw: Link Telegram" first.');
        }

        this.api = new TelegramApi(token);
        this.vscodeStream = stream;
        this.toolInvocationToken = toolToken;

        // Verify the token works
        const me = await this.api.getMe();
        const botName = `@${me.username ?? me.first_name}`;

        // Flush any stale updates from the Telegram queue (old /stop, messages
        // sent while bot was offline, etc.) so they don't fire on reconnect.
        await this.flushPendingUpdates();

        const startMsg = `🐾 **CoClaw Telegram bot connected as ${botName}**\n\nSend messages to your bot in Telegram — responses will appear here and in Telegram.\n\n---\n\n`;
        stream?.markdown(startMsg);

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
            const help = [
                '🐾 *CoClaw Telegram Commands*',
                '',
                'Just send any message — full agentic mode with all tools.',
                '/status — Show connection status',
                '/clear — Clear conversation history',
                '/stop — Stop the Telegram bridge',
                '/memory — Show memory summary',
                '/help — This message',
            ].join('\n');
            await this.api!.sendMessage(chatId, help);
            this.vscodeStream?.markdown(`> **Telegram:** /help\n\n${help}\n\n---\n\n`);
            return;
        }
        if (text === '/memory') {
            await this.sendMemorySummary(chatId);
            return;
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

            // Build memory-augmented system prompt (telegram mode = true)
            const systemPrompt = await this.promptBuilder.build(prompt, model, true);

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

        const status = [
            '🐾 CoClaw Status',
            '',
            `Model: ${model?.name ?? 'unavailable'}`,
            `Long-term memories: ${longterm.length}`,
            `Today's log entries: ${daily.length}`,
            `Conversation turns: ${Math.floor(this.conversationHistory.length / 2)}`,
            `Tools available: ${vscode.lm.tools.length}`,
        ].join('\n');

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

    private sleep(ms: number): Promise<void> {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}
