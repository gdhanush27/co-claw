export type MemoryEntryType = 'fact' | 'decision' | 'preference' | 'code_context' | 'convention' | 'pattern';

export type MemorySource = 'auto-extracted' | 'manual' | 'distilled';

export type MemoryLayer = 'daily' | 'longterm' | 'all';

export interface MemoryEntry {
    id: string;
    content: string;
    type: MemoryEntryType;
    tags: string[];
    importance: number;
    createdAt: number;
    lastUsedAt: number;
    source: MemorySource;
    pinned?: boolean;
}

export interface DailyLogFile {
    date: string; // YYYY-MM-DD
    entries: MemoryEntry[];
}

export interface LongTermMemoryFile {
    entries: MemoryEntry[];
}

export interface UserProfileData {
    preferredLanguage: string;
    codeStyle: string;
    indentation: string;
    verbosity: string;
    frameworks: string[];
    [key: string]: unknown;
}

export interface SoulConfigData {
    name: string;
    role: string;
    instructions: string;
    tone: string;
}

export interface ExtractedFact {
    type: MemoryEntryType;
    content: string;
    importance: number;
    tags: string[];
}

export interface MemorySearchResult {
    entry: MemoryEntry;
    score: number;
    layer: 'daily' | 'longterm';
}
