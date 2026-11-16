import assert from 'node:assert/strict';
import { test } from 'node:test';
import { normalizeSettings } from '../src/policy.js';
import { requestWithRetry } from '../src/transport.js';

const encoder = new TextEncoder();
const frame = data => `data: ${typeof data === 'string' ? data : JSON.stringify(data)}\n\n`;
const textFrame = text => frame({ choices: [{ index: 0, delta: { content: text } }] });
const endFrame = frame({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
const ok = () => Response.json({ choices: [{ message: { content: 'Neutral test reply.' } }] });
const sse = (...parts) => new Response(new ReadableStream({
    start(controller) {
        for (const part of parts) {
            if (part instanceof Error) { controller.error(part); return; }
            controller.enqueue(encoder.encode(part));
        }
        controller.close();
    },
}), { headers: { 'content-type': 'text/event-stream' } });

function setup(responses, settings = {}) {
    const calls = [], retries = [], results = [], waits = [];
    const abort = new AbortController();
    let isCurrent = true;
    const fetcher = async (input, init) => {
        calls.push({ input, init });
        const response = responses.shift();
        if (response instanceof Error) throw response;
        return typeof response === 'function' ? response(init) : response;
    };
    const session = {
        settings: normalizeSettings(settings), signal: abort.signal, isCurrent: () => isCurrent,
        onRetry: value => retries.push(value),
        onResult: (...value) => results.push(value),
    };
    const run = (stream = false, options = {}) => requestWithRetry(fetcher, '/api/backends/chat-completions/generate',
        { method: 'POST', body: '{"messages":[]}', headers: { 'x-csrf-token': 'test' } }, { stream }, session,
        { sleep: async milliseconds => waits.push(milliseconds), ...options });
    return { run, calls, retries, results, waits, abort, leave: () => { isCurrent = false; } };
}

test('retries a transient HTTP failure with identical request bytes and returns success once', async () => {
    const harness = setup([Response.json({ error: 'busy' }, { status: 503, headers: { 'retry-after': '5' } }), ok()]);
    assert.equal((await (await harness.run()).json()).choices[0].message.content, 'Neutral test reply.');
    assert.equal(harness.calls.length, 2);
    assert.deepEqual(harness.calls[0], harness.calls[1]);
    assert.deepEqual(harness.waits, [5000]);
    assert.deepEqual(harness.results.map(x => x[0]), ['success']);
});

test('retries network errors then stops after the configured number of retries', async () => {
    const harness = setup(Array.from({ length: 3 }, () => new TypeError('Failed to fetch')), { maxRetries: 2 });
    await assert.rejects(harness.run(), { code: 'network-error' });
    assert.equal(harness.calls.length, 3);
    assert.deepEqual(harness.waits, [2000, 4000]);
    assert.deepEqual(harness.results.map(x => x[0]), ['failure']);
});

for (const status of [400, 401, 403, 404]) {
    test(`does not retry HTTP ${status}`, async () => {
        const harness = setup([Response.json({ error: 'rejected' }, { status })]);
        await assert.rejects(harness.run());
        assert.equal(harness.calls.length, 1);
    });
}

for (const data of [
    { quota_error: true, error: { message: 'Too Many Requests' } },
    { error: { code: 'invalid_api_key' } },
    { error: { message: 'maximum context length exceeded' } },
    { error: { message: 'Bad Request' } },
]) {
    test(`does not retry permanent errors wrapped in HTTP 200: ${JSON.stringify(data)}`, async () => {
        const harness = setup([Response.json(data)]);
        await assert.rejects(harness.run(), { code: 'request-rejected' });
        assert.equal(harness.calls.length, 1);
    });
}

test('handles a transient error envelope in HTTP 200 and invalid JSON responses', async () => {
    const harness = setup([Response.json({ error: { message: 'Bad Gateway' } }), new Response('<html>proxy error</html>'), ok()]);
    await harness.run();
    assert.equal(harness.calls.length, 3);
});

test('can retry an empty reply, but never replays a tool call or reasoning-only response', async () => {
    const empty = setup([Response.json({ choices: [] }), ok()]);
    await empty.run();
    assert.equal(empty.calls.length, 2);
    for (const message of [{ tool_calls: [{ id: 'call_1', function: { name: 'test', arguments: '{}' } }] }, { reasoning_content: 'thinking' }]) {
        const harness = setup([Response.json({ choices: [{ message }] })]);
        await harness.run();
        assert.equal(harness.calls.length, 1);
    }
});

test('recognizes Gemini images, Gemini reasoning, and Cohere tool-only replies', async () => {
    for (const response of [
        { responseContent: { parts: [{ inlineData: { data: 'image', mimeType: 'image/png' } }] } },
        { responseContent: { parts: [{ thought: true, text: 'thinking' }] } },
        { message: { tool_calls: [{ id: 'call_1', function: { name: 'test', arguments: '{}' } }] } },
    ]) {
        const harness = setup([Response.json(response)]);
        await harness.run();
        assert.equal(harness.calls.length, 1);
        assert.deepEqual(harness.results.map(x => x[0]), ['success']);
    }
});

test('whitespace-only replies count as empty in JSON and streaming responses', async () => {
    const json = setup([Response.json({ choices: [{ message: { content: ' \n\t' } }] }), ok()]);
    await json.run();
    assert.equal(json.calls.length, 2);
    const stream = setup([sse(textFrame(' \n\t'), frame('[DONE]')), sse(textFrame('complete'), frame('[DONE]'))]);
    await (await stream.run(true)).text();
    assert.equal(stream.calls.length, 2);
});

test('streams bytes unchanged and recognizes a finish marker without DONE', async () => {
    const raw = textFrame('测试 reply') + endFrame;
    const bytes = encoder.encode(raw);
    const response = new Response(new ReadableStream({
        start(controller) {
            for (const byte of bytes) controller.enqueue(Uint8Array.of(byte));
            controller.close();
        },
    }), { headers: { 'content-type': 'text/event-stream' } });
    const harness = setup([response]);
    assert.equal(await (await harness.run(true)).text(), raw);
    assert.deepEqual(harness.results.map(x => x[0]), ['success']);
});

test('retries an in-band SSE error before output, suppressing failed frames', async () => {
    const raw = textFrame('complete') + endFrame + frame('[DONE]');
    const harness = setup([sse(': heartbeat\n\n', frame({ error: { message: 'overloaded' } })), sse(raw)]);
    assert.equal(await (await harness.run(true)).text(), raw);
    assert.equal(harness.calls.length, 2);
    assert.deepEqual(harness.results.map(x => x[0]), ['success']);
});

test('retries an empty completed stream before any output', async () => {
    const harness = setup([sse(frame('[DONE]')), sse(textFrame('complete'), frame('[DONE]'))]);
    await (await harness.run(true)).text();
    assert.equal(harness.calls.length, 2);
});

test('does not retry or report success after a stream is truncated following output', async () => {
    const harness = setup([sse(textFrame('partial'))]);
    await assert.rejects((await harness.run(true)).text(), { code: 'incomplete-stream', partial: true });
    assert.equal(harness.calls.length, 1);
    assert.deepEqual(harness.results.map(x => x[0]), ['failure']);
});

test('does not replay a partial tool call or reasoning frame', async () => {
    for (const delta of [
        { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'test', arguments: '{' } }] },
        { reasoning_content: 'thinking' },
    ]) {
        const harness = setup([sse(frame({ choices: [{ delta }] }))]);
        await assert.rejects((await harness.run(true)).text(), { partial: true });
        assert.equal(harness.calls.length, 1);
    }
});

test('supports Claude completion markers', async () => {
    const harness = setup([sse(
        frame({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'complete' } }),
        frame({ type: 'message_stop' }),
    )]);
    await (await harness.run(true)).text();
    assert.deepEqual(harness.results.map(x => x[0]), ['success']);
});

test('requires all multi-swipe choices to finish when DONE is absent', async () => {
    const harness = setup([sse(textFrame('first'), endFrame)]);
    const session = {
        settings: normalizeSettings(), signal: harness.abort.signal, isCurrent: () => true,
        onRetry() {}, onResult: (...value) => harness.results.push(value),
    };
    const response = await requestWithRetry(async () => sse(textFrame('first'), endFrame), '/', {}, { stream: true, n: 2 }, session);
    await assert.rejects(response.text(), { code: 'incomplete-stream' });
});

test('does not report an unfinished SSE event as a successfully rendered reply', async () => {
    const harness = setup([sse(textFrame('partial'), 'data: {"choices":[{"finish_reason":"stop"}]}')]);
    await assert.rejects((await harness.run(true)).text(), { code: 'incomplete-stream', partial: true });
    assert.deepEqual(harness.results.map(x => x[0]), ['failure']);
});

test('zero retries preserves failure notifications without resending', async () => {
    const harness = setup([Response.json({ error: true }, { status: 503 }), ok()], { maxRetries: 0 });
    await assert.rejects(harness.run());
    assert.equal(harness.calls.length, 1);
    assert.deepEqual(harness.results.map(x => x[0]), ['failure']);
});

test('disabling retry never resends HTTP, network, empty, or SSE failures even with a positive retry limit', async () => {
    for (const [response, stream, code] of [
        [Response.json({ error: true }, { status: 503 }), false, 'upstream-error'],
        [new TypeError('Failed to fetch'), false, 'network-error'],
        [Response.json({ choices: [] }), false, 'empty-response'],
        [sse(frame({ error: { message: 'overloaded' } })), true, 'upstream-error'],
        [sse(frame('[DONE]')), true, 'empty-response'],
    ]) {
        const h = setup([response, ok()], { retryEnabled: false, maxRetries: 7 });
        await assert.rejects(async () => { await (await h.run(stream)).text(); }, { code });
        assert.equal(h.calls.length, 1);
        assert.deepEqual(h.waits, []);
        assert.deepEqual(h.results.map(result => result[0]), ['failure']);
    }
});

test('a caller cancelling a returned stream aborts its upstream reader', async () => {
    let cancelled = false;
    const harness = setup([new Response(new ReadableStream({ cancel() { cancelled = true; } }), { headers: { 'content-type': 'text/event-stream' } })]);
    const response = await harness.run(true);
    await response.body.cancel();
    assert.equal(cancelled, true);
    assert.deepEqual(harness.results.map(x => x[0]), ['cancelled']);
});

test('aborting during the backoff cancels immediately without another request', async () => {
    const harness = setup([new TypeError('Failed to fetch'), ok()]);
    await assert.rejects(harness.run(false, { sleep: async () => harness.abort.abort() }), { name: 'AbortError' });
    assert.equal(harness.calls.length, 1);
    assert.deepEqual(harness.results.map(x => x[0]), ['cancelled']);
});

test('changing context during backoff prevents the next attempt', async () => {
    const harness = setup([new TypeError('Failed to fetch'), ok()]);
    await assert.rejects(harness.run(false, { sleep: async () => harness.leave() }), { name: 'AbortError' });
    assert.equal(harness.calls.length, 1);
    assert.deepEqual(harness.results.map(x => x[0]), ['cancelled']);
});

test('cancels pending stream reads when the session is stopped', async () => {
    let cancelled = false;
    const harness = setup([new Response(new ReadableStream({ cancel() { cancelled = true; } }), { headers: { 'content-type': 'text/event-stream' } })]);
    const response = await harness.run(true), consumed = response.text();
    harness.abort.abort();
    await assert.rejects(consumed, { name: 'AbortError' });
    assert.equal(cancelled, true);
    assert.deepEqual(harness.results.map(x => x[0]), ['cancelled']);
});
