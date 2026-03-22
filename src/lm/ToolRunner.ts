import * as vscode from 'vscode';
import * as path from 'path';
import { ToolResultCache } from './ToolResultCache';

export class ToolRunner {
    private static readonly MAX_TOOL_ROUNDS = 30;
    private static readonly MAX_RESULT_CHARS = 16000;
    private static readonly MAX_CONTINUATIONS = 5;
    private static readonly MAX_READ_ONLY_ROUNDS = 5;
    private cache: ToolResultCache | undefined;

    setCache(cache: ToolResultCache): void {
        this.cache = cache;
    }

    async processToolCalls(
        response: vscode.LanguageModelChatResponse,
        stream: vscode.ChatResponseStream,
        model: vscode.LanguageModelChat,
        messages: vscode.LanguageModelChatMessage[],
        tools: vscode.LanguageModelChatTool[],
        token: vscode.CancellationToken,
        toolInvocationToken?: vscode.ChatParticipantToolToken,
        progress?: vscode.Progress<{ message?: string }>,
    ): Promise<string> {
        let fullText = '';
        let currentResponse = response;
        let round = 0;
        let continuations = 0;
        let hasToolCalls = false; // Track if any tool calls were made this session
        let hasCodeToolCalls = false; // Track if code-editing tools were used (not just memory)
        let consecutiveReadOnlyRounds = 0; // Track exploration spiral
        let hasMadeEdits = false; // Track if any mutations happened
        // Track the index where tool-round messages start (after system + history + user prompt)
        const baseMessageCount = messages.length;

        while (round < ToolRunner.MAX_TOOL_ROUNDS) {
            // Check for cancellation between rounds
            if (token.isCancellationRequested) {
                stream.markdown('\n\n*Response stopped by user.*');
                break;
            }

            round++;
            const toolCalls: vscode.LanguageModelToolCallPart[] = [];
            let roundText = '';

            // Consume the entire response stream
            for await (const part of currentResponse.stream) {
                if (part instanceof vscode.LanguageModelTextPart) {
                    stream.markdown(part.value);
                    fullText += part.value;
                    roundText += part.value;
                } else if (part instanceof vscode.LanguageModelToolCallPart) {
                    toolCalls.push(part);
                }
            }

            // If no tool calls, check if the model stopped too early
            if (toolCalls.length === 0) {
                // Only continue if code-editing tools were used (not just memory/context tools)
                // and the response looks structurally incomplete
                if (hasCodeToolCalls && continuations < ToolRunner.MAX_CONTINUATIONS && this.looksIncomplete(roundText)) {
                    continuations++;
                    if (roundText.trim()) {
                        messages.push(vscode.LanguageModelChatMessage.Assistant(roundText));
                    }
                    messages.push(vscode.LanguageModelChatMessage.User(
                        'If there are remaining files to edit, continue making changes now using tools. Otherwise, stop here.'
                    ));
                    try {
                        currentResponse = await model.sendRequest(messages, { tools }, token);
                        continue;
                    } catch {
                        break;
                    }
                }
                break;
            }

            // Track that tool calls have been made in this session
            hasToolCalls = true;

            // Track if any non-memory, non-context tools were used (actual code work)
            for (const call of toolCalls) {
                if (this.isCodeTool(call.name)) {
                    hasCodeToolCalls = true;
                    break;
                }
            }

            // Detect exploration spiral: all tools in this round are read-only
            const allReadOnly = toolCalls.every(c => this.isReadOnlyTool(c.name));
            if (allReadOnly && !hasMadeEdits) {
                consecutiveReadOnlyRounds++;
            } else {
                consecutiveReadOnlyRounds = 0;
                if (!allReadOnly) {
                    hasMadeEdits = true;
                }
            }

            // Show progress for tool round
            stream.progress(`Working... (tool round ${round})`);
            progress?.report({ message: `Tool round ${round}...` });

            // Invoke all tool calls and collect results
            const assistantParts: (vscode.LanguageModelTextPart | vscode.LanguageModelToolCallPart)[] = [];
            const resultParts: (vscode.LanguageModelTextPart | vscode.LanguageModelToolResultPart)[] = [];

            if (roundText.trim()) {
                assistantParts.push(new vscode.LanguageModelTextPart(roundText));
            }

            for (const call of toolCalls) {
                // Check for cancellation before each tool invocation
                if (token.isCancellationRequested) {
                    stream.markdown('\n\n*Response stopped by user.*');
                    return fullText;
                }

                assistantParts.push(new vscode.LanguageModelToolCallPart(call.callId, call.name, call.input));

                // Show per-tool progress
                const friendlyName = call.name.replace(/_/g, ' ');
                stream.progress(`Running: ${friendlyName}`);
                progress?.report({ message: `Running: ${friendlyName}` });

                // Check session cache first — prevent redundant tool calls
                const cached = this.cache?.get(call.name, call.input);
                if (cached !== undefined) {
                    resultParts.push(new vscode.LanguageModelToolResultPart(call.callId, [
                        new vscode.LanguageModelTextPart(`[cached] ${cached}`),
                    ]));
                    continue;
                }

                const toolResult = await this.invokeTool(call.name, call.input, token, toolInvocationToken);

                // Extract text for caching, but pass original content to the model
                const resultText = this.extractResultText(toolResult);
                const truncatedContent = this.truncateToolResult(toolResult);

                // Cache the result for in-session dedup
                this.cache?.set(call.name, call.input, resultText);

                // Persist valuable results (file reads, searches) to memory for future sessions
                this.cache?.persistIfValuable(call.name, call.input, resultText).catch(() => {});

                resultParts.push(new vscode.LanguageModelToolResultPart(call.callId, truncatedContent));
            }

            messages.push(vscode.LanguageModelChatMessage.Assistant(assistantParts));
            messages.push(vscode.LanguageModelChatMessage.User(resultParts));

            // Trim old tool-round messages if context is getting large
            this.trimContextIfNeeded(messages, baseMessageCount, model.maxInputTokens);

            // If stuck in exploration spiral, inject a nudge to start implementing
            if (consecutiveReadOnlyRounds >= ToolRunner.MAX_READ_ONLY_ROUNDS && !hasMadeEdits) {
                messages.push(vscode.LanguageModelChatMessage.User(
                    'STOP exploring. You have spent too many rounds just reading files and searching. '
                    + 'You have enough context now. Start making edits IMMEDIATELY using edit/write tools. '
                    + 'Do NOT read any more files unless absolutely necessary for an edit you are about to make.'
                ));
                consecutiveReadOnlyRounds = 0; // Reset so we give the model a chance
                stream.progress('Switching to implementation...');
                progress?.report({ message: 'Switching to implementation...' });
            }

            // Send follow-up request WITH tools so the model can make more calls
            try {
                currentResponse = await model.sendRequest(messages, { tools }, token);
            } catch (e) {
                const errMsg = e instanceof Error ? e.message : String(e);
                // If context is too large, trim aggressively and retry once
                if (errMsg.includes('too many tokens') || errMsg.includes('context_length') || errMsg.includes('rate') || errMsg.includes('413')) {
                    this.trimContextIfNeeded(messages, baseMessageCount, model.maxInputTokens, true);
                    try {
                        currentResponse = await model.sendRequest(messages, { tools }, token);
                        continue;
                    } catch {
                        stream.markdown(`\n\n*Context too large after ${round} tool rounds. Stopping here.*`);
                        break;
                    }
                }
                stream.markdown(`\n\n*Tool follow-up error: ${errMsg}*`);
                break;
            }
        }

        return fullText;
    }

    /**
     * Estimate total tokens in messages and trim old tool-round pairs
     * (assistant tool-call + user tool-result) from the middle to stay within budget.
     * Keeps the base messages (system prompt, history, user query) intact.
     */
    private trimContextIfNeeded(
        messages: vscode.LanguageModelChatMessage[],
        baseMessageCount: number,
        maxInputTokens: number,
        aggressive = false,
    ): void {
        const budget = aggressive ? maxInputTokens * 0.5 : maxInputTokens * 0.75;
        let totalChars = 0;

        for (const msg of messages) {
            for (const part of msg.content) {
                if (part instanceof vscode.LanguageModelTextPart) {
                    totalChars += part.value.length;
                } else if (part instanceof vscode.LanguageModelToolResultPart) {
                    for (const rp of part.content) {
                        if (rp instanceof vscode.LanguageModelTextPart) {
                            totalChars += rp.value.length;
                        } else if (typeof rp === 'object' && rp !== null && 'value' in rp && typeof (rp as Record<string, unknown>).value === 'string') {
                            totalChars += ((rp as Record<string, unknown>).value as string).length;
                        }
                    }
                } else if (typeof part === 'object' && part !== null && 'value' in part && typeof (part as Record<string, unknown>).value === 'string') {
                    totalChars += ((part as Record<string, unknown>).value as string).length;
                }
            }
        }

        const estimatedTokens = Math.ceil(totalChars / 4);
        if (estimatedTokens <= budget) {
            return;
        }

        // Remove oldest tool-round pairs (they come in pairs: assistant + user)
        // Keep at least the last 3 rounds (6 messages)
        const toolMessages = messages.length - baseMessageCount;
        const keepLast = aggressive ? 4 : 6; // 2-3 most recent rounds
        const removable = toolMessages - keepLast;

        if (removable > 0) {
            // Remove from baseMessageCount in chunks of 2 (assistant+user pairs)
            const toRemove = Math.min(removable, Math.ceil(removable / 2) * 2);
            // Replace removed messages with a summary
            const summary = new vscode.LanguageModelTextPart(
                `[${toRemove / 2} earlier tool rounds omitted to fit context window. Continue with the task.]`
            );
            messages.splice(baseMessageCount, toRemove, vscode.LanguageModelChatMessage.User([summary]));
        }
    }

    /**
     * Extract a plain-text representation of tool result content for caching/memory.
     * Handles all part types robustly — instanceof, duck-typing, and fallback to JSON.
     */
    private extractResultText(toolResult: vscode.LanguageModelToolResult): string {
        const texts: string[] = [];
        for (const part of toolResult.content) {
            if (part instanceof vscode.LanguageModelTextPart) {
                texts.push(part.value);
            } else if (typeof part === 'object' && part !== null) {
                // Duck-type: many tool result parts have a .value string
                const obj = part as Record<string, unknown>;
                if (typeof obj.value === 'string') {
                    texts.push(obj.value);
                } else if (typeof obj.text === 'string') {
                    texts.push(obj.text);
                } else {
                    // Last resort: JSON serialize
                    try {
                        texts.push(JSON.stringify(part));
                    } catch {
                        texts.push('[non-text tool output]');
                    }
                }
            } else if (typeof part === 'string') {
                texts.push(part);
            }
        }
        return texts.length > 0 ? texts.join('\n') : '[empty tool result]';
    }

    /**
     * Prepare tool result content for sending back to the model.
     * Passes through original content parts but truncates oversized text parts
     * to stay within context budget. Preserves original part types so the API
     * recognizes them correctly (avoids instanceof cross-realm issues).
     */
    private truncateToolResult(toolResult: vscode.LanguageModelToolResult): (vscode.LanguageModelTextPart | vscode.LanguageModelPromptTsxPart)[] {
        const parts: (vscode.LanguageModelTextPart | vscode.LanguageModelPromptTsxPart)[] = [];

        for (const part of toolResult.content) {
            if (part instanceof vscode.LanguageModelTextPart) {
                // Known TextPart — truncate if needed
                const value = part.value.length > ToolRunner.MAX_RESULT_CHARS
                    ? part.value.substring(0, ToolRunner.MAX_RESULT_CHARS) + '\n... [truncated]'
                    : part.value;
                parts.push(new vscode.LanguageModelTextPart(value));
            } else if (typeof part === 'object' && part !== null) {
                // Cross-realm object: reconstruct as a fresh LanguageModelTextPart
                const obj = part as Record<string, unknown>;
                let text: string;
                if (typeof obj.value === 'string') {
                    text = obj.value;
                } else if (typeof obj.text === 'string') {
                    text = obj.text;
                } else {
                    try {
                        text = JSON.stringify(part);
                    } catch {
                        text = '[non-text tool output]';
                    }
                }
                if (text.length > ToolRunner.MAX_RESULT_CHARS) {
                    text = text.substring(0, ToolRunner.MAX_RESULT_CHARS) + '\n... [truncated]';
                }
                parts.push(new vscode.LanguageModelTextPart(text));
            } else if (typeof part === 'string') {
                const text = (part as string).length > ToolRunner.MAX_RESULT_CHARS
                    ? (part as string).substring(0, ToolRunner.MAX_RESULT_CHARS) + '\n... [truncated]'
                    : part as string;
                parts.push(new vscode.LanguageModelTextPart(text));
            }
        }

        if (parts.length === 0) {
            parts.push(new vscode.LanguageModelTextPart('[empty tool result]'));
        }
        return parts;
    }

    private async invokeTool(
        toolName: string,
        input: object,
        token: vscode.CancellationToken,
        toolInvocationToken?: vscode.ChatParticipantToolToken,
    ): Promise<vscode.LanguageModelToolResult> {
        // Block tools that target files outside the workspace
        const outOfScope = this.checkWorkspaceScope(toolName, input);
        if (outOfScope) {
            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart(`Blocked: ${outOfScope} is outside the current workspace. Only files within the workspace can be accessed.`),
            ]);
        }

        try {
            return await vscode.lm.invokeTool(toolName, { input, toolInvocationToken } as vscode.LanguageModelToolInvocationOptions<object>, token);
        } catch (e) {
            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart(`Tool error: ${e instanceof Error ? e.message : String(e)}`),
            ]);
        }
    }

    /**
     * Check if a tool call targets a file path outside the workspace.
     * Returns the offending path string if out of scope, or undefined if OK.
     */
    private checkWorkspaceScope(toolName: string, input: object): string | undefined {
        // Only check tools that operate on file paths
        const lower = toolName.toLowerCase();
        const isFileTool = ['read', 'write', 'edit', 'create', 'delete', 'replace', 'rename',
            'insert', 'open', 'save', 'file', 'grep', 'search', 'find', 'cat', 'terminal', 'run', 'execute', 'shell'].some(k => lower.includes(k));
        // Skip our own memory/context tools — they use managed storage
        const isOwnTool = lower.startsWith('CoClaw_');
        if (!isFileTool || isOwnTool) {
            return undefined;
        }

        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders || workspaceFolders.length === 0) {
            return undefined; // No workspace open, can't enforce
        }

        return this.deepCheckPaths(input, workspaceFolders, 3);
    }

    private static readonly PATH_KEYS = ['filepath', 'path', 'file', 'uri', 'filename', 'cwd', 'directory'];
    private static readonly COMMAND_KEYS = ['command', 'cmd', 'shell', 'script'];

    /**
     * Recursively inspect an object for path-like values outside the workspace.
     * Resolves relative paths, checks nested structures, and inspects command strings.
     */
    private deepCheckPaths(
        obj: unknown,
        workspaceFolders: readonly vscode.WorkspaceFolder[],
        maxDepth: number,
    ): string | undefined {
        if (maxDepth <= 0 || obj === null || obj === undefined) { return undefined; }
        if (typeof obj !== 'object') { return undefined; }

        if (Array.isArray(obj)) {
            for (const item of obj) {
                const v = this.deepCheckPaths(item, workspaceFolders, maxDepth - 1);
                if (v) { return v; }
            }
            return undefined;
        }

        const record = obj as Record<string, unknown>;
        for (const [key, val] of Object.entries(record)) {
            if (typeof val === 'string') {
                const lowerKey = key.toLowerCase();
                if (ToolRunner.PATH_KEYS.some(pk => lowerKey.includes(pk))) {
                    const violation = this.validatePath(val, workspaceFolders);
                    if (violation) { return violation; }
                }
                if (ToolRunner.COMMAND_KEYS.some(ck => lowerKey.includes(ck))) {
                    const violation = this.checkCommandForPaths(val, workspaceFolders);
                    if (violation) { return violation; }
                }
            } else if (typeof val === 'object' && val !== null) {
                const v = this.deepCheckPaths(val, workspaceFolders, maxDepth - 1);
                if (v) { return v; }
            }
        }
        return undefined;
    }

    /**
     * Validate a single path string — resolve relative paths and check workspace bounds.
     */
    private validatePath(val: string, workspaceFolders: readonly vscode.WorkspaceFolder[]): string | undefined {
        let resolved: string;
        if (path.isAbsolute(val)) {
            resolved = path.normalize(val);
        } else {
            // Resolve relative paths against the first workspace folder root
            resolved = path.normalize(path.resolve(workspaceFolders[0].uri.fsPath, val));
        }

        const inWorkspace = workspaceFolders.some(wf => {
            const wsRoot = path.normalize(wf.uri.fsPath);
            return resolved.startsWith(wsRoot + path.sep) || resolved === wsRoot;
        });
        if (!inWorkspace) {
            return val;
        }
        return undefined;
    }

    /**
     * Extract absolute paths from a command string and check they are within the workspace.
     */
    private checkCommandForPaths(command: string, workspaceFolders: readonly vscode.WorkspaceFolder[]): string | undefined {
        // Match Unix-style and Windows-style absolute paths
        const pathPattern = /(?:[A-Za-z]:\\[\w\\.\-\s]+|\/[\w/.\-]+)/g;
        let match;
        while ((match = pathPattern.exec(command)) !== null) {
            const candidate = match[0].trim();
            if (path.isAbsolute(candidate)) {
                const normalized = path.normalize(candidate);
                const inWorkspace = workspaceFolders.some(wf => {
                    const wsRoot = path.normalize(wf.uri.fsPath);
                    return normalized.startsWith(wsRoot + path.sep) || normalized === wsRoot;
                });
                if (!inWorkspace) {
                    return candidate;
                }
            }
        }
        return undefined;
    }

    /**
     * Check if a tool is read-only (search, file read, workspace context, etc.)
     * as opposed to a mutation tool (edit, write, create, terminal, etc.)
     */
    private isReadOnlyTool(toolName: string): boolean {
        const lower = toolName.toLowerCase();
        // Our own read-only tools
        if (lower === 'CoClaw_memory_read' || lower === 'CoClaw_workspace_context') {
            return true;
        }
        // Common read-only tool patterns
        const readOnlyPatterns = [
            'read', 'search', 'find', 'grep', 'list', 'get', 'cat', 'show', 'view', 'context',
        ];
        const mutationPatterns = [
            'edit', 'write', 'create', 'delete', 'replace', 'rename', 'insert', 'update',
            'apply', 'save', 'terminal', 'run', 'execute', 'command', 'shell',
        ];
        const isMutation = mutationPatterns.some(p => lower.includes(p));
        if (isMutation) {
            return false;
        }
        return readOnlyPatterns.some(p => lower.includes(p));
    }

    /**
     * Check if a tool is a "code work" tool — file reads, edits, searches, terminal.
     * Excludes our own memory/context tools which don't indicate a coding task in progress.
     */
    private isCodeTool(toolName: string): boolean {
        const lower = toolName.toLowerCase();
        // Our internal memory/context tools are NOT code tools
        if (lower.startsWith('clawpilot_') || lower.startsWith('coclaw_')) {
            return false;
        }
        return true;
    }

    /**
     * Heuristic: does the model's text suggest there are more changes to make,
     * or was the output structurally cut off mid-response?
     */
    private looksIncomplete(text: string): boolean {
        const trimmed = text.trim();
        if (!trimmed) {
            // Empty response after tool calls — model likely hit output limit
            return true;
        }

        // If the response looks like a conversational/summary ending, it's complete
        const lower = trimmed.toLowerCase();
        const completeSignals = [
            'let me know', 'feel free', 'anything else', 'how can i help',
            'what would you like', 'task is complete', 'all done', 'that\'s it',
            'already completed', 'already done', 'nothing left', 'no remaining',
            'is there something', 'ready to', 'give me a new',
        ];
        if (completeSignals.some(s => lower.includes(s))) {
            return false;
        }

        // Explicit verbal signals that more work is planned
        const incompleteSignals = [
            'also need to update', 'still need to update', 'remaining file',
            'now let me edit', 'now i\'ll edit', 'moving on to',
            'next file', 'next i\'ll', 'next, i\'ll', 'next step',
            'the following files still', 'other files need',
            'more changes needed', 'more edits needed',
            'step 2:', 'step 3:', 'step 4:', 'step 5:',
            'let me also', 'i also need to', 'additionally',
            'now for the', 'the next change', 'we also need',
            'finally, let me', 'lastly,', 'then i\'ll',
            'here\'s what i\'ll do next', 'after that',
        ];
        if (incompleteSignals.some(s => lower.includes(s))) {
            return true;
        }

        // Structural cutoff: unclosed fenced code block
        const fenceCount = (trimmed.match(/^```/gm) || []).length;
        if (fenceCount % 2 !== 0) {
            return true;
        }

        // Structural cutoff: text ends mid-sentence (no terminal punctuation or emoji)
        // Strip trailing emoji/whitespace first, then check for punctuation
        const stripped = trimmed.replace(/[\s\u{1F300}-\u{1FAD6}\u{2600}-\u{27BF}\u{FE00}-\u{FE0F}\u{200D}]+$/u, '');
        if (stripped.length > 0) {
            const lastChar = stripped[stripped.length - 1];
            const terminalPunctuation = ['.', '!', '?', ':', '`', '*', ')', ']', '"', '\''];
            if (!terminalPunctuation.includes(lastChar)) {
                return true;
            }
        }

        // Structural cutoff: ends with a list marker or colon suggesting more items
        const lastLine = trimmed.split('\n').pop()?.trim() || '';
        if (/^(\d+\.|[-*])\s/.test(lastLine) && lastLine.endsWith(':')) {
            return true;
        }

        return false;
    }
}
