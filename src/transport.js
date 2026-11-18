import { abortError, GenerationFailure, networkFailure, responseFailure, retryDelay, waitForRetry } from './policy.js';
import { inspectPayload, StreamInspector } from './stream.js';

async function readHttpFailure(response) {
    let body, data, message;
    try {
        body = await response.text();
        data = JSON.parse(body);
    } catch (error) {
        if (body === undefined) message = String(error);
    }
    const failure = responseFailure(data, response.status) ?? new GenerationFailure('upstream-error', { status: response.status });
    return failure.addDetail({ body, message });
}

/** Retry the same serialized request, never the Generate() call or its side effects. */
export async function requestWithRetry(fetcher, input, init, payload, session, { sleep = waitForRetry } = {}) {
    const { settings } = session;
    const controller = new AbortController();
    const signals = [init.signal, session.signal].filter(Boolean);
    let retries = 0, reader, settled = false;
    const cancel = () => { controller.abort(); void reader?.cancel().catch(() => {}); };
    for (const signal of signals) {
        signal.addEventListener('abort', cancel, { once: true });
        if (signal.aborted) cancel();
    }
    const check = () => {
        if (controller.signal.aborted || !session.isCurrent()) throw abortError();
    };
    const cleanup = () => signals.forEach(signal => signal.removeEventListener('abort', cancel));
    const settle = (outcome, detail) => {
        if (settled) return;
        settled = true;
        cleanup();
        session.onResult(outcome, detail);
    };
    const fail = error => {
        const failure = controller.signal.aborted || !session.isCurrent() ? abortError() : networkFailure(error);
        settle(failure.name === 'AbortError' ? 'cancelled' : 'failure', failure);
        return failure;
    };
    const retry = async (error, response, partial = false) => {
        check();
        const failure = networkFailure(error);
        if (failure.name === 'AbortError') throw failure;
        failure.partial ||= partial;
        if (response) failure.addDetail({ httpStatus: response.status, statusText: response.statusText,
            contentType: response.headers.get('content-type') });
        if (!settings.retryEnabled || partial || !failure.retryable || retries >= settings.maxRetries) throw failure;
        const milliseconds = retryDelay(settings, ++retries, response?.headers.get('retry-after'));
        session.onRetry({ retry: retries, milliseconds, code: failure.code, status: failure.status });
        await sleep(milliseconds, controller.signal);
        check();
    };

    const isSse = async response => {
        const contentType = response.headers.get('content-type');
        if (contentType) return contentType.split(';', 1)[0].trim().toLowerCase() === 'text/event-stream';
        if (!response.body) return true;

        // SillyTavern can pipe upstream bodies without forwarding Content-Type.
        // Peek at a bounded prefix to recognize JSON and HTML error bodies without buffering SSE.
        reader = response.clone().body.getReader();
        const decoder = new TextDecoder();
        try {
            let remaining = 1024;
            while (remaining > 0) {
                const { done, value } = await reader.read();
                check();
                if (done) break;
                const first = decoder.decode(value.subarray(0, remaining), { stream: true }).trimStart()[0];
                if (first) return first !== '{' && first !== '[' && first !== '<';
                remaining -= value.byteLength;
            }
            return true;
        } catch (error) {
            void response.body.cancel().catch(() => {});
            throw error;
        } finally {
            // The clone's cancellation can stay pending while the original body is in use.
            void reader.cancel().catch(() => {});
            reader.releaseLock();
            reader = null;
        }
    };

    const open = async () => {
        while (true) {
            let response;
            try {
                check();
                session.onAttempt?.();
                response = await fetcher(input, { ...init, signal: controller.signal });
                check();
                if (!response.ok) throw await readHttpFailure(response);
                if (!payload.stream || !await isSse(response)) {
                    const bytes = await response.arrayBuffer();
                    check();
                    const body = new TextDecoder().decode(bytes);
                    let inspection;
                    try { inspection = inspectPayload(JSON.parse(body)); }
                    catch (error) {
                        throw new GenerationFailure('invalid-response', { retryable: true, detail: { body, message: String(error) } });
                    }
                    if (inspection.failure) throw inspection.failure.addDetail({ body });
                    if (payload.stream) throw new GenerationFailure('expected-stream', { retryable: true, detail: { body } });
                    if (!inspection.output && settings.retryEmpty) throw new GenerationFailure('empty-response', { retryable: true, detail: { body } });
                    settle('success', { toolCalls: inspection.toolCalls });
                    return new Response(bytes, { status: response.status, statusText: response.statusText, headers: response.headers });
                }
                if (!response.body) throw new GenerationFailure('empty-response', { retryable: true });
                return response;
            } catch (error) {
                await retry(error, response);
            }
        }
    };

    try {
        const initialResponse = await open();
        if (!payload.stream) return initialResponse;
        async function* chunks() {
            let response = initialResponse;
            while (true) {
                const inspector = new StreamInspector(Math.max(1, Number(payload.n) || 1));
                let prefix = [], prefixSize = 0, committed = false;
                reader = response.body.getReader();
                try {
                    while (true) {
                        check();
                        const { done, value } = await reader.read();
                        check();
                        inspector.push(value, done);
                        if (done) {
                            if (!inspector.finished) throw new GenerationFailure('incomplete-stream', { retryable: true });
                            if (!inspector.output && settings.retryEmpty) throw new GenerationFailure('empty-response', { retryable: true });
                            for (const bytes of prefix) yield bytes;
                            settle('success', { toolCalls: inspector.toolCalls });
                            return;
                        }
                        if (committed || inspector.output || (inspector.terminal && !settings.retryEmpty)) {
                            committed = true;
                            for (const bytes of prefix) yield bytes;
                            prefix = [];
                            yield value;
                        } else {
                            prefix.push(value);
                            prefixSize += value.byteLength;
                            if (prefixSize > 1024 * 1024) throw new GenerationFailure('invalid-stream');
                        }
                        if (inspector.terminal) {
                            if (!inspector.output && settings.retryEmpty) throw new GenerationFailure('empty-response', { retryable: true });
                            settle('success', { toolCalls: inspector.toolCalls });
                            return;
                        }
                    }
                } catch (error) {
                    // Do not replay reasoning, text, images, or tool calls after any has reached the caller.
                    if (error instanceof GenerationFailure && error.detail?.body === undefined && prefix.length) {
                        const decoder = new TextDecoder();
                        const body = prefix.map(bytes => decoder.decode(bytes, { stream: true })).join('') + decoder.decode();
                        error.addDetail({ body });
                    }
                    await reader.cancel().catch(() => {});
                    await retry(error, response, committed);
                } finally {
                    await reader.cancel().catch(() => {});
                    reader.releaseLock();
                    reader = null;
                }
                response = await open();
            }
        }
        const iterator = chunks();
        const body = new ReadableStream({
            async pull(stream) {
                try {
                    const { done, value } = await iterator.next();
                    done ? stream.close() : stream.enqueue(value);
                } catch (error) { stream.error(fail(error)); }
            },
            async cancel() {
                cancel();
                settle('cancelled');
                await iterator.return();
            },
        });
        const headers = new Headers(initialResponse.headers);
        headers.delete('content-length');
        headers.delete('content-encoding');
        return new Response(body, { status: initialResponse.status, statusText: initialResponse.statusText, headers });
    } catch (error) { throw fail(error); }
}
