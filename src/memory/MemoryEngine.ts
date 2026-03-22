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

        // Filter entries to current workspace to prevent cross-project memory leakage
        const filteredDaily = this.filterByWorkspace(daily);
        const filteredLongterm = this.filterByWorkspace(longterm);

        const results = this.recaller.recall(query, filteredDaily, filteredLongterm, maxTokens);

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
            // Deduplication: check daily log AND long-term memory for similar content
            const [todayEntries, longtermEntries] = await Promise.all([
                this.dailyLog.getTodayEntries(),
                this.longTermMemory.getAll(),
            ]);
            const allExisting = [...todayEntries, ...longtermEntries];
            const isDuplicate = allExisting.some(e =>
                e.content.toLowerCase() === fact.content.toLowerCase() ||
                this.isSimilar(e.content, fact.content)
            );
            if (isDuplicate) { continue; }

            // Tag with workspace ID for cross-project isolation
            const tags = this.workspaceId
                ? [...fact.tags, `ws:${this.workspaceId}`]
                : fact.tags;

            await this.dailyLog.addEntry({
                content: fact.content,
                type: fact.type,
                tags,
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
        // Tag all entries with workspaceId for cross-project isolation
        if (this.workspaceId && !tags.some(t => t.startsWith('ws:'))) {
            tags = [...tags, `ws:${this.workspaceId}`];
        }

        // Deduplication: check if similar content already exists in the target layer
        if (layer === 'longterm') {
            const existing = await this.longTermMemory.getAll();
            const duplicate = existing.find(e =>
                e.content.toLowerCase() === content.toLowerCase() ||
                this.isSimilar(e.content, content)
            );
            if (duplicate) {
                // Merge: update importance to the higher value and refresh lastUsedAt
                const merged = Math.max(duplicate.importance, importance);
                await this.longTermMemory.updateImportance(duplicate.id, merged);
                await this.longTermMemory.markUsed(duplicate.id);
                return duplicate;
            }
            const newEntry = await this.longTermMemory.addEntry({ content, type, tags, importance, source });
            // Post-write pass: decay importance of entries that the new entry supersedes
            await this.decaySupersededEntries(newEntry, existing);
            return newEntry;
        }
        return this.dailyLog.addEntry({ content, type, tags, importance, source });
    }

    /**
     * After writing a new long-term entry, decay the importance of older entries
     * that the new entry may supersede (same type + partial content overlap).
     * This prevents stale decisions/conventions from outranking current ones.
     */
    private async decaySupersededEntries(newEntry: MemoryEntry, existingEntries: MemoryEntry[]): Promise<void> {
        const supersedableTypes: MemoryEntryType[] = ['decision', 'convention', 'preference'];
        if (!supersedableTypes.includes(newEntry.type)) { return; }

        for (const old of existingEntries) {
            if (old.id === newEntry.id || old.pinned) { continue; }
            if (old.type !== newEntry.type) { continue; }

            // Check if the new entry is about the same topic (partial word overlap > 40%)
            const wordsNew = new Set(newEntry.content.toLowerCase().split(/\s+/).filter(w => w.length > 2));
            const wordsOld = new Set(old.content.toLowerCase().split(/\s+/).filter(w => w.length > 2));
            if (wordsOld.size === 0) { continue; }
            let overlap = 0;
            for (const w of wordsNew) {
                if (wordsOld.has(w)) { overlap++; }
            }
            const overlapRatio = overlap / Math.min(wordsNew.size, wordsOld.size);

            if (overlapRatio > 0.4) {
                // The new entry likely supersedes the old one — decay its importance
                const decayed = Math.max(0, old.importance - 0.2);
                await this.longTermMemory.updateImportance(old.id, decayed);
            }
        }
    }

    async searchMemory(keyword: string, layer: 'daily' | 'longterm' | 'all' = 'all', skipWorkspaceFilter = false): Promise<MemoryEntry[]> {
        const results: MemoryEntry[] = [];

        if (layer === 'daily' || layer === 'all') {
            const dailyEntries = await this.dailyLog.getAllEntries();
            results.push(...this.recaller.searchByKeyword(dailyEntries, keyword));
        }

        if (layer === 'longterm' || layer === 'all') {
            const longtermEntries = await this.longTermMemory.getAll();
            results.push(...this.recaller.searchByKeyword(longtermEntries, keyword));
        }

        return skipWorkspaceFilter ? results : this.filterByWorkspace(results);
    }

    /**
     * Filter entries to current workspace. Entries with no workspace tag pass through
     * (legacy entries), entries tagged for a different workspace are excluded.
     */
    private filterByWorkspace(entries: MemoryEntry[]): MemoryEntry[] {
        if (!this.workspaceId) { return entries; }
        return entries.filter(e =>
            !e.tags.some(t => t.startsWith('ws:')) ||
            e.tags.includes(`ws:${this.workspaceId}`)
        );
    }

    async getAllMemories(): Promise<{ daily: MemoryEntry[]; longterm: MemoryEntry[] }> {
        const [daily, longterm] = await Promise.all([
            this.dailyLog.getAllEntries(),
            this.longTermMemory.getAll(),
        ]);
        return {
            daily: this.filterByWorkspace(daily),
            longterm: this.filterByWorkspace(longterm),
        };
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
        await this.dailyLog.clearAll();
    }

    async clearLongTermMemory(): Promise<void> {
        await this.longTermMemory.save({ entries: [] });
    }

    async clearAllMemory(): Promise<void> {
        await Promise.all([
            this.clearDailyLogs(),
            this.clearLongTermMemory(),
        ]);
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
        const { daily, longterm } = await this.getAllMemories();
        return { daily: daily.length, longterm: longterm.length };
    }

    /**
     * Simple similarity check: if two strings share >60% of their words, consider them similar.
     */
    isSimilar(a: string, b: string): boolean {
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
