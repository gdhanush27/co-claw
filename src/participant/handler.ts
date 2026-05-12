import * as vscode from 'vscode';
import { ModelManager, TIERS } from '../lm/ModelManager';
import { PromptBuilder } from '../lm/PromptBuilder';
import { ToolRunner } from '../lm/ToolRunner';
import { ToolResultCache } from '../lm/ToolResultCache';
import { getAutonomousTools } from '../lm/toolFilter';
import { matchModels } from '../lm/modelLookup';
import { MemoryEngine } from '../memory/MemoryEngine';
import { StatusBar } from '../ui/statusBar';
import { TelegramBot } from '../telegram/TelegramBot';
import { Orchestrator } from '../agents/Orchestrator';
import type { TaskDifficulty } from '../agents/types';

const VALID_TIERS: ReadonlySet<TaskDifficulty> = new Set(TIERS);
function isValidTier(v: string): v is TaskDifficulty {
    return VALID_TIERS.has(v as TaskDifficulty);
}

export class ParticipantHandler {
    private readonly toolRunner = new ToolRunner();
    private readonly cache: ToolResultCache;
    private activeCancellation: vscode.CancellationTokenSource | undefined;
    private telegramBot: TelegramBot | undefined;

    constructor(
        private readonly modelManager: ModelManager,
        private readonly promptBuilder: PromptBuilder,
        private readonly memoryEngine: MemoryEngine,
        private readonly statusBar?: StatusBar,
        private readonly orchestrator?: Orchestrator,
    ) {
        this.cache = new ToolResultCache(memoryEngine);
        this.toolRunner.setCache(this.cache);
    }

    setTelegramBot(bot: TelegramBot): void {
        this.telegramBot = bot;
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

        // 'always' mode: route every non-command prompt through the orchestrator
        const agentsMode = vscode.workspace.getConfiguration('CoClaw.agents').get<string>('mode', 'slash');
        if (agentsMode === 'always' && this.orchestrator) {
            return this.runOrchestrator(request, stream, token);
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

                    // All registered tools that work without an interactive UI
                    // prompt. We explicitly exclude e.g. simple-browser /
                    // live-preview tools because those hang waiting for the
                    // user to click a confirmation dialog — see toolFilter.
                    const tools = getAutonomousTools();

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
            case 'auto':
                return this.handleAutoCommand(request, stream, token);
            case 'open':
                return this.handleOpenCommand(request, stream, token);
            case 'agents':
                return this.runOrchestrator(request, stream, token);
            case 'model':
                return this.handleModelCommand(request, stream);
            default:
                stream.markdown(`Unknown command: /${request.command}`);
                return {};
        }
    }

    /**
     * `/model` chat command. Sub-syntax:
     *
     *   /model                          → show status (general + per-tier) with one-click buttons
     *   /model list                     → list available Copilot model families
     *   /model help                     → usage reminder
     *   /model <family-or-name>         → switch the GENERAL model (e.g. "/model gpt-4o-mini")
     *   /model tier <tier>              → open the QuickPick for that tier (light/medium/hard)
     *   /model tier <tier> <family>     → set the tier model directly (e.g. "/model tier hard claude-opus-4")
     *   /model clear                    → drop the general model override (revert to first available)
     *   /model clear <tier>             → drop the tier override (revert to general default)
     *
     * All persistence flows through ModelManager (same path used by the
     * settings GUI, the QuickPick, and Telegram /models) so every surface
     * sees the change immediately.
     */
    private async handleModelCommand(
        request: vscode.ChatRequest,
        stream: vscode.ChatResponseStream,
    ): Promise<vscode.ChatResult> {
        const args = request.prompt.trim().split(/\s+/).filter(s => s.length > 0);
        const sub = (args[0] ?? '').toLowerCase();

        try {
            if (args.length === 0) {
                await this.renderModelStatus(stream);
                return {};
            }
            if (sub === 'help' || sub === '?') {
                this.renderModelHelp(stream);
                return {};
            }
            if (sub === 'list' || sub === 'ls') {
                await this.renderModelList(stream);
                return {};
            }
            if (sub === 'clear') {
                await this.handleModelClear(stream, args[1]);
                return {};
            }
            if (sub === 'tier') {
                await this.handleModelTier(stream, args[1], args.slice(2).join(' '));
                return {};
            }
            // Default: treat the whole prompt as a model identifier.
            await this.handleModelSwitch(stream, request.prompt.trim());
            return {};
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            stream.markdown(`❌ ${msg}\n`);
            return {};
        }
    }

    private async renderModelStatus(stream: vscode.ChatResponseStream): Promise<void> {
        const active = await this.modelManager.getActiveModel().catch(() => undefined);
        const generalPref = this.modelManager.getPreferredFamily();
        const tiers = this.modelManager.getAllTierFamilies();

        stream.markdown(`## 🤖 CoClaw model\n\n`);
        if (active) {
            stream.markdown(`**Active general model:** \`${active.name}\` (family \`${active.family}\`, ${active.maxInputTokens.toLocaleString()} tokens)\n`);
        } else {
            stream.markdown(`**Active general model:** _(no Copilot model available — install/sign in to Copilot)_\n`);
        }
        if (generalPref) {
            stream.markdown(`Preferred family: \`${generalPref}\`\n`);
        } else {
            stream.markdown(`Preferred family: _(none — auto-pick first available)_\n`);
        }
        stream.markdown(`\n**Per-tier overrides (used by \`/agents\`):**\n`);
        for (const t of TIERS) {
            const v = tiers[t];
            stream.markdown(`- \`${t}\` → ${v ? `\`${v}\`` : '_(default — uses general model)_'}\n`);
        }
        stream.markdown(`\n`);
        stream.button({ title: '🔧 Pick general model', command: 'CoClaw.selectModel' });
        for (const t of TIERS) {
            stream.button({
                title: `🎯 Pick ${t} tier`,
                command: 'CoClaw.selectTierModels',
                arguments: [t],
            });
        }
        stream.markdown(
            `\n_Quick commands:_ \`/model list\`, \`/model gpt-4o-mini\`, \`/model tier hard claude-opus-4\`, \`/model clear\`, \`/model clear hard\`\n`,
        );
    }

    private renderModelHelp(stream: vscode.ChatResponseStream): void {
        stream.markdown(
            `### \`/model\` usage\n\n` +
            `| Command | Effect |\n` +
            `|---|---|\n` +
            `| \`/model\` | Show current model and per-tier overrides |\n` +
            `| \`/model list\` | List available Copilot model families |\n` +
            `| \`/model <family-or-name>\` | Switch the general model (e.g. \`/model gpt-4o-mini\`) |\n` +
            `| \`/model tier <tier>\` | Open a picker for that tier (\`light\`/\`medium\`/\`hard\`) |\n` +
            `| \`/model tier <tier> <family>\` | Set tier model directly (e.g. \`/model tier hard claude-opus-4\`) |\n` +
            `| \`/model clear\` | Drop the general override |\n` +
            `| \`/model clear <tier>\` | Drop the tier override |\n`,
        );
    }

    private async renderModelList(stream: vscode.ChatResponseStream): Promise<void> {
        const models = await this.modelManager.getAvailableModels(true);
        if (models.length === 0) {
            stream.markdown(`_No Copilot models available. Install / sign in to GitHub Copilot first._\n`);
            return;
        }
        const seen = new Map<string, vscode.LanguageModelChat>();
        for (const m of models) {
            if (!seen.has(m.family)) { seen.set(m.family, m); }
        }
        stream.markdown(`### Available Copilot model families (${seen.size})\n\n`);
        for (const m of seen.values()) {
            stream.markdown(`- \`${m.family}\` — **${m.name}** (${m.maxInputTokens.toLocaleString()} tokens)\n`);
        }
        stream.markdown(`\n_Switch with \`/model <family>\` — e.g. \`/model ${[...seen.keys()][0]}\`._\n`);
    }

    private async handleModelSwitch(stream: vscode.ChatResponseStream, query: string): Promise<void> {
        const models = await this.modelManager.getAvailableModels(true);
        if (models.length === 0) {
            stream.markdown(`_No Copilot models available. Install / sign in to GitHub Copilot first._\n`);
            return;
        }
        const matches = matchModels(models, query);
        if (matches.length === 0) {
            stream.markdown(`No Copilot model matched \`${escapeInline(query)}\`.\n\n`);
            await this.renderModelList(stream);
            return;
        }
        if (matches.length === 1) {
            const m = matches[0];
            await this.modelManager.setPreferredFamily(m.family);
            await this.statusBar?.update();
            stream.markdown(`✅ Switched general model to **${m.name}** (\`${m.family}\`).\n`);
            return;
        }
        // Ambiguous — render disambiguation buttons.
        stream.markdown(`\`${escapeInline(query)}\` matched ${matches.length} models. Pick one:\n\n`);
        for (const m of matches) {
            stream.button({
                title: `${m.name} (${m.family})`,
                command: 'CoClaw.setModelFamily',
                arguments: [m.family],
            });
        }
    }

    private async handleModelTier(
        stream: vscode.ChatResponseStream,
        rawTier: string | undefined,
        familyQuery: string,
    ): Promise<void> {
        if (!rawTier) {
            stream.markdown(
                `Usage: \`/model tier <light|medium|hard> [family]\`. Without a family, a picker opens.\n`,
            );
            return;
        }
        const tier = rawTier.toLowerCase();
        if (!isValidTier(tier)) {
            stream.markdown(`Unknown tier \`${escapeInline(rawTier)}\`. Use one of: \`light\`, \`medium\`, \`hard\`.\n`);
            return;
        }
        if (!familyQuery) {
            // Defer to the QuickPick — it owns the live model list.
            await vscode.commands.executeCommand('CoClaw.selectTierModels', tier);
            return;
        }
        const models = await this.modelManager.getAvailableModels(true);
        if (models.length === 0) {
            stream.markdown(`_No Copilot models available. Install / sign in to GitHub Copilot first._\n`);
            return;
        }
        const matches = matchModels(models, familyQuery);
        if (matches.length === 0) {
            stream.markdown(`No Copilot model matched \`${escapeInline(familyQuery)}\`.\n\n`);
            await this.renderModelList(stream);
            return;
        }
        if (matches.length === 1) {
            const m = matches[0];
            await this.modelManager.setTierFamily(tier, m.family);
            stream.markdown(`✅ \`${tier}\` tier set to **${m.name}** (\`${m.family}\`).\n`);
            return;
        }
        stream.markdown(`\`${escapeInline(familyQuery)}\` matched ${matches.length} models for the **${tier}** tier. Pick one:\n\n`);
        for (const m of matches) {
            stream.button({
                title: `${m.name} (${m.family})`,
                command: 'CoClaw.setTierModel',
                arguments: [tier, m.family],
            });
        }
    }

    private async handleModelClear(stream: vscode.ChatResponseStream, target: string | undefined): Promise<void> {
        if (!target || target.toLowerCase() === 'general' || target.toLowerCase() === 'family') {
            await this.modelManager.setPreferredFamily('');
            await this.statusBar?.update();
            stream.markdown(`🗑 Cleared the general model preference. CoClaw will pick the first available Copilot model.\n`);
            return;
        }
        const tier = target.toLowerCase();
        if (!isValidTier(tier)) {
            stream.markdown(`Unknown clear target \`${escapeInline(target)}\`. Use \`/model clear\` (general) or \`/model clear <light|medium|hard>\`.\n`);
            return;
        }
        await this.modelManager.setTierFamily(tier, undefined);
        stream.markdown(`🗑 Cleared the \`${tier}\` tier override. That tier will now use the general model.\n`);
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

    private async runOrchestrator(
        request: vscode.ChatRequest,
        stream: vscode.ChatResponseStream,
        token: vscode.CancellationToken,
    ): Promise<vscode.ChatResult> {
        const mode = vscode.workspace.getConfiguration('CoClaw.agents').get<string>('mode', 'slash');
        if (mode === 'off') {
            stream.markdown('Multi-agent orchestration is disabled. Set `CoClaw.agents.mode` to `slash` or `always` to enable.');
            return {};
        }
        if (!this.orchestrator) {
            stream.markdown('Orchestrator is not initialized.');
            return {};
        }

        // Cancel any prior in-flight response and link cancellation
        this.stop();
        this.activeCancellation = new vscode.CancellationTokenSource();
        const linkedToken = this.activeCancellation.token;
        const chatCancelListener = token.onCancellationRequested(() => this.stop());
        this.statusBar?.setBusy(true);

        try {
            await this.orchestrator.run(request.prompt, stream, linkedToken, request.toolInvocationToken);
        } finally {
            chatCancelListener.dispose();
            this.activeCancellation?.dispose();
            this.activeCancellation = undefined;
            this.statusBar?.setBusy(false);
        }
        return {};
    }

    private async handleAutoCommand(
        request: vscode.ChatRequest,
        stream: vscode.ChatResponseStream,
        token: vscode.CancellationToken,
    ): Promise<vscode.ChatResult> {
        if (!this.telegramBot) {
            stream.markdown('Telegram bot is not initialized. Please restart the extension.');
            return {};
        }

        if (this.telegramBot.isRunning) {
            stream.markdown('⚠️ Telegram bridge is already running. Send `/stop` in Telegram or unlink via command palette to stop it.');
            return {};
        }

        try {
            stream.markdown('⚠️ **Deprecation notice:** `/auto` will be removed in version **1.0.0**. Please use `/open` instead.\n\n');
            stream.markdown('🚀 **Starting Telegram bridge...**\n\n');
            await this.telegramBot.start(stream, request.toolInvocationToken);

            const stoppedPromise = this.telegramBot.stoppedPromise ?? Promise.resolve();
            const cancelPromise = new Promise<void>((resolve) => {
                token.onCancellationRequested(() => {
                    this.telegramBot?.stop();
                    resolve();
                });
            });

            await Promise.race([stoppedPromise, cancelPromise]);

            stream.markdown('\n\n🛑 **Telegram bridge stopped.**');
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            stream.markdown(`❌ Failed to start Telegram bot: ${msg}\n\nMake sure you have linked your bot first using **CoClaw: Link Telegram Bot**.`);
        }

        return {};
    }

    private async handleOpenCommand(
        request: vscode.ChatRequest,
        stream: vscode.ChatResponseStream,
        token: vscode.CancellationToken,
    ): Promise<vscode.ChatResult> {
        if (!this.telegramBot) {
            stream.markdown('Telegram bot is not initialized. Please restart the extension.');
            return {};
        }

        if (this.telegramBot.isRunning) {
            if (this.telegramBot.isOpenMode) {
                stream.markdown('⚠️ **OpenClaw mode is already running.** Send `/stop` in Telegram to stop it.');
            } else {
                stream.markdown('⚠️ Telegram bridge is already running in `/auto` mode. Send `/stop` in Telegram first, then use `/open`.');
            }
            return {};
        }

        // Check workspace
        const folders = vscode.workspace.workspaceFolders;
        if (!folders || folders.length === 0) {
            stream.markdown('❌ No workspace folder open. `/open` requires a workspace to operate on.');
            return {};
        }

        try {
            stream.markdown('🦞 **Starting OpenClaw mode...**\n\n');
            stream.markdown(`Workspace: \`${folders[0].name}\`\n\n`);

            // Start in openMode=true
            await this.telegramBot.start(stream, request.toolInvocationToken, true);

            const stoppedPromise = this.telegramBot.stoppedPromise ?? Promise.resolve();
            const cancelPromise = new Promise<void>((resolve) => {
                token.onCancellationRequested(() => {
                    this.telegramBot?.stop();
                    resolve();
                });
            });

            await Promise.race([stoppedPromise, cancelPromise]);

            stream.markdown('\n\n🛑 **OpenClaw mode stopped.**');
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            stream.markdown(`❌ Failed to start OpenClaw mode: ${msg}\n\nMake sure you have linked your bot first using **CoClaw: Link Telegram Bot**.`);
        }

        return {};
    }

    private estimateTokens(text: string): number {
        return Math.ceil(text.length / 4);
    }
}

/**
 * Strip / escape characters that would close an inline-code span when we
 * echo user-supplied tokens back inside backticks. Defense-in-depth: keeps
 * a user typing `` ` `` or `</details>` from poisoning the chat stream.
 */
function escapeInline(s: string): string {
    return s.replace(/`/g, '').replace(/[\r\n]+/g, ' ').slice(0, 120);
}
