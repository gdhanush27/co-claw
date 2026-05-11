/**
 * Mocha test setup: register a mock vscode module before any imports.
 * Must be loaded via --require before test files.
 */
const Module = require('module');
const originalResolve = Module._resolveFilename;

// Test fixtures for vscode language-model classes. Real VS Code returns
// `instanceof`-checkable classes so the same shape matters in tests.
class LanguageModelTextPart {
    constructor(public value: string) {}
}
class LanguageModelToolCallPart {
    constructor(public callId: string, public name: string, public input: unknown) {}
}
class LanguageModelToolResultPart {
    constructor(public callId: string, public content: unknown[]) {}
}
class LanguageModelPromptTsxPart {
    constructor(public value: unknown) {}
}
class LanguageModelToolResult {
    constructor(public content: unknown[]) {}
}

function normalizeContent(content: unknown): unknown[] {
    if (Array.isArray(content)) { return content; }
    if (typeof content === 'string') { return [new LanguageModelTextPart(content)]; }
    return [content];
}

class LanguageModelChatMessage {
    constructor(public role: 'user' | 'assistant', public content: unknown[]) {}
    static User(content: string | unknown[]): LanguageModelChatMessage {
        return new LanguageModelChatMessage('user', normalizeContent(content));
    }
    static Assistant(content: string | unknown[]): LanguageModelChatMessage {
        return new LanguageModelChatMessage('assistant', normalizeContent(content));
    }
}

// Hoisted to a named declaration so its private members don't break consumers
// that read mockVscode.EventEmitter via the public type. Inline classes inside
// an exported object literal can't have `private` fields under TS strict mode.
class MockEventEmitter<T> {
    private readonly listeners = new Set<(value: T) => unknown>();
    readonly event = (listener: (value: T) => unknown) => {
        this.listeners.add(listener);
        return { dispose: () => { this.listeners.delete(listener); } };
    };
    fire(value: T): void {
        for (const listener of this.listeners) {
            try { listener(value); } catch { /* swallow in tests */ }
        }
    }
    dispose(): void { this.listeners.clear(); }
}

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
        createOutputChannel: (_name: string) => ({
            appendLine: () => {},
            append: () => {},
            clear: () => {},
            dispose: () => {},
            show: () => {},
            hide: () => {},
            replace: () => {},
            name: _name,
        }),
    },
    StatusBarAlignment: { Left: 1, Right: 2 },
    ThemeColor: class ThemeColor { constructor(public id: string) {} },
    EventEmitter: MockEventEmitter,
    lm: {
        selectChatModels: async () => [],
        tools: [] as unknown[],
        invokeTool: async () => new LanguageModelToolResult([]),
    },
    LanguageModelChatMessage,
    LanguageModelTextPart,
    LanguageModelToolCallPart,
    LanguageModelToolResultPart,
    LanguageModelPromptTsxPart,
    LanguageModelToolResult,
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
