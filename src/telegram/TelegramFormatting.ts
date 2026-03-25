export type TelegramParseMode = 'HTML' | 'Markdown';

interface OpenTag {
    name: string;
    openTag: string;
}

const SAFE_SPLIT_OVERHEAD = 96;
const TOKEN_REGEX = /(<\/?(?:b|i|s|code|pre|a)(?:\s+href="[^"]*")?>|&(?:#\d+|#x[\da-fA-F]+|[a-zA-Z]+);|[\s\S])/g;

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

function stashCodeSegments(text: string): { text: string; replacements: Map<string, string> } {
    const replacements = new Map<string, string>();
    let result = text;
    let index = 0;

    result = result.replace(/```([^\n`]*)\n?([\s\S]*?)```/g, (_match, _language, code) => {
        const placeholder = `@@TG_CODE_BLOCK_${index++}@@`;
        const trimmedCode = code.replace(/^\n/, '').replace(/\n$/, '');
        replacements.set(placeholder, `<pre>${escapeHtml(trimmedCode)}</pre>`);
        return placeholder;
    });

    result = result.replace(/`([^`\n]+?)`/g, (_match, code) => {
        const placeholder = `@@TG_INLINE_CODE_${index++}@@`;
        replacements.set(placeholder, `<code>${escapeHtml(code)}</code>`);
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

    result = result.replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, (_match, label, url) => {
        return `<a href="${escapeHtmlAttribute(unescapeHtml(url))}">${label}</a>`;
    });

    result = result.replace(/\*\*([^\n]+?)\*\*/g, '<b>$1</b>');
    result = result.replace(/__([^\n]+?)__/g, '<b>$1</b>');
    result = result.replace(/~~([^\n]+?)~~/g, '<s>$1</s>');
    result = result.replace(/(^|[\s(])\*([^*\n]+?)\*(?=($|[\s).,!?:;]))/g, '$1<i>$2</i>');
    result = result.replace(/(^|[\s(])_([^_\n]+?)_(?=($|[\s).,!?:;]))/g, '$1<i>$2</i>');

    return result;
}

function escapeHtml(text: string): string {
    return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

function escapeHtmlAttribute(text: string): string {
    return escapeHtml(text).replace(/"/g, '&quot;');
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

    const closingMatch = token.match(/^<\/(b|i|s|code|pre|a)>$/);
    if (closingMatch) {
        for (let idx = nextStack.length - 1; idx >= 0; idx -= 1) {
            if (nextStack[idx].name === closingMatch[1]) {
                nextStack.splice(idx, 1);
                break;
            }
        }
        return nextStack;
    }

    const openingMatch = token.match(/^<(b|i|s|code|pre|a)(?:\s+href="[^"]*")?>$/);
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