import * as vscode from 'vscode';
import { DailyLogFile, MemoryEntry } from './types';
import { randomUUID } from 'crypto';
import { withLock } from './fileLock';

export class DailyLog {
    constructor(private readonly storageUri: vscode.Uri) {}

    private getLogUri(date: string): vscode.Uri {
        return vscode.Uri.joinPath(this.storageUri, 'memory', `${date}.json`);
    }

    private getLockKey(date: string): string {
        return `daily:${this.getLogUri(date).toString()}`;
    }

    private getTodayDate(): string {
        return new Date().toISOString().split('T')[0];
    }

    private getYesterdayDate(): string {
        const d = new Date();
        d.setDate(d.getDate() - 1);
        return d.toISOString().split('T')[0];
    }

    async readLog(date: string): Promise<DailyLogFile> {
        const uri = this.getLogUri(date);
        try {
            const data = await vscode.workspace.fs.readFile(uri);
            return JSON.parse(Buffer.from(data).toString('utf-8'));
        } catch {
            return { date, entries: [] };
        }
    }

    async writeLog(log: DailyLogFile): Promise<void> {
        const uri = this.getLogUri(log.date);
        const dir = vscode.Uri.joinPath(this.storageUri, 'memory');
        try {
            await vscode.workspace.fs.createDirectory(dir);
        } catch {
            // directory may already exist
        }
        await vscode.workspace.fs.writeFile(uri, Buffer.from(JSON.stringify(log, null, 2), 'utf-8'));
    }

    async addEntry(entry: Omit<MemoryEntry, 'id' | 'createdAt' | 'lastUsedAt'>): Promise<MemoryEntry> {
        const today = this.getTodayDate();
        return withLock(this.getLockKey(today), async () => {
            const log = await this.readLog(today);
            const full: MemoryEntry = {
                id: randomUUID(),
                createdAt: Date.now(),
                lastUsedAt: Date.now(),
                ...entry,
            };
            log.entries.push(full);
            await this.writeLog(log);
            return full;
        });
    }

    async getTodayEntries(): Promise<MemoryEntry[]> {
        const log = await this.readLog(this.getTodayDate());
        return log.entries;
    }

    async getRecentEntries(): Promise<MemoryEntry[]> {
        const today = await this.readLog(this.getTodayDate());
        const yesterday = await this.readLog(this.getYesterdayDate());
        return [...yesterday.entries, ...today.entries];
    }

    async getAllEntries(): Promise<MemoryEntry[]> {
        const memoryDir = vscode.Uri.joinPath(this.storageUri, 'memory');
        try {
            const files = await vscode.workspace.fs.readDirectory(memoryDir);
            const dailyFiles = files
                .filter(([name]) => /^\d{4}-\d{2}-\d{2}\.json$/.test(name))
                .map(([name]) => name);

            const allEntries: MemoryEntry[] = [];
            for (const file of dailyFiles) {
                const date = file.replace('.json', '');
                const log = await this.readLog(date);
                allEntries.push(...log.entries);
            }
            return allEntries;
        } catch {
            return [];
        }
    }

    async deleteEntry(entryId: string): Promise<boolean> {
        const memoryDir = vscode.Uri.joinPath(this.storageUri, 'memory');
        try {
            const files = await vscode.workspace.fs.readDirectory(memoryDir);
            const dailyFiles = files
                .filter(([name]) => /^\d{4}-\d{2}-\d{2}\.json$/.test(name));

            for (const [name] of dailyFiles) {
                const date = name.replace('.json', '');
                const deleted = await withLock(this.getLockKey(date), async () => {
                    const log = await this.readLog(date);
                    const idx = log.entries.findIndex(e => e.id === entryId);
                    if (idx === -1) { return false; }
                    log.entries.splice(idx, 1);
                    await this.writeLog(log);
                    return true;
                });
                if (deleted) { return true; }
            }
        } catch {
            // ignore
        }
        return false;
    }

    async clearAll(): Promise<void> {
        const memoryDir = vscode.Uri.joinPath(this.storageUri, 'memory');
        try {
            const files = await vscode.workspace.fs.readDirectory(memoryDir);
            for (const [name] of files) {
                if (/^\d{4}-\d{2}-\d{2}\.json$/.test(name)) {
                    const date = name.replace('.json', '');
                    await withLock(this.getLockKey(date), async () => {
                        await this.writeLog({ date, entries: [] });
                    });
                }
            }
        } catch {
            // ignore
        }
    }

    async pruneOldLogs(retentionDays: number): Promise<void> {
        const memoryDir = vscode.Uri.joinPath(this.storageUri, 'memory');
        const cutoff = new Date();
        cutoff.setDate(cutoff.getDate() - retentionDays);
        const cutoffStr = cutoff.toISOString().split('T')[0];

        try {
            const files = await vscode.workspace.fs.readDirectory(memoryDir);
            for (const [name] of files) {
                const match = name.match(/^(\d{4}-\d{2}-\d{2})\.json$/);
                if (match && match[1] < cutoffStr) {
                    await vscode.workspace.fs.delete(vscode.Uri.joinPath(memoryDir, name));
                }
            }
        } catch {
            // ignore
        }
    }
}
