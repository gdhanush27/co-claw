/**
 * Mocha test setup: register a mock vscode module before any imports.
 * Must be loaded via --require before test files.
 */
const Module = require('module');
const originalResolve = Module._resolveFilename;

const mockVscode = {
    workspace: {
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
        workspaceFolders: [],
        fs: {
            readFile: async () => { throw new Error('File not found'); },
            writeFile: async () => {},
            readDirectory: async () => [],
            createDirectory: async () => {},
            delete: async () => {},
        },
    },
    Uri: {
        joinPath: (base: { fsPath?: string; toString(): string }, ...parts: string[]) => {
            const basePath = (base.fsPath || base.toString());
            const fullPath = [basePath, ...parts].join('/');
            return { fsPath: fullPath, toString: () => fullPath };
        },
        file: (path: string) => ({ fsPath: path, toString: () => path }),
    },
    window: {
        createStatusBarItem: () => ({
            show: () => {},
            hide: () => {},
            dispose: () => {},
            text: '',
            tooltip: '',
            command: '',
            backgroundColor: undefined,
        }),
        showInformationMessage: async () => {},
        showErrorMessage: async () => {},
        showWarningMessage: async () => {},
    },
    StatusBarAlignment: { Left: 1, Right: 2 },
    ThemeColor: class ThemeColor { constructor(public id: string) {} },
    lm: {
        selectChatModels: async () => [],
    },
    LanguageModelChatMessage: {
        User: (content: string) => ({ role: 'user', content }),
        Assistant: (content: string) => ({ role: 'assistant', content }),
    },
    CancellationTokenSource: class {
        token = { isCancellationRequested: false, onCancellationRequested: () => ({ dispose: () => {} }) };
        cancel() { (this.token as any).isCancellationRequested = true; }
        dispose() {}
    },
};

// Intercept require('vscode') to return our mock
Module._resolveFilename = function (request: string, parent: any, isMain: boolean, options: any) {
    if (request === 'vscode') {
        // Return a sentinel that we handle below
        return 'vscode';
    }
    return originalResolve.call(this, request, parent, isMain, options);
};

// Cache the mock module
require.cache['vscode'] = {
    id: 'vscode',
    filename: 'vscode',
    loaded: true,
    exports: mockVscode,
    parent: null,
    children: [],
    paths: [],
    path: '',
    isPreloading: false,
    require: require,
} as any;
