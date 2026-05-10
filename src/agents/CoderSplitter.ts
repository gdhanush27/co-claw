import { SubTask } from './types';

export interface SplitResult {
    /** Replacement tasks for the original coder task. */
    replacements: SubTask[];
    /** True if a split actually occurred (more than 1 replacement). */
    didSplit: boolean;
}

/**
 * Decide how many parallel coder agents to fan out for a single coder task.
 * Heuristic order:
 *   1. If the planner provided `units`, use them (one agent per unit, capped).
 *   2. Otherwise extract file-path-like tokens from the prompt.
 *   3. Otherwise extract bullet/numbered list items from the prompt.
 *   4. Otherwise leave as a single task.
 *
 * If two units target the same file path, they are chained sequentially
 * (dependsOn) instead of parallelized to avoid file-write races.
 */
export function splitCoderTask(
    task: SubTask,
    userPrompt: string,
    maxParallel: number,
): SplitResult {
    if (task.agent !== 'coder') {
        return { replacements: [task], didSplit: false };
    }

    const cap = Math.max(1, Math.min(maxParallel, 8));
    let units = (task.units && task.units.length > 0) ? task.units.slice() : extractUnits(task.prompt, userPrompt);

    // Deduplicate while preserving order
    units = Array.from(new Set(units.map(u => u.trim()).filter(u => u.length > 0)));

    if (units.length <= 1) {
        return { replacements: [task], didSplit: false };
    }

    units = units.slice(0, cap);

    const filePathOf = (unit: string): string | undefined => {
        const m = unit.match(/[\w./\\-]+\.[a-zA-Z0-9]+/);
        return m ? m[0].toLowerCase() : undefined;
    };

    const lastChildIdByFile = new Map<string, string>();
    const replacements: SubTask[] = units.map((unit, idx) => {
        const childId = `${task.id}-${idx + 1}`;
        const filePath = filePathOf(unit);
        const sequentialDep = filePath ? lastChildIdByFile.get(filePath) : undefined;
        if (filePath) { lastChildIdByFile.set(filePath, childId); }
        const dependsOn = task.dependsOn.slice();
        if (sequentialDep) { dependsOn.push(sequentialDep); }
        return {
            id: childId,
            agent: 'coder',
            prompt: `${task.prompt}\n\nFOCUS UNIT: ${unit}\n${concernGuidance(unit)}\nWork on this unit ONLY. Other parallel coders are handling the rest. Do NOT touch files outside your unit.`,
            units: [unit],
            dependsOn,
            status: 'pending',
        };
    });

    return { replacements, didSplit: true };
}

/** Extra guidance for known concern units so each coder stays in its lane. */
function concernGuidance(unit: string): string {
    switch (unit) {
        case 'html-markup':       return 'Edit ONLY HTML / JSX / TSX / template structure (markup, semantic tags, accessibility attributes). Do NOT modify CSS or JS behavior.';
        case 'css-styling':       return 'Edit ONLY CSS / SCSS / style files (layout, colors, spacing, typography, responsive rules). Do NOT modify markup structure or JS behavior.';
        case 'js-behavior':       return 'Edit ONLY JavaScript / TypeScript behavior (event handlers, state, validation, submit logic). Do NOT modify visual styles or restructure markup.';
        case 'api-routes':        return 'Edit ONLY HTTP route / controller / endpoint files. Do NOT touch data models, business logic, or tests.';
        case 'data-model':        return 'Edit ONLY data models, schemas, migrations, ORM mappings. Do NOT modify routes, services, or tests.';
        case 'business-logic':    return 'Edit ONLY service / domain / use-case logic. Do NOT touch routes, models, or tests.';
        case 'auth-security':     return 'Edit ONLY authentication / authorization / security middleware. Do NOT touch unrelated routes or models.';
        case 'config-build':      return 'Edit ONLY configuration / build / lint / CI files. Do NOT modify production source.';
        case 'tests':             return 'Add or update tests only. Do NOT modify production source files.';
        case 'docs':              return 'Update documentation, comments, JSDoc/TSDoc only. Do NOT modify executable code.';
        case 'error-handling':    return 'Add or improve error handling, fallbacks, retries only. Do NOT change happy-path logic structure.';
        case 'logging-telemetry': return 'Add or improve logging, metrics, tracing only. Do NOT change business logic.';
        case 'implementation':    return 'Edit production source files (the main implementation). Do NOT add or modify tests — a sibling agent owns that.';
        default:                  return '';
    }
}

function extractUnits(taskPrompt: string, userPrompt: string): string[] {
    const combined = `${taskPrompt}\n${userPrompt}`;
    const found: string[] = [];

    // 1. file-path tokens (something.ext or path/to/file.ext)
    const fileRegex = /[\w./\\-]+\.[a-zA-Z]{1,5}\b/g;
    const fileMatches = combined.match(fileRegex) ?? [];
    for (const m of fileMatches) {
        // Filter out trivial matches like "1.0"
        if (/[a-zA-Z]/.test(m)) { found.push(m); }
    }
    if (found.length >= 2) { return found; }

    // 2. bullet / numbered list items (explicit user list — strong signal)
    const listRegex = /^[\s]*(?:[-*]|\d+[.)])\s+(.{6,200})$/gm;
    let match: RegExpExecArray | null;
    const items: string[] = [];
    while ((match = listRegex.exec(combined)) !== null) {
        items.push(match[1].trim());
    }
    if (items.length >= 2) { return items; }

    // 3. Auto-decompose any task into work concerns the orchestrator can fan out.
    const auto = autoDecompose(combined);
    if (auto.length >= 2) { return auto; }

    // 4. " and " / ", " separated clauses for very long prompts
    if (combined.length > 600) {
        const clauses = combined.split(/(?:\band\b|;|\n)/i)
            .map(c => c.trim())
            .filter(c => c.length > 20 && c.length < 200);
        if (clauses.length >= 2) { return clauses.slice(0, 4); }
    }

    return found;
}

/**
 * Heuristically decompose ANY coding task into 1-N parallel work units.
 * The number of units is decided by the extension based on which "lanes" the
 * prompt activates (UI concerns, backend layers, tests, docs, etc.).
 *
 * Returns [] for clearly atomic single-file work (bug fixes, tiny tweaks).
 */
function autoDecompose(text: string): string[] {
    const lower = text.toLowerCase();

    // Atomic work — keep it as one task.
    const atomicSignals = [
        /\bfix(?:\s+(?:a|the))?\s+\w+/,
        /\bone[- ]liner\b/,
        /\btypo\b/,
        /\brename\b\s+\w+/,
        /\b(?:bump|update)\s+version\b/,
    ];
    if (atomicSignals.some(re => re.test(lower)) && text.length < 200) {
        return [];
    }

    const lanes: Array<{ unit: string; rx: RegExp }> = [
        // Frontend lanes
        { unit: 'html-markup',     rx: /\b(html|markup|template|jsx|tsx|component\s+structure|dom|semantic)\b/ },
        { unit: 'css-styling',     rx: /\b(css|scss|sass|less|styles?|styling|theme|colou?rs?|typography|spacing|responsive|tailwind|bootstrap)\b/ },
        { unit: 'js-behavior',     rx: /\b(behaviou?r|interaction|event|onclick|handler|state|hooks?|reducer|validation|submit)\b/ },
        // Backend / data lanes
        { unit: 'api-routes',      rx: /\b(api|endpoint|route|controller|handler\.ts|express|fastify|http|rest|graphql)\b/ },
        { unit: 'data-model',      rx: /\b(model|schema|migration|database|db|sql|orm|prisma|mongoose|entity)\b/ },
        { unit: 'business-logic',  rx: /\b(service|use[- ]?case|domain|logic|algorithm|calculation)\b/ },
        { unit: 'auth-security',   rx: /\b(auth|authn|authz|jwt|oauth|session|permission|rbac|csrf|cors|rate[- ]?limit)\b/ },
        { unit: 'config-build',    rx: /\b(config|configuration|webpack|vite|esbuild|tsconfig|eslint|prettier|ci|pipeline)\b/ },
        // Cross-cutting lanes
        { unit: 'tests',           rx: /\b(tests?|spec|jest|mocha|vitest|playwright|cypress|coverage|tdd)\b/ },
        { unit: 'docs',            rx: /\b(docs?|documentation|readme|comments?|jsdoc|tsdoc|changelog)\b/ },
        { unit: 'error-handling',  rx: /\b(error|exception|try[- ]?catch|fallback|retry|resilien)/ },
        { unit: 'logging-telemetry', rx: /\b(log(?:ging|s)?|telemetry|metric|trace|observability|sentry)\b/ },
    ];

    const hits: string[] = [];
    for (const lane of lanes) {
        if (lane.rx.test(lower)) { hits.push(lane.unit); }
    }

    if (hits.length >= 2) { return hits; }

    // Domain hints — broaden when only 0-1 lanes hit but the task is clearly multi-faceted.
    const isUiWork = /\b(ui|page|screen|view|form|sign[- ]?in|sign[- ]?up|login|signup|dashboard|landing|redesign|restyle|frontend|front[- ]?end)\b/.test(lower);
    const isFullStack = /\b(full[- ]?stack|end[- ]?to[- ]?end|feature|implement|build\s+a)\b/.test(lower);
    const isBackend = /\b(backend|back[- ]?end|server|microservice|api|service)\b/.test(lower) && hits.length === 0;
    const isRefactor = /\b(refactor|rewrite|restructure|cleanup|clean[- ]?up|modernize)\b/.test(lower);

    if (isUiWork) { return ['html-markup', 'css-styling', 'js-behavior']; }
    if (isFullStack) { return ['api-routes', 'data-model', 'tests']; }
    if (isBackend) { return ['api-routes', 'business-logic', 'tests']; }
    if (isRefactor) { return ['implementation', 'tests']; }

    // Generic mid-sized task → split implementation + tests by default.
    if (text.length >= 120) { return ['implementation', 'tests']; }

    return [];
}
