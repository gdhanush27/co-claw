export type TelegramParseMode = 'HTML' | 'Markdown';

interface OpenTag {
    name: string;
    openTag: string;
}

const SAFE_SPLIT_OVERHEAD = 96;

/**
 * Telegram-allowed HTML tags. We deliberately only support the inline tags
 * documented at https://core.telegram.org/bots/api#html-style — anything
 * else (e.g. <div>, <script>) gets escaped so it renders as literal text.
 */
const ALLOWED_TAG_NAMES = ['b', 'strong', 'i', 'em', 'u', 'ins', 's', 'strike', 'del', 'code', 'pre', 'a', 'tg-spoiler', 'blockquote'] as const;
const ALLOWED_TAG_NAMES_PATTERN = ALLOWED_TAG_NAMES.join('|');

/**
 * Tokenizer used by both `splitTelegramHtml` (to split safely on tag boundaries)
 * and `smartEscapeHtml` (to recognize already-valid HTML so we don't double-escape).
 *
 * Matches, in order: a recognized opening/closing tag (with optional attributes),
 * a recognized HTML entity, or a single character.
 */
const TOKEN_REGEX = new RegExp(
    `(<\\/?(?:${ALLOWED_TAG_NAMES_PATTERN})(?:\\s+[^<>]*)?>|&(?:#\\d+|#x[\\da-fA-F]+|[a-zA-Z]+);|[\\s\\S])`,
    'g',
);

/**
 * Detects a single recognized tag at the START of a string (no global flag).
 * Used to differentiate "this `<` is part of a real tag" vs "this `<` is a
 * stray less-than sign in the middle of plain prose".
 */
const SINGLE_TAG_REGEX = new RegExp(
    `^(<\\/?(?:${ALLOWED_TAG_NAMES_PATTERN})(?:\\s+[^<>]*)?>|&(?:#\\d+|#x[\\da-fA-F]+|[a-zA-Z]+);)`,
);

export function formatTelegramHtml(markdownText: string): string {
    const normalized = markdownText.replace(/\r\n/g, '\n');
    const stashed = stashCodeSegments(normalized);

    const formatted = stashed.text
        .split('\n')
        .map((line) => formatLine(line))
        .join('\n');

    return restorePlaceholders(formatted, stashed.replacements);
}

export function splitTelegramHtml(html: string, maxLength: number): string[] {
    if (html.length <= maxLength) {
        return [html];
    }

    const effectiveMaxLength = maxLength > SAFE_SPLIT_OVERHEAD * 2
        ? maxLength - SAFE_SPLIT_OVERHEAD
        : Math.max(32, Math.floor(maxLength * 0.75));
    const tokens = html.match(TOKEN_REGEX) ?? [];
    const chunks: string[] = [];
    let index = 0;
    let carryStack: OpenTag[] = [];

    while (index < tokens.length) {
        const chunkTokens = carryStack.map((tag) => tag.openTag);
        let chunkLength = chunkTokens.reduce((sum, token) => sum + token.length, 0);
        let stack = cloneStack(carryStack);
        let lastCandidate: { nextIndex: number; tokenCount: number; stack: OpenTag[] } | undefined;

        while (index < tokens.length) {
            const token = tokens[index];

            if (chunkLength + token.length > effectiveMaxLength && chunkTokens.length > carryStack.length) {
                break;
            }

            chunkTokens.push(token);
            chunkLength += token.length;
            stack = applyTokenToStack(stack, token);
            index += 1;

            if (isPreferredBoundary(token)) {
                lastCandidate = {
                    nextIndex: index,
                    tokenCount: chunkTokens.length,
                    stack: cloneStack(stack),
                };
            }
        }

        if (index < tokens.length && lastCandidate) {
            chunkTokens.length = lastCandidate.tokenCount;
            index = lastCandidate.nextIndex;
            stack = cloneStack(lastCandidate.stack);
        }

        const chunkContent = trimChunkEdges(chunkTokens.join(''));
        if (!chunkContent) {
            break;
        }

        chunks.push(`${chunkContent}${closingTags(stack)}`);
        carryStack = cloneStack(stack);
    }

    return chunks.length > 0 ? chunks : [html];
}

/**
 * Escape `<`, `>`, `&` only when they are NOT part of an already-valid
 * Telegram HTML tag or HTML entity. This lets callers freely mix markdown
 * (which we convert to HTML) with pre-built HTML snippets (which we leave
 * alone) without worrying about double-escaping.
 */
export function escapeHtml(text: string): string {
    let result = '';
    let i = 0;
    while (i < text.length) {
        const remaining = text.slice(i);
        const tagMatch = SINGLE_TAG_REGEX.exec(remaining);
        if (tagMatch) {
            result += tagMatch[0];
            i += tagMatch[0].length;
            continue;
        }
        const ch = text.charCodeAt(i);
        if (ch === 0x26) { // &
            result += '&amp;';
        } else if (ch === 0x3c) { // <
            result += '&lt;';
        } else if (ch === 0x3e) { // >
            result += '&gt;';
        } else {
            result += text[i];
        }
        i += 1;
    }
    return result;
}

function stashCodeSegments(text: string): { text: string; replacements: Map<string, string> } {
    const replacements = new Map<string, string>();
    let result = text;
    let index = 0;

    result = result.replace(/```([^\n`]*)\n?([\s\S]*?)```/g, (_match, _language, code) => {
        const placeholder = `@@TG_CODE_BLOCK_${index++}@@`;
        const trimmedCode = code.replace(/^\n/, '').replace(/\n$/, '');
        replacements.set(placeholder, `<pre>${escapeForCodeContent(trimmedCode)}</pre>`);
        return placeholder;
    });

    result = result.replace(/`([^`\n]+?)`/g, (_match, code) => {
        const placeholder = `@@TG_INLINE_CODE_${index++}@@`;
        replacements.set(placeholder, `<code>${escapeForCodeContent(code)}</code>`);
        return placeholder;
    });

    return { text: result, replacements };
}

function restorePlaceholders(text: string, replacements: Map<string, string>): string {
    let result = text;
    for (const [placeholder, value] of replacements.entries()) {
        result = result.replaceAll(placeholder, value);
    }
    return result;
}

function formatLine(line: string): string {
    const headingMatch = line.match(/^\s{0,3}#{1,6}\s+(.*)$/);
    if (headingMatch) {
        return `<b>${formatInlineMarkdown(escapeHtml(headingMatch[1].trim()))}</b>`;
    }

    const blockQuoteMatch = line.match(/^\s*>\s?(.*)$/);
    if (blockQuoteMatch) {
        return `&gt; ${formatInlineMarkdown(escapeHtml(blockQuoteMatch[1]))}`;
    }

    const unorderedListMatch = line.match(/^(\s*)[-*]\s+(.*)$/);
    if (unorderedListMatch) {
        return `${unorderedListMatch[1]}• ${formatInlineMarkdown(escapeHtml(unorderedListMatch[2]))}`;
    }

    const orderedListMatch = line.match(/^(\s*\d+\.)\s+(.*)$/);
    if (orderedListMatch) {
        return `${orderedListMatch[1]} ${formatInlineMarkdown(escapeHtml(orderedListMatch[2]))}`;
    }

    return formatInlineMarkdown(escapeHtml(line));
}

function formatInlineMarkdown(text: string): string {
    let result = text;

    // [label](url) — links must come before bold/italic so the markdown brackets
    // aren't treated as italic markers.
    result = result.replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, (_match, label, url) => {
        return `<a href="${escapeHtmlAttribute(unescapeHtml(url))}">${label}</a>`;
    });

    // **bold** and __bold__
    result = result.replace(/\*\*([^\n]+?)\*\*/g, '<b>$1</b>');
    result = result.replace(/__([^\n]+?)__/g, '<b>$1</b>');

    // ~~strikethrough~~
    result = result.replace(/~~([^\n]+?)~~/g, '<s>$1</s>');

    // *italic* and _italic_ — require non-whitespace content between the markers
    // so cron expressions like "0 7 * * *" or "a * b * c" don't get mangled
    // into "0 7 <i> </i>". Pattern requires opening `*`/`_` to be immediately
    // followed by a non-space char and the closing one to be immediately
    // preceded by a non-space char.
    result = result.replace(/(^|[\s(])\*(\S(?:[^*\n]*?\S)?)\*(?=$|[\s).,!?:;])/g, '$1<i>$2</i>');
    result = result.replace(/(^|[\s(])_(\S(?:[^_\n]*?\S)?)_(?=$|[\s).,!?:;])/g, '$1<i>$2</i>');

    return result;
}

/**
 * Strict escape — used for content that goes inside <code> or <pre>, where
 * we never want to honor or preserve any HTML tags. Telegram requires `<`,
 * `>`, and `&` to always be escaped inside code blocks.
 */
function escapeForCodeContent(text: string): string {
    return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

/**
 * Render arbitrary user-supplied text as a literal inline `<code>` snippet.
 * Use this when you want to embed untrusted text (e.g. a value the user
 * just typed) inside a formatted message without it accidentally being
 * parsed as markdown or HTML. Backticks in the input are stripped because
 * they cannot survive an inline-code wrapper.
 */
export function inlineCodeFromUserText(text: string): string {
    const safe = text.replace(/`/g, '');
    return `<code>${escapeForCodeContent(safe)}</code>`;
}

function escapeHtmlAttribute(text: string): string {
    return escapeForCodeContent(text).replace(/"/g, '&quot;');
}

function unescapeHtml(text: string): string {
    return text
        .replace(/&quot;/g, '"')
        .replace(/&gt;/g, '>')
        .replace(/&lt;/g, '<')
        .replace(/&amp;/g, '&');
}

function cloneStack(stack: OpenTag[]): OpenTag[] {
    return stack.map((tag) => ({ ...tag }));
}

function applyTokenToStack(stack: OpenTag[], token: string): OpenTag[] {
    const nextStack = cloneStack(stack);
    if (!token.startsWith('<')) {
        return nextStack;
    }

    const closingMatch = token.match(new RegExp(`^<\\/(${ALLOWED_TAG_NAMES_PATTERN})>$`));
    if (closingMatch) {
        for (let idx = nextStack.length - 1; idx >= 0; idx -= 1) {
            if (nextStack[idx].name === closingMatch[1]) {
                nextStack.splice(idx, 1);
                break;
            }
        }
        return nextStack;
    }

    const openingMatch = token.match(new RegExp(`^<(${ALLOWED_TAG_NAMES_PATTERN})(?:\\s+[^<>]*)?>$`));
    if (openingMatch) {
        nextStack.push({ name: openingMatch[1], openTag: token });
    }

    return nextStack;
}

function closingTags(stack: OpenTag[]): string {
    return stack.slice().reverse().map((tag) => `</${tag.name}>`).join('');
}

function isPreferredBoundary(token: string): boolean {
    return token === '\n' || token === ' ';
}

function trimChunkEdges(chunk: string): string {
    return chunk.replace(/^\n+/, '').replace(/\n+$/, '');
}
