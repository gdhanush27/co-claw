import * as https from 'https';
import { formatTelegramHtml, splitTelegramHtml, TelegramParseMode } from './TelegramFormatting';
import { TelegramInlineKeyboard } from './TelegramCronUi';

export interface TelegramUser {
    id: number;
    is_bot: boolean;
    first_name: string;
    username?: string;
}

export interface TelegramMessage {
    message_id: number;
    from?: TelegramUser;
    chat: { id: number; type: string };
    date: number;
    text?: string;
}

export interface TelegramUpdate {
    update_id: number;
    message?: TelegramMessage;
    callback_query?: TelegramCallbackQuery;
}

export interface TelegramCallbackQuery {
    id: string;
    from: TelegramUser;
    message?: TelegramMessage;
    data?: string;
}

interface TelegramApiResponse<T> {
    ok: boolean;
    result?: T;
    description?: string;
}

const TELEGRAM_API = 'api.telegram.org';
const MAX_MESSAGE_LENGTH = 4096;
const SPLIT_LABEL_RESERVE = 24;

/**
 * Lightweight Telegram Bot API client using built-in https.
 * No external dependencies — bundles cleanly with esbuild.
 */
export class TelegramApi {
    private readonly baseUrl: string;
    private activePollRequest: import('http').ClientRequest | undefined;

    constructor(private readonly token: string) {
        this.baseUrl = `/bot${token}`;
    }

    /** Verify the bot token is valid. Returns the bot user info. */
    async getMe(): Promise<TelegramUser> {
        const res = await this.request<TelegramUser>('getMe');
        return res;
    }

    /** Long-poll for updates. */
    async getUpdates(offset?: number, timeout = 30): Promise<TelegramUpdate[]> {
        const params: Record<string, unknown> = {
            timeout: timeout,
            allowed_updates: ['message', 'callback_query'],
        };
        if (offset !== undefined) {
            params.offset = offset;
        }
        return this.request<TelegramUpdate[]>('getUpdates', params);
    }

    /** Abort the currently pending getUpdates long-poll request. */
    abortPendingPoll(): void {
        if (this.activePollRequest) {
            this.activePollRequest.destroy();
            this.activePollRequest = undefined;
        }
    }

    /** Send a text message. Automatically formats HTML messages and splits long payloads safely. */
    async sendMessage(chatId: number, text: string, parseMode: TelegramParseMode = 'HTML'): Promise<void> {
        const chunks = this.prepareChunks(text, parseMode);
        for (let i = 0; i < chunks.length; i++) {
            let chunk = chunks[i];
            // Add continuation markers when a message is split
            if (chunks.length > 1) {
                const label = `[${i + 1}/${chunks.length}]`;
                chunk = i === 0 ? `${chunk}\n\n${label} ...` : `... ${label}\n\n${chunk}`;
            }
            const params: Record<string, unknown> = {
                chat_id: chatId,
                text: chunk,
            };
            params.parse_mode = parseMode;
            await this.request('sendMessage', params);
        }
    }

    /** Send a "typing..." indicator. */
    async sendChatAction(chatId: number, action = 'typing'): Promise<void> {
        await this.request('sendChatAction', {
            chat_id: chatId,
            action,
        });
    }

    /** Send a message with inline keyboard buttons. */
    async sendMessageWithButtons(
        chatId: number,
        text: string,
        buttons: TelegramInlineKeyboard,
    ): Promise<{ message_id: number }> {
        const params = {
            chat_id: chatId,
            text: this.prepareText(text, 'HTML'),
            parse_mode: 'HTML',
            reply_markup: { inline_keyboard: buttons },
        };
        return this.request<{ message_id: number }>('sendMessage', params);
    }

    /** Acknowledge a callback query (removes the loading spinner on the button). */
    async answerCallbackQuery(callbackQueryId: string, text?: string): Promise<void> {
        const params: Record<string, unknown> = { callback_query_id: callbackQueryId };
        if (text) { params.text = text; }
        await this.request('answerCallbackQuery', params);
    }

    /** Edit a sent message's text (e.g. to update after button press). */
    async editMessageText(
        chatId: number,
        messageId: number,
        text: string,
        parseMode: TelegramParseMode = 'HTML',
        buttons?: TelegramInlineKeyboard,
    ): Promise<void> {
        const params: Record<string, unknown> = {
            chat_id: chatId,
            message_id: messageId,
            text: this.prepareText(text, parseMode),
            parse_mode: parseMode,
        };
        if (buttons) {
            params.reply_markup = { inline_keyboard: buttons };
        }
        await this.request('editMessageText', params);
    }

    private prepareChunks(text: string, parseMode: TelegramParseMode): string[] {
        if (parseMode === 'HTML') {
            return splitTelegramHtml(this.prepareText(text, parseMode), MAX_MESSAGE_LENGTH - SPLIT_LABEL_RESERVE);
        }
        return this.splitPlainText(text, MAX_MESSAGE_LENGTH - SPLIT_LABEL_RESERVE);
    }

    private prepareText(text: string, parseMode: TelegramParseMode): string {
        if (parseMode === 'HTML') {
            return formatTelegramHtml(text);
        }
        return text;
    }

    private splitPlainText(text: string, maxLength: number): string[] {
        if (text.length <= maxLength) {
            return [text];
        }
        const chunks: string[] = [];
        let remaining = text;
        while (remaining.length > 0) {
            if (remaining.length <= maxLength) {
                chunks.push(remaining);
                break;
            }
            let splitIdx = remaining.lastIndexOf('\n', maxLength);
            if (splitIdx <= 0) {
                splitIdx = maxLength;
            }
            chunks.push(remaining.substring(0, splitIdx));
            remaining = remaining.substring(splitIdx).trimStart();
        }
        return chunks;
    }

    private request<T>(method: string, params?: Record<string, unknown>): Promise<T> {
        return new Promise((resolve, reject) => {
            const postData = params ? JSON.stringify(params) : '';
            const options: https.RequestOptions = {
                hostname: TELEGRAM_API,
                path: `${this.baseUrl}/${method}`,
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Content-Length': Buffer.byteLength(postData),
                },
                timeout: method === 'getUpdates' ? 40000 : 15000,
            };

            const req = https.request(options, (res) => {
                let data = '';
                res.on('data', (chunk: Buffer) => { data += chunk.toString(); });
                res.on('end', () => {
                    if (method === 'getUpdates') { this.activePollRequest = undefined; }
                    try {
                        const parsed: TelegramApiResponse<T> = JSON.parse(data);
                        if (parsed.ok && parsed.result !== undefined) {
                            resolve(parsed.result);
                        } else {
                            reject(new Error(`Telegram API error: ${parsed.description ?? 'Unknown error'}`));
                        }
                    } catch {
                        reject(new Error(`Failed to parse Telegram response: ${data.substring(0, 200)}`));
                    }
                });
            });

            req.on('error', (err) => {
                if (method === 'getUpdates') { this.activePollRequest = undefined; }
                // If the request was intentionally destroyed (abortPendingPoll), resolve empty
                if (method === 'getUpdates' && (err as NodeJS.ErrnoException).code === 'ERR_STREAM_DESTROYED') {
                    resolve([] as unknown as T);
                } else {
                    reject(err);
                }
            });
            req.on('timeout', () => {
                req.destroy();
                if (method === 'getUpdates') {
                    this.activePollRequest = undefined;
                    resolve([] as unknown as T);
                } else {
                    reject(new Error(`Telegram API request timed out: ${method}`));
                }
            });

            // Track the active poll request so it can be aborted
            if (method === 'getUpdates') {
                this.activePollRequest = req;
            }

            req.write(postData);
            req.end();
        });
    }
}
