import * as vscode from 'vscode';
import { ExtractedFact } from './types';

export class MemoryExtractor {
    async extract(
        userMessage: string,
        assistantResponse: string,
        token: vscode.CancellationToken,
    ): Promise<ExtractedFact[]> {
        // Use a fast/cheap model for extraction
        const models = await vscode.lm.selectChatModels({ vendor: 'copilot' });
        // Prefer a mini/small model for extraction
        const extractor = models.find(m => m.family.includes('mini') || m.family.includes('small')) ?? models[0];
        if (!extractor) {
            return [];
        }

        const extractPrompt = `From this conversation exchange, extract ONLY truly important and novel information worth remembering for future coding sessions.

Strict rules:
- Return at most 3 entries.
- Only extract: user preferences, project decisions, code conventions, or important technical facts.
- Do NOT extract: greetings, assistant identity info, system status, trivial exchanges, or things already obvious from context.
- If the conversation is casual chat with no notable coding information, return an empty array [].
- Be very selective — only store what would genuinely help in a future coding session.

Return ONLY a JSON array of objects with these fields:
- type: one of "fact", "decision", "preference", "code_context", "convention", "pattern"
- content: a concise one-sentence description
- importance: a number from 0 to 1 (only use >0.7 for genuinely important things)
- tags: an array of relevant keyword tags

Return an empty array [] if nothing notable was said.

User message: ${userMessage}

Assistant response: ${assistantResponse}`;

        try {
            const response = await extractor.sendRequest(
                [vscode.LanguageModelChatMessage.User(extractPrompt)],
                {},
                token,
            );

            let text = '';
            for await (const chunk of response.text) {
                text += chunk;
            }

            // Extract JSON from the response (may be wrapped in markdown code block)
            const jsonMatch = text.match(/\[[\s\S]*\]/);
            if (!jsonMatch) {
                return [];
            }

            const parsed = JSON.parse(jsonMatch[0]);
            if (!Array.isArray(parsed)) {
                return [];
            }

            return parsed.filter((item: unknown): item is ExtractedFact => {
                if (typeof item !== 'object' || item === null) { return false; }
                const obj = item as Record<string, unknown>;
                return typeof obj.type === 'string' &&
                    typeof obj.content === 'string' &&
                    typeof obj.importance === 'number' &&
                    Array.isArray(obj.tags);
            });
        } catch {
            return [];
        }
    }
}
