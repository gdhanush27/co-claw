import * as vscode from 'vscode';
import { AGENT_DEFINITIONS } from './AgentDefinitions';
import { AgentRole } from './types';
import { selectAutonomousTools } from '../lm/toolFilter';

const MAX_TOOL_ROUNDS = 15;
const MAX_RESULT_CHARS = 12000;

export interface AgentRunResult {
    text: string;
    toolCallsMade: number;
}

/**
 * Runs a single specialized agent (one role) as a self-contained
 * model.sendRequest tool-loop. Uses all registered vscode.lm.tools that
 * the role's allowsTool() permits, plus the shared-memory tools.
 *
 * The model is supplied per `runAgent` call so the orchestrator can route
 * different sub-tasks to different model tiers (light / medium / hard)
 * without rebuilding the agent runner.
 */
export class SpecializedAgent {
    /**
     * @param defaultModel Fallback model used when a caller does not pass one
     *                     to `runAgent`. Typically the result of
     *                     `ModelManager.getActiveModel()`.
     */
    constructor(
        private readonly defaultModel: vscode.LanguageModelChat,
    ) {}

    async runAgent(
        role: AgentRole,
        userPrompt: string,
        runId: string,
        taskId: string,
        token: vscode.CancellationToken,
        toolInvocationToken?: vscode.ChatParticipantToolToken,
        onText?: (chunk: string) => void,
        model?: vscode.LanguageModelChat,
    ): Promise<AgentRunResult> {
        const def = AGENT_DEFINITIONS[role];
        if (!def) { throw new Error(`Unknown agent role: ${role}`); }
        const activeModel = model ?? this.defaultModel;

        // Two-stage selection:
        //   1. Drop everything the role's own allow-list rejects.
        //   2. Hand the survivors to the shared selector so the interactive-UI
        //      denylist + the model-side 128-tool cap apply uniformly across
        //      every surface (chat, Telegram, agents).
        const roleAllowed = vscode.lm.tools.filter(t => def.allowsTool(t.name));
        const tools = selectAutonomousTools(roleAllowed);

        const systemPrompt = `${def.systemPrompt}

<run_context>
runId: ${runId}
taskId: ${taskId}
You can read sibling outputs by calling CoClaw_shared_memory_read with runId="${runId}".
You can publish results by calling CoClaw_shared_memory_write with runId="${runId}" and a key starting with "${role}:${taskId}".
</run_context>`;

        const messages: vscode.LanguageModelChatMessage[] = [
            vscode.LanguageModelChatMessage.User(systemPrompt),
            vscode.LanguageModelChatMessage.User(userPrompt),
        ];

        let fullText = '';
        let toolCallsMade = 0;
        let response = await activeModel.sendRequest(messages, { tools }, token);

        for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
            if (token.isCancellationRequested) { break; }

            const toolCalls: vscode.LanguageModelToolCallPart[] = [];
            let roundText = '';

            for await (const part of response.stream) {
                if (part instanceof vscode.LanguageModelTextPart) {
                    roundText += part.value;
                    fullText += part.value;
                    onText?.(part.value);
                } else if (part instanceof vscode.LanguageModelToolCallPart) {
                    toolCalls.push(part);
                }
            }

            if (toolCalls.length === 0) { break; }
            toolCallsMade += toolCalls.length;

            const assistantParts: (vscode.LanguageModelTextPart | vscode.LanguageModelToolCallPart)[] = [];
            const resultParts: (vscode.LanguageModelTextPart | vscode.LanguageModelToolResultPart)[] = [];

            if (roundText.trim()) {
                assistantParts.push(new vscode.LanguageModelTextPart(roundText));
            }

            for (const call of toolCalls) {
                if (token.isCancellationRequested) { break; }
                assistantParts.push(new vscode.LanguageModelToolCallPart(call.callId, call.name, call.input));
                const result = await this.invokeTool(call.name, call.input, token, toolInvocationToken);
                resultParts.push(new vscode.LanguageModelToolResultPart(call.callId, this.truncate(result)));
            }

            messages.push(vscode.LanguageModelChatMessage.Assistant(assistantParts));
            messages.push(vscode.LanguageModelChatMessage.User(resultParts));

            try {
                response = await activeModel.sendRequest(messages, { tools }, token);
            } catch (e) {
                fullText += `\n[agent error: ${e instanceof Error ? e.message : String(e)}]`;
                break;
            }
        }

        return { text: fullText, toolCallsMade };
    }

    private async invokeTool(
        name: string,
        input: unknown,
        token: vscode.CancellationToken,
        toolInvocationToken?: vscode.ChatParticipantToolToken,
    ): Promise<vscode.LanguageModelToolResult> {
        try {
            return await vscode.lm.invokeTool(name, {
                input: (input as Record<string, unknown>) ?? {},
                toolInvocationToken,
            }, token);
        } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart(`Tool ${name} failed: ${msg}`),
            ]);
        }
    }

    private truncate(result: vscode.LanguageModelToolResult): (vscode.LanguageModelTextPart | vscode.LanguageModelPromptTsxPart)[] {
        const out: (vscode.LanguageModelTextPart | vscode.LanguageModelPromptTsxPart)[] = [];
        let total = 0;
        for (const part of result.content) {
            if (part instanceof vscode.LanguageModelTextPart) {
                const remaining = MAX_RESULT_CHARS - total;
                if (remaining <= 0) { break; }
                if (part.value.length > remaining) {
                    out.push(new vscode.LanguageModelTextPart(part.value.slice(0, remaining) + '\n[truncated]'));
                    total += remaining;
                    break;
                }
                out.push(part);
                total += part.value.length;
            } else {
                out.push(part as vscode.LanguageModelPromptTsxPart);
            }
        }
        return out;
    }
}
