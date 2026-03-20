import * as vscode from 'vscode';
import { ModelManager } from '../lm/ModelManager';
import { PromptBuilder } from '../lm/PromptBuilder';
import { ToolRunner } from '../lm/ToolRunner';
import { ToolResultCache } from '../lm/ToolResultCache';
import { MemoryEngine } from '../memory/MemoryEngine';
import { StatusBar } from '../ui/statusBar';

export class ParticipantHandler {
    private readonly toolRunner = new ToolRunner();
    private readonly cache: ToolResultCache;
    private activeCancellation: vscode.CancellationTokenSource | undefined;

    constructor(
        private readonly modelManager: ModelManager,
        private readonly promptBuilder: PromptBuilder,
        private readonly memoryEngine: MemoryEngine,
        private readonly statusBar?: StatusBar,
    ) {
        this.cache = new ToolResultCache(memoryEngine);
        this.toolRunner.setCache(this.cache);
    }

    /**
     * Cancel the currently active response, if any.
     */
    stop(): void {
        if (this.activeCancellation) {
            this.activeCancellation.cancel();
            this.activeCancellation.dispose();
            this.activeCancellation = undefined;
            this.statusBar?.setBusy(false);
        }
    }

    get handler(): vscode.ChatRequestHandler {
        return this.handleRequest.bind(this);
    }

    private async handleRequest(
        request: vscode.ChatRequest,
        context: vscode.ChatContext,
        stream: vscode.ChatResponseStream,
        token: vscode.CancellationToken,
    ): Promise<vscode.ChatResult> {
        // Handle slash commands
        if (request.command) {
            return this.handleCommand(request, context, stream, token);
        }

        try {
            // Cancel any previous in-flight response
            this.stop();

            // Create a linked cancellation that fires when either the
            // VS Code chat token OR our manual stop() is triggered
            this.activeCancellation = new vscode.CancellationTokenSource();
            const linkedToken = this.activeCancellation.token;

            // Forward VS Code's chat cancellation to our source
            const chatCancelListener = token.onCancellationRequested(() => this.stop());

            stream.progress('Preparing response...');
            this.statusBar?.setBusy(true);

            const result = await vscode.window.withProgress(
                {
                    location: vscode.ProgressLocation.Window,
                    title: 'CoClaw',
                },
                async (progress) => {
                    progress.report({ message: 'Loading model...' });
                    const model = await this.modelManager.getActiveModel();

                    // Build memory-augmented system prompt
                    progress.report({ message: 'Recalling memories...' });
                    stream.progress('Recalling memories...');
                    const systemPrompt = await this.promptBuilder.build(request.prompt, model);

                    // Check context flush
                    const estimatedTokens = this.estimateTokens(request.prompt) + this.estimateTokens(systemPrompt);
                    if (estimatedTokens > model.maxInputTokens * 0.8) {
                        await this.memoryEngine.flushSessionToDaily('Context approaching limit — auto-saving key facts.');
                    }

                    // Build message array
                    const messages: vscode.LanguageModelChatMessage[] = [
                        vscode.LanguageModelChatMessage.User(systemPrompt),
                    ];

                    // Add history from chat context
                    for (const turn of context.history) {
                        if (turn instanceof vscode.ChatRequestTurn) {
                            messages.push(vscode.LanguageModelChatMessage.User(turn.prompt));
                        } else if (turn instanceof vscode.ChatResponseTurn) {
                            const text = turn.response
                                .filter((r): r is vscode.ChatResponseMarkdownPart => r instanceof vscode.ChatResponseMarkdownPart)
                                .map(r => r.value.value)
                                .join('');
                            if (text) {
                                messages.push(vscode.LanguageModelChatMessage.Assistant(text));
                            }
                        }
                    }

                    // Add current message
                    messages.push(vscode.LanguageModelChatMessage.User(request.prompt));

                    // Get ALL registered tools so the model can edit files, run commands, etc.
                    const tools = vscode.lm.tools.map(t => t as vscode.LanguageModelChatTool);

                    progress.report({ message: 'Thinking...' });
                    stream.progress('Thinking...');
                    const response = await model.sendRequest(messages, { tools }, linkedToken);
                    const fullResponse = await this.toolRunner.processToolCalls(response, stream, model, messages, tools, linkedToken, request.toolInvocationToken, progress);

                    return fullResponse;
                },
            );

            chatCancelListener.dispose();
            this.activeCancellation?.dispose();
            this.activeCancellation = undefined;
            this.statusBar?.setBusy(false);

            // Extract and store memories from the conversation (fire-and-forget with a new cancellation token)
            const extractionTokenSource = new vscode.CancellationTokenSource();
            this.memoryEngine.extractAndStore(request.prompt, result, extractionTokenSource.token)
                .catch(() => { /* silent failure for extraction */ })
                .finally(() => extractionTokenSource.dispose());

            return {};
        } catch (err) {
            this.activeCancellation?.dispose();
            this.activeCancellation = undefined;
            this.statusBar?.setBusy(false);
            if (err instanceof vscode.LanguageModelError) {
                if (err.code === vscode.LanguageModelError.NotFound.name) {
                    stream.markdown('No Copilot model available. Please ensure GitHub Copilot is installed and active.');
                } else if (err.code === vscode.LanguageModelError.Blocked.name) {
                    stream.markdown('The request was blocked by the model. Please try rephrasing.');
                } else if (err.code === vscode.LanguageModelError.NoPermissions.name) {
                    stream.markdown('CoClaw needs permission to use this model. Please approve the consent dialog.');
                } else {
                    stream.markdown(`Model error: ${err.message}`);
                }
            } else {
                throw err;
            }
            return {};
        }
    }

    private async handleCommand(
        request: vscode.ChatRequest,
        _context: vscode.ChatContext,
        stream: vscode.ChatResponseStream,
        token: vscode.CancellationToken,
    ): Promise<vscode.ChatResult> {
        switch (request.command) {
            case 'memory':
                return this.handleMemoryCommand(stream);
            case 'distill':
                return this.handleDistillCommand(stream, token);
            case 'clear':
                return this.handleClearCommand(stream);
            case 'soul':
                return this.handleSoulCommand(stream);
            default:
                stream.markdown(`Unknown command: /${request.command}`);
                return {};
        }
    }

    private async handleMemoryCommand(stream: vscode.ChatResponseStream): Promise<vscode.ChatResult> {
        const { daily, longterm } = await this.memoryEngine.getAllMemories();

        stream.markdown(`## CoClaw Memory\n\n`);
        stream.markdown(`**Long-term memories:** ${longterm.length}\n`);
        stream.markdown(`**Today's log entries:** ${daily.length}\n\n`);

        if (longterm.length > 0) {
            stream.markdown(`### Long-Term Memory\n`);
            for (const entry of longterm.slice(0, 20)) {
                stream.markdown(`- **[${entry.type}]** ${entry.content} *(importance: ${entry.importance.toFixed(1)})*\n`);
            }
            if (longterm.length > 20) {
                stream.markdown(`\n*...and ${longterm.length - 20} more. Use \`CoClaw: Browse Memory\` command to see all.*\n`);
            }
        }

        if (daily.length > 0) {
            stream.markdown(`\n### Today's Session Log\n`);
            for (const entry of daily.slice(0, 10)) {
                stream.markdown(`- **[${entry.type}]** ${entry.content}\n`);
            }
            if (daily.length > 10) {
                stream.markdown(`\n*...and ${daily.length - 10} more.*\n`);
            }
        }

        return {};
    }

    private async handleDistillCommand(
        stream: vscode.ChatResponseStream,
        token: vscode.CancellationToken,
    ): Promise<vscode.ChatResult> {
        stream.markdown('Distilling daily logs into long-term memory...\n\n');

        const count = await this.memoryEngine.distill(token);

        if (count > 0) {
            stream.markdown(`Distilled **${count}** entries into long-term memory.`);
        } else {
            stream.markdown('No entries to distill, or distillation produced no results.');
        }

        return {};
    }

    private async handleClearCommand(stream: vscode.ChatResponseStream): Promise<vscode.ChatResult> {
        await this.memoryEngine.clearDailyLogs();
        stream.markdown("Today's session memory has been cleared.");
        return {};
    }

    private async handleSoulCommand(stream: vscode.ChatResponseStream): Promise<vscode.ChatResult> {
        stream.markdown('Opening SOUL.json for editing...\n\n');
        stream.markdown('Use `CoClaw: Edit Identity (SOUL)` command to edit the assistant persona.');
        await vscode.commands.executeCommand('CoClaw.editSoul');
        return {};
    }

    private estimateTokens(text: string): number {
        return Math.ceil(text.length / 4);
    }
}
