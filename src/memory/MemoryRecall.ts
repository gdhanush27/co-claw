import { MemoryEntry, MemorySearchResult } from './types';

export class MemoryRecall {
    /**
     * Rank and select the most relevant memory entries for a given query,
     * fitting within the specified token budget.
     */
    recall(
        query: string,
        dailyEntries: MemoryEntry[],
        longtermEntries: MemoryEntry[],
        maxTokens: number,
    ): MemorySearchResult[] {
        const queryTerms = this.tokenize(query);
        if (queryTerms.length === 0) {
            // Return top entries by importance if no query terms
            return this.topByImportance(dailyEntries, longtermEntries, maxTokens);
        }

        const scored: MemorySearchResult[] = [];

        for (const entry of dailyEntries) {
            const score = this.scoreEntry(entry, queryTerms);
            scored.push({ entry, score, layer: 'daily' });
        }

        for (const entry of longtermEntries) {
            const score = this.scoreEntry(entry, queryTerms);
            scored.push({ entry, score, layer: 'longterm' });
        }

        // Sort by score descending
        scored.sort((a, b) => b.score - a.score);

        // Take entries that fit within token budget
        return this.fitWithinBudget(scored, maxTokens);
    }

    searchByKeyword(entries: MemoryEntry[], keyword: string): MemoryEntry[] {
        const lower = keyword.toLowerCase();
        return entries.filter(e =>
            e.content.toLowerCase().includes(lower) ||
            e.tags.some(t => t.toLowerCase().includes(lower))
        );
    }

    private scoreEntry(entry: MemoryEntry, queryTerms: string[]): number {
        const contentTerms = this.tokenize(entry.content);
        const tagTerms = entry.tags.map(t => t.toLowerCase());

        // Keyword overlap (Jaccard-like)
        let overlap = 0;
        for (const qt of queryTerms) {
            if (contentTerms.includes(qt) || tagTerms.includes(qt)) {
                overlap++;
            }
        }
        const keywordScore = queryTerms.length > 0 ? overlap / queryTerms.length : 0;

        // Recency score (decays over 30 days)
        const ageMs = Date.now() - entry.lastUsedAt;
        const ageDays = ageMs / (24 * 60 * 60 * 1000);
        const recencyScore = Math.max(0, 1 - ageDays / 30);

        // Combined score: keyword_overlap * importance * recency
        return keywordScore * entry.importance * (0.5 + 0.5 * recencyScore);
    }

    private topByImportance(
        dailyEntries: MemoryEntry[],
        longtermEntries: MemoryEntry[],
        maxTokens: number,
    ): MemorySearchResult[] {
        const all: MemorySearchResult[] = [
            ...dailyEntries.map(e => ({ entry: e, score: e.importance, layer: 'daily' as const })),
            ...longtermEntries.map(e => ({ entry: e, score: e.importance, layer: 'longterm' as const })),
        ];
        all.sort((a, b) => b.score - a.score);
        return this.fitWithinBudget(all, maxTokens);
    }

    private fitWithinBudget(results: MemorySearchResult[], maxTokens: number): MemorySearchResult[] {
        const selected: MemorySearchResult[] = [];
        let usedTokens = 0;

        for (const r of results) {
            if (r.score <= 0) { break; }
            const entryTokens = this.estimateTokens(r.entry.content);
            if (usedTokens + entryTokens > maxTokens) { break; }
            selected.push(r);
            usedTokens += entryTokens;
        }

        return selected;
    }

    private tokenize(text: string): string[] {
        return text.toLowerCase()
            .replace(/[^a-z0-9\s]/g, ' ')
            .split(/\s+/)
            .filter(t => t.length > 2);
    }

    private estimateTokens(text: string): number {
        // Rough estimate: ~4 characters per token
        return Math.ceil(text.length / 4);
    }
}
