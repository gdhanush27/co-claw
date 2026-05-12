import type * as vscode from 'vscode';

/**
 * Slim view of a Copilot model surface used by the chat /model command's
 * name-matching helper. Mirrors the fields we actually read so unit tests
 * can pass plain objects instead of mocking the full `LanguageModelChat`.
 */
export interface ModelLike {
    name: string;
    family: string;
}

/**
 * Resolve a user-typed model token to one (or more) Copilot models.
 *
 * Matching is intentionally forgiving: exact identifiers win, then case-
 * insensitive equality, then `startsWith`, then substring. We bias toward
 * `family` matches over `name` matches because the family id is the stable
 * identifier we persist to settings.
 *
 * Returns `[]` when nothing plausibly matches. When multiple results tie at
 * the same precedence level (e.g. "claude" matches multiple Claude models)
 * the caller is expected to disambiguate via UI (buttons / picker), so the
 * full set is returned rather than silently picking the first hit.
 */
export function matchModels<T extends ModelLike>(models: readonly T[], query: string): T[] {
    const q = query.trim().toLowerCase();
    if (!q) { return []; }

    // 1. Exact family / name (case-insensitive).
    const exactFamily = models.filter(m => m.family.toLowerCase() === q);
    if (exactFamily.length > 0) { return uniqueByFamily(exactFamily); }
    const exactName = models.filter(m => m.name.toLowerCase() === q);
    if (exactName.length > 0) { return uniqueByFamily(exactName); }

    // 2. startsWith on family, then on name.
    const startsFamily = models.filter(m => m.family.toLowerCase().startsWith(q));
    if (startsFamily.length > 0) { return uniqueByFamily(startsFamily); }
    const startsName = models.filter(m => m.name.toLowerCase().startsWith(q));
    if (startsName.length > 0) { return uniqueByFamily(startsName); }

    // 3. substring on family or name.
    const sub = models.filter(m =>
        m.family.toLowerCase().includes(q) || m.name.toLowerCase().includes(q),
    );
    return uniqueByFamily(sub);
}

/**
 * Many Copilot families expose multiple `LanguageModelChat` instances with
 * the same `family` (different `version`/`name` combos). For settings
 * purposes we only care about distinct families.
 */
function uniqueByFamily<T extends ModelLike>(models: readonly T[]): T[] {
    const seen = new Set<string>();
    const out: T[] = [];
    for (const m of models) {
        if (!seen.has(m.family)) {
            seen.add(m.family);
            out.push(m);
        }
    }
    return out;
}

/**
 * Re-export the LanguageModelChat type for callers that want a thin alias.
 * Kept here so consumers don't need to import `vscode` just for the type.
 */
export type LanguageModelChat = vscode.LanguageModelChat;
