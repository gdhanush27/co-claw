import * as vscode from 'vscode';
import { DailyLog } from './DailyLog';
import { LongTermMemory } from './LongTermMemory';
import { MemoryExtractor } from './MemoryExtractor';
import { MemoryRecall } from './MemoryRecall';
import { MemoryEntry, MemoryEntryType, MemorySearchResult, MemorySource } from './types';

export class MemoryEngine {
    readonly dailyLog: DailyLog;
    readonly longTermMemory: LongTermMemory;
    private readonly extractor: MemoryExtractor;
    private readonly recaller: MemoryRecall;
    private readonly workspaceId?: string;

    constructor(storageUri: vscode.Uri, workspaceId?: string) {
        this.workspaceId = workspaceId;
        this.dailyLog = new DailyLog(storageUri);
        this.longTermMemory = new LongTermMemory(storageUri);
        this.extractor = new MemoryExtractor();
        this.recaller = new MemoryRecall();
    }

    async recall(query: string, maxTokens: number): Promise<MemorySearchResult[]> {
        const [daily, longterm] = await Promise.all([
            this.dailyLog.getRecentEntries(),
            this.longTermMemory.getAll(),
        ]);

        const results = this.recaller.recall(query, daily, longterm, maxTokens);

        // Mark used entries
        for (const r of results) {
            if (r.layer === 'longterm') {
                await this.longTermMemory.markUsed(r.entry.id);
            }
        }

        return results;
    }

    async extractAndStore(
        userMessage: string,
        assistantResponse: string,
        token: vscode.CancellationToken,
    ): Promise<void> {
        const autoExtract = vscode.workspace.getConfiguration('CoClaw.memory').get<boolean>('autoExtract', true);
        if (!autoExtract) { return; }

        const facts = await this.extractor.extract(userMessage, assistantResponse, token);

        // Cap at 3 entries per exchange to avoid log noise
        const topFacts = facts.slice(0, 3);

        for (const fact of topFacts) {
            // Deduplication: check if similar content already exists in today's log
            const existing = await this.dailyLog.getTodayEntries();
            const isDuplicate = existing.some(e =>
                e.content.toLowerCase() === fact.content.toLowerCase() ||
                this.isSimilar(e.content, fact.content)
            );
            if (isDuplicate) { continue; }

            await this.dailyLog.addEntry({
                content: fact.content,
                type: fact.type,
                tags: fact.tags,
                importance: fact.importance,
                source: 'auto-extracted',
            });
        }
    }

    async writeMemory(
        content: string,
        type: MemoryEntryType,
        importance: number = 0.5,
        tags: string[] = [],
        source: MemorySource = 'manual',
        layer: 'daily' | 'longterm' = 'longterm',
    ): Promise<MemoryEntry> {
        // Tag workspace-scoped entries with workspaceId for cross-project isolation
        if (this.workspaceId && tags.includes('workspace')) {
            tags = [...tags, `ws:${this.workspaceId}`];
        }
        if (layer === 'longterm') {
            return this.longTermMemory.addEntry({ content, type, tags, importance, source });
        }
        return this.dailyLog.addEntry({ content, type, tags, importance, source });
    }

    async searchMemory(keyword: string, layer: 'daily' | 'longterm' | 'all' = 'all'): Promise<MemoryEntry[]> {
        const results: MemoryEntry[] = [];

        if (layer === 'daily' || layer === 'all') {
            const dailyEntries = await this.dailyLog.getAllEntries();
            results.push(...this.recaller.searchByKeyword(dailyEntries, keyword));
        }

        if (layer === 'longterm' || layer === 'all') {
            const longtermEntries = await this.longTermMemory.getAll();
            results.push(...this.recaller.searchByKeyword(longtermEntries, keyword));
        }

        // Filter workspace-scoped entries to current project only
        if (this.workspaceId) {
            return results.filter(e =>
                !e.tags.some(t => t.startsWith('ws:')) ||
                e.tags.includes(`ws:${this.workspaceId}`)
            );
        }
        return results;
    }

    async getAllMemories(): Promise<{ daily: MemoryEntry[]; longterm: MemoryEntry[] }> {
        const [daily, longterm] = await Promise.all([
            this.dailyLog.getAllEntries(),
            this.longTermMemory.getAll(),
        ]);
        return { daily, longterm };
    }

    async promoteToLongTerm(entryId: string): Promise<boolean> {
        // Find in daily logs
        const allDaily = await this.dailyLog.getAllEntries();
        const entry = allDaily.find(e => e.id === entryId);
        if (!entry) { return false; }

        // Add to longterm
        const promoted: MemoryEntry = { ...entry, source: 'manual', lastUsedAt: Date.now() };
        await this.longTermMemory.addEntryDirect(promoted);

        // Remove from daily
        await this.dailyLog.deleteEntry(entryId);
        return true;
    }

    async deleteMemory(entryId: string): Promise<boolean> {
        const deletedFromLongterm = await this.longTermMemory.deleteEntry(entryId);
        if (deletedFromLongterm) { return true; }
        return this.dailyLog.deleteEntry(entryId);
    }

    async clearDailyLogs(): Promise<void> {
        // Read all daily logs and clear them - effectively a new day
        const today = new Date().toISOString().split('T')[0];
        const log = await this.dailyLog.readLog(today);
        log.entries = [];
        await this.dailyLog.writeLog(log);
    }

    async distill(token: vscode.CancellationToken): Promise<number> {
        const models = await vscode.lm.selectChatModels({ vendor: 'copilot' });
        const model = models[0];
        if (!model) { return 0; }

        const allDaily = await this.dailyLog.getAllEntries();
        if (allDaily.length === 0) { return 0; }

        const entriesText = allDaily.map(e => `[${e.type}] ${e.content}`).join('\n');
        const prompt = `Review these daily memory entries and distill the most important facts, decisions, and preferences into a consolidated set. Remove duplicates and noise. Keep only the essential information.

Return a JSON array of objects with: type, content, importance (0-1), tags (string array).

Daily entries:
${entriesText}`;

        try {
            const response = await model.sendRequest(
                [vscode.LanguageModelChatMessage.User(prompt)],
                {},
                token,
            );

            let text = '';
            for await (const chunk of response.text) {
                text += chunk;
            }

            const jsonMatch = text.match(/\[[\s\S]*\]/);
            if (!jsonMatch) { return 0; }

            const parsed = JSON.parse(jsonMatch[0]);
            if (!Array.isArray(parsed)) { return 0; }

            let count = 0;
            for (const item of parsed) {
                if (typeof item.content === 'string' && typeof item.type === 'string') {
                    await this.longTermMemory.addEntry({
                        content: item.content,
                        type: item.type,
                        tags: Array.isArray(item.tags) ? item.tags : [],
                        importance: typeof item.importance === 'number' ? item.importance : 0.5,
                        source: 'distilled',
                    });
                    count++;
                }
            }
            return count;
        } catch {
            return 0;
        }
    }

    async flushSessionToDaily(reason: string): Promise<void> {
        // This is called when context is approaching token limit
        // For now, we log the flush event itself
        await this.dailyLog.addEntry({
            content: `[Auto-flush] ${reason}`,
            type: 'fact',
            tags: ['system', 'auto-flush'],
            importance: 0.3,
            source: 'auto-extracted',
        });
    }

    async getMemoryCount(): Promise<{ daily: number; longterm: number }> {
        const [daily, longterm] = await Promise.all([
            this.dailyLog.getAllEntries(),
            this.longTermMemory.getAll(),
        ]);
        return { daily: daily.length, longterm: longterm.length };
    }

    /**
     * Simple similarity check: if two strings share >60% of their words, consider them similar.
     */
    private isSimilar(a: string, b: string): boolean {
        const wordsA = new Set(a.toLowerCase().split(/\s+/).filter(w => w.length > 2));
        const wordsB = new Set(b.toLowerCase().split(/\s+/).filter(w => w.length > 2));
        if (wordsA.size === 0 || wordsB.size === 0) { return false; }
        let overlap = 0;
        for (const w of wordsA) {
            if (wordsB.has(w)) { overlap++; }
        }
        const smaller = Math.min(wordsA.size, wordsB.size);
        return overlap / smaller > 0.6;
    }
}
