import { GenerationFailure, responseFailure } from './policy.js';

function present(value) {
    if (typeof value === 'string') return value.trim().length > 0;
    if (Array.isArray(value)) return value.some(present);
    return value && typeof value === 'object' && Object.values(value).some(present);
}

export function inspectPayload(data) {
    const choices = Array.isArray(data?.choices) ? data.choices : [];
    const blocks = Array.isArray(data?.content) ? data.content : [];
    const parts = [...(data?.candidates?.flatMap(candidate => candidate.content?.parts ?? []) ?? []), ...(data?.responseContent?.parts ?? [])];
    const toolCalls = choices.some(choice => present(choice.delta?.tool_calls ?? choice.message?.tool_calls ?? choice.delta?.function_call ?? choice.message?.function_call))
        || blocks.some(block => block.type === 'tool_use') || parts.some(part => part.functionCall)
        || data?.content_block?.type === 'tool_use' || present(data?.message?.tool_calls)
        || present(data?.delta?.message?.tool_calls) || /tool-call/.test(data?.type ?? '');
    const output = (typeof data === 'string' && present(data)) || toolCalls || choices.some(choice => present([choice.text, choice.reasoning, choice.delta?.content, choice.message?.content,
        choice.delta?.reasoning_content, choice.delta?.reasoning, choice.message?.reasoning_content,
        choice.message?.reasoning, choice.delta?.images, choice.message?.images]))
        || blocks.some(block => present([block.text, block.thinking])) || parts.some(part => present([part.text, part.inlineData]))
        || present([data?.delta?.text, data?.delta?.thinking, data?.delta?.partial_json, data?.delta?.message?.content,
            data?.delta?.message?.tool_plan, data?.content_block?.text, data?.content_block?.thinking,
            data?.text, data?.thinking, data?.message?.content, data?.message?.tool_plan]);
    const finishes = choices.filter(choice => choice.finish_reason != null).map(choice => choice.index ?? 0);
    const terminal = data?.type === 'message_stop' || data?.type === 'message-end';
    const finished = terminal || data?.candidates?.some(candidate => candidate.finishReason)
        || Boolean(data?.delta?.stop_reason) || Boolean(data?.finish_reason);
    const blocked = choices.some(choice => choice.finish_reason === 'content_filter')
        || data?.candidates?.some(candidate => ['SAFETY', 'RECITATION', 'BLOCKLIST', 'PROHIBITED_CONTENT'].includes(candidate.finishReason));
    return { output: Boolean(output), toolCalls: Boolean(toolCalls), finishes, terminal, finished: Boolean(finished),
        failure: responseFailure(data) ?? (blocked ? new GenerationFailure('request-rejected') : null) };
}

/** Parse SSE incrementally without changing the bytes forwarded to SillyTavern. */
export class StreamInspector {
    constructor(expectedChoices = 1) {
        this.decoder = new TextDecoder();
        this.pending = '';
        this.data = [];
        this.event = '';
        this.output = false;
        this.toolCalls = false;
        this.terminal = false;
        this.finished = false;
        this.finishedChoices = new Set();
        this.expectedChoices = expectedChoices;
    }

    push(bytes, final = false) {
        this.pending += this.decoder.decode(bytes, { stream: !final });
        let match;
        while ((match = /\r\n|\r|\n/.exec(this.pending))) {
            if (!final && match[0] === '\r' && match.index === this.pending.length - 1) break;
            const line = this.pending.slice(0, match.index);
            this.pending = this.pending.slice(match.index + match[0].length);
            this.line(line);
        }
        if (final) {
            // Native SSE parsing ignores an event without its blank-line delimiter.
            if (!this.terminal && (this.data.length || (this.pending && !this.pending.startsWith(':')))) {
                throw new GenerationFailure('incomplete-stream', { retryable: true });
            }
            this.pending = '';
            this.data = [];
            this.event = '';
        }
        if (this.pending.length > 16 * 1024 * 1024) throw new GenerationFailure('invalid-stream');
    }

    line(line) {
        if (this.terminal) return;
        if (!line) { this.dispatch(); return; }
        if (line.startsWith('data:')) this.data.push(line.slice(5).replace(/^ /, ''));
        if (line.startsWith('event:')) this.event = line.slice(6).trim();
    }

    dispatch() {
        const raw = this.data.join('\n'), event = this.event;
        this.data = [];
        this.event = '';
        if (raw === '[DONE]') { this.terminal = this.finished = true; return; }
        if (!raw) return;
        let parsed;
        try { parsed = JSON.parse(raw); }
        catch { throw new GenerationFailure('invalid-stream', { retryable: true }); }
        const inspection = inspectPayload(parsed);
        // Latch content before reporting an error in the same frame: replay would be unsafe.
        this.output ||= inspection.output;
        this.toolCalls ||= inspection.toolCalls;
        if (inspection.failure) throw inspection.failure;
        if (event === 'error' || parsed?.type === 'error') throw new GenerationFailure('upstream-error', { retryable: true });
        for (const index of inspection.finishes) this.finishedChoices.add(index);
        this.finished ||= inspection.finished || this.finishedChoices.size >= this.expectedChoices;
        this.terminal ||= inspection.terminal;
    }
}
