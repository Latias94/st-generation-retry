import { abortError, GenerationFailure, networkFailure, responseFailure, retryDelay, waitForRetry } from './policy.js';
import { inspectPayload, StreamInspector } from './stream.js';

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
    const retry = async (error, retryAfter, partial = false) => {
        check();
        const failure = networkFailure(error);
        failure.partial ||= partial;
        if (failure.name === 'AbortError' || partial || !failure.retryable || retries >= settings.maxRetries) throw failure;
        const milliseconds = retryDelay(settings, ++retries, retryAfter);
        session.onRetry({ retry: retries, milliseconds, code: failure.code, status: failure.status });
        await sleep(milliseconds, controller.signal);
        check();
    };
    const open = async () => {
        while (true) {
            let response;
            try {
                check();
                session.onAttempt?.();
                response = await fetcher(input, { ...init, signal: controller.signal });
                check();
                if (!response.ok) {
                    let data;
                    try { data = await response.json(); } catch { /* The HTTP status is sufficient. */ }
                    throw responseFailure(data, response.status);
                }
                const isSse = response.headers.get('content-type')?.includes('text/event-stream');
                if (!payload.stream || !isSse) {
                    // Keep one body for the caller; avoid teeing a potentially long lived SSE stream.
                    const bytes = await response.arrayBuffer();
                    check();
                    let data;
                    try { data = JSON.parse(new TextDecoder().decode(bytes)); }
                    catch { throw new GenerationFailure('invalid-response', { retryable: true }); }
                    const inspection = inspectPayload(data);
                    if (inspection.failure) throw inspection.failure;
                    if (payload.stream) throw new GenerationFailure('expected-stream', { retryable: true });
                    if (!inspection.output && settings.retryEmpty) throw new GenerationFailure('empty-response', { retryable: true });
                    settle('success', { toolCalls: inspection.toolCalls });
                    return new Response(bytes, { status: response.status, statusText: response.statusText, headers: response.headers });
                }
                if (!response.body) throw new GenerationFailure('empty-response', { retryable: true });
                return response;
            } catch (error) {
                await retry(error, response?.headers.get('retry-after'));
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
                    await reader.cancel().catch(() => {});
                    await retry(error, response.headers.get('retry-after'), committed);
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
