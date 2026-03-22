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

        const extractPrompt = `You are a memory extraction engine. Your job is to identify ONLY information worth persisting for future coding sessions.

EXTRACT these categories (use the exact type names):
- "convention": Coding style rules, naming conventions, formatting standards (e.g. "Uses camelCase for variables", "Always adds trailing comma")
- "decision": Architecture or design decisions (e.g. "Chose PostgreSQL over MongoDB", "Using monorepo structure")
- "preference": User's personal preferences for tools, frameworks, patterns (e.g. "Prefers functional components over class components")
- "fact": Important technical facts about the project (e.g. "API runs on port 3000", "Auth uses JWT")
- "code_context": Key structural info about files, modules, or APIs (e.g. "UserService handles all auth logic in src/services/")
- "pattern": Recurring code patterns or idioms the user follows (e.g. "Uses factory pattern for service instantiation")

SKIP (do NOT extract):
- Greetings, pleasantries, or small talk
- Information about the assistant's identity or capabilities
- Transient details (error messages being debugged, temporary log output)
- Things obvious from the code itself (e.g. "this file imports React")
- Rehashes of what the user just asked (the question itself is not a memory)
- Generic programming knowledge (e.g. "JavaScript is single-threaded")

RULES:
- Return at most 3 entries. Quality over quantity.
- Each entry must be a single concise sentence.
- importance: 0.3-0.5 for nice-to-know, 0.5-0.7 for useful, 0.7-1.0 for critical decisions/conventions.
- If NOTHING notable was said, return an empty array [].

Return ONLY a JSON array of objects: { type, content, importance, tags }

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
