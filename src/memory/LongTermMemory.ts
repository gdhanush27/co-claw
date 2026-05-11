import * as vscode from 'vscode';
import { LongTermMemoryFile, MemoryEntry } from './types';
import { randomUUID } from 'crypto';
import { withLock } from './fileLock';

export class LongTermMemory {
    constructor(private readonly storageUri: vscode.Uri) {}

    private get fileUri(): vscode.Uri {
        return vscode.Uri.joinPath(this.storageUri, 'memory', 'longterm.json');
    }

    private get lockKey(): string {
        return `longterm:${this.fileUri.toString()}`;
    }

    async load(): Promise<LongTermMemoryFile> {
        try {
            const data = await vscode.workspace.fs.readFile(this.fileUri);
            return JSON.parse(Buffer.from(data).toString('utf-8'));
        } catch {
            return { entries: [] };
        }
    }

    async save(file: LongTermMemoryFile): Promise<void> {
        const dir = vscode.Uri.joinPath(this.storageUri, 'memory');
        try {
            await vscode.workspace.fs.createDirectory(dir);
        } catch {
            // directory may already exist
        }
        await vscode.workspace.fs.writeFile(this.fileUri, Buffer.from(JSON.stringify(file, null, 2), 'utf-8'));
    }

    async getAll(): Promise<MemoryEntry[]> {
        const file = await this.load();
        return file.entries;
    }

    async addEntry(entry: Omit<MemoryEntry, 'id' | 'createdAt' | 'lastUsedAt'>): Promise<MemoryEntry> {
        return withLock(this.lockKey, async () => {
            const file = await this.load();
            const full: MemoryEntry = {
                id: randomUUID(),
                createdAt: Date.now(),
                lastUsedAt: Date.now(),
                ...entry,
            };

            file.entries.push(full);
            await this.pruneIfNeeded(file);
            await this.save(file);
            return full;
        });
    }

    async addEntryDirect(entry: MemoryEntry): Promise<void> {
        await withLock(this.lockKey, async () => {
            const file = await this.load();
            file.entries.push(entry);
            await this.pruneIfNeeded(file);
            await this.save(file);
        });
    }

    async deleteEntry(entryId: string): Promise<boolean> {
        return withLock(this.lockKey, async () => {
            const file = await this.load();
            const idx = file.entries.findIndex(e => e.id === entryId);
            if (idx === -1) { return false; }
            file.entries.splice(idx, 1);
            await this.save(file);
            return true;
        });
    }

    async updateImportance(entryId: string, importance: number): Promise<boolean> {
        return withLock(this.lockKey, async () => {
            const file = await this.load();
            const entry = file.entries.find(e => e.id === entryId);
            if (!entry) { return false; }
            entry.importance = Math.max(0, Math.min(1, importance));
            await this.save(file);
            return true;
        });
    }

    async markUsed(entryId: string): Promise<void> {
        await withLock(this.lockKey, async () => {
            const file = await this.load();
            const entry = file.entries.find(e => e.id === entryId);
            if (entry) {
                entry.lastUsedAt = Date.now();
                await this.save(file);
            }
        });
    }

    async applyDecay(): Promise<void> {
        await withLock(this.lockKey, async () => {
            const file = await this.load();
            const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;
            const oneWeekMs = 7 * 24 * 60 * 60 * 1000;

            for (const entry of file.entries) {
                if (entry.pinned) { continue; }
                if (entry.lastUsedAt < thirtyDaysAgo) {
                    const weeksSinceUse = Math.floor((Date.now() - entry.lastUsedAt) / oneWeekMs) - 4; // weeks beyond 30 days
                    if (weeksSinceUse > 0) {
                        entry.importance = Math.max(0, entry.importance - 0.1 * weeksSinceUse);
                    }
                }
            }
            await this.save(file);
        });
    }

    private async pruneIfNeeded(file: LongTermMemoryFile): Promise<void> {
        const maxEntries = vscode.workspace.getConfiguration('CoClaw.memory').get<number>('maxLongTermEntries', 100);
        if (file.entries.length <= maxEntries) { return; }

        // Sort: pinned first, then by importance desc, then by lastUsedAt desc
        file.entries.sort((a, b) => {
            if (a.pinned && !b.pinned) { return -1; }
            if (!a.pinned && b.pinned) { return 1; }
            if (a.importance !== b.importance) { return b.importance - a.importance; }
            return b.lastUsedAt - a.lastUsedAt;
        });

        file.entries = file.entries.slice(0, maxEntries);
    }
}
