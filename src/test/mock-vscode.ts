/**
 * Minimal vscode API mock for unit testing memory logic.
 * Only stubs the parts actually used by memory modules.
 */

const workspace = {
    getConfiguration: (_section?: string) => ({
        get: <T>(key: string, defaultValue: T): T => {
            const defaults: Record<string, unknown> = {
                maxLongTermEntries: 100,
                dailyLogsRetentionDays: 30,
                autoExtract: true,
                tokenBudgetPercent: 20,
                staleAfterDays: 14,
                autoDistillThreshold: 20,
                autoDistillIntervalHours: 24,
            };
            return (defaults[key] as T) ?? defaultValue;
        },
    }),
    workspaceFolders: [] as unknown[],
    fs: {
        readFile: async () => { throw new Error('File not found'); },
        writeFile: async () => {},
        readDirectory: async () => [],
        createDirectory: async () => {},
        delete: async () => {},
    },
};

const Uri = {
    joinPath: (base: { fsPath: string; toString(): string }, ...parts: string[]) => {
        const fullPath = [base.fsPath || base.toString(), ...parts].join('/');
        return { fsPath: fullPath, toString: () => fullPath };
    },
    file: (path: string) => ({ fsPath: path, toString: () => path }),
};

module.exports = { workspace, Uri };
