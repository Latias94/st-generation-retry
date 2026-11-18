import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRetryController } from '../src/controller.js';
import { GenerationFailure, normalizeSettings, retryDelay } from '../src/policy.js';
import { createNotifier } from '../src/notifications.js';
import { requestWithRetry } from '../src/transport.js';

function setup(request) {
    const context = { chatId: 'test', characterId: 1, mainApi: 'openai', chatCompletionSettings: {} };
    const jobs = new Map(), outcomes = [], sessions = [], statuses = [], logs = [];
    const settings = normalizeSettings();
    let serial = 0, busy = false;
    const controller = createRetryController({
        getContext: () => context, getSettings: () => settings,
        isHostBusy: () => busy,
        logger: { error: (...args) => logs.push(args) },
        onOutcome: value => outcomes.push(value), onStatus: value => statuses.push(value),
        request: async (...args) => { sessions.push(args[4]); return request ? request(...args) : Response.json({}); },
        schedule: callback => { const id = ++serial; jobs.set(id, callback); return id; },
        unschedule: id => jobs.delete(id),
    });
    const fetcher = async () => Response.json({ passthrough: true });
    const fetch = (payload = {}, url = '/api/backends/chat-completions/generate', prepare = true) => {
        const data = { type: 'normal', ...payload };
        if (prepare) controller.requestReady(data);
        return controller.fetch(fetcher, url, { method: 'POST', body: JSON.stringify(data) });
    };
    return { controller, context, outcomes, sessions, statuses, settings, logs, fetch,
        setBusy: value => { busy = value; },
        flush: () => { const pending = [...jobs.values()]; jobs.clear(); pending.forEach(callback => callback()); } };
}

test('notifies exactly once after success, message rendering, and generation end', async () => {
    const h = setup();
    h.controller.start();
    await h.fetch();
    h.sessions[0].onResult('success', {});
    h.controller.end();
    h.flush();
    assert.equal(h.outcomes.length, 0);
    h.controller.rendered();
    h.flush();
    h.controller.end();
    h.flush();
    assert.deepEqual(h.outcomes.map(x => x.outcome), ['success']);
});

test('does not misclassify the error-path MESSAGE_RECEIVED event as success', async () => {
    const h = setup();
    h.controller.start();
    await h.fetch();
    h.sessions[0].onResult('failure', new GenerationFailure('incomplete-stream', { partial: true }));
    h.controller.end();
    h.controller.rendered();
    h.flush();
    assert.deepEqual(h.outcomes.map(x => x.outcome), ['failure']);
});

test('a streamed error produces one safe final diagnostic even when result notifications are disabled', async () => {
    const h = setup(requestWithRetry);
    Object.assign(h.settings, { retryEnabled: true, notificationsEnabled: false, maxRetries: 0 });
    const signal = new AbortController().signal;
    h.context.streamingProcessor = { abortController: { signal } };
    const data = { type: 'normal', stream: true };
    const raw = '{"error":{"message":"PRIVATE","status":503}}';
    h.controller.start();
    h.controller.requestReady(data);
    const response = await h.controller.fetch(async () => new Response(`event: error\ndata: ${raw}\n\n`,
        { headers: { 'content-type': 'text/event-stream' } }), '/api/backends/chat-completions/generate',
        { method: 'POST', signal, body: JSON.stringify(data) });
    await assert.rejects(response.text(), { code: 'upstream-error' });
    assert.equal(h.logs.length, 0, 'Report the consolidated failure after the native generation ends');
    h.controller.end();
    h.flush();
    h.controller.end();
    h.flush();
    assert.equal(h.logs.length, 1);
    assert.equal(h.logs[0][0], '[Generation Retry] Generation failed.');
    assert.deepEqual(h.logs[0][1], { generation: 1, code: 'upstream-error', status: 503, partial: false, retries: 0 });
    assert.equal(JSON.stringify(h.logs).includes('PRIVATE'), false);
    assert.deepEqual(h.outcomes.map(x => x.outcome), ['failure']);
    assert.equal(h.statuses.at(-1).failure.detail.body, raw);
    assert.equal(h.statuses.at(-1).failure.detail.event, 'error');
});

test('recovered failures and manual stops do not log a final failure', async () => {
    for (const cancelled of [false, true]) {
        const h = setup();
        h.controller.start();
        await h.fetch();
        h.sessions[0].onRetry({ retry: 1, milliseconds: 1000 });
        if (cancelled) h.controller.cancel();
        h.sessions[0].onResult('success', {});
        h.controller.rendered();
        h.controller.end();
        h.flush();
        assert.equal(h.logs.length, 0);
    }
});

test('waits for tool follow-ups and consolidates their outcome', async () => {
    const h = setup();
    h.controller.start();
    await h.fetch();
    h.sessions[0].onResult('success', { toolCalls: true });
    h.controller.rendered();
    h.controller.start('normal');
    await h.fetch();
    h.sessions[1].onResult('failure', new GenerationFailure('upstream-error'));
    h.controller.end();
    h.flush();
    assert.deepEqual(h.outcomes.map(x => x.outcome), ['failure']);
});

test('group member replies produce one result at the end of the group wrapper', async () => {
    const h = setup();
    h.context.groupId = 'group';
    h.controller.start();
    h.controller.groupStart();
    for (const character of [1, 2]) {
        h.context.characterId = character;
        h.controller.start();
        await h.fetch();
        h.sessions.at(-1).onResult('success', {});
        h.controller.end();
        h.controller.rendered();
        h.flush();
        assert.equal(h.outcomes.length, 0);
    }
    h.controller.groupEnd();
    h.flush();
    assert.deepEqual(h.outcomes.map(x => x.outcome), ['success']);
});

test('quiet, dry-run, disabled, external, and unrelated requests pass through', async () => {
    for (const mode of ['quiet', 'dry', 'disabled', 'external', 'status']) {
        const h = setup();
        if (mode === 'disabled') h.settings.retryEnabled = h.settings.notificationsEnabled = false;
        h.controller.start(mode === 'quiet' ? 'quiet' : 'normal', {}, mode === 'dry');
        const response = await h.fetch(mode === 'quiet' ? { type: 'quiet' } : {},
            mode === 'external' ? '/api/other/generate' : mode === 'status' ? '/api/backends/chat-completions/status' : undefined);
        assert.equal((await response.json()).passthrough, true);
        assert.equal(h.sessions.length, 0);
    }
});

test('cancels on user stop and suppresses stale late outcomes', async () => {
    const h = setup();
    h.controller.start();
    await h.fetch();
    h.controller.cancel();
    assert.equal(h.sessions[0].signal.aborted, true);
    h.sessions[0].onResult('success', {});
    h.controller.end();
    h.controller.rendered();
    h.flush();
    assert.equal(h.outcomes.length, 0);
});

test('a changed chat or connection invalidates an in-flight session', async () => {
    for (const mutate of [context => { context.chatId = 'new'; }, context => { context.chatCompletionSettings.custom_url = 'changed'; }]) {
        const h = setup();
        h.controller.start();
        await h.fetch();
        mutate(h.context);
        assert.equal(h.sessions[0].isCurrent(), false);
        h.sessions[0].onResult('success', {});
        h.controller.end();
        h.flush();
        assert.equal(h.outcomes.length, 0);
    }
});

test('normalizes persisted settings and caps exponential backoff and Retry-After', () => {
    const settings = normalizeSettings({ maxRetries: 100, delaySeconds: -4, enabled: 'true', maxDelaySeconds: 10 });
    assert.equal(settings.maxRetries, 10);
    assert.equal(settings.delaySeconds, 1);
    assert.equal(settings.retryEnabled, true);
    assert.equal(settings.notificationsEnabled, true);
    assert.equal(retryDelay(settings, 2, '5'), 5000);
    assert.equal(retryDelay(settings, 10, '600'), 10000);
    assert.equal(retryDelay(settings, 2, 'bad'), 2000);
});

for (const retryEnabled of [false, true]) {
    for (const notificationsEnabled of [false, true]) {
        for (const success of [false, true]) {
            test(`independent switches: retry=${retryEnabled}, notifications=${notificationsEnabled}, success=${success}`, async () => {
                const h = setup((...args) => requestWithRetry(...args, { sleep: async () => {} }));
                Object.assign(h.settings, { retryEnabled, notificationsEnabled, maxRetries: 1 });
                let calls = 0;
                const data = { type: 'normal', stream: false };
                h.controller.start();
                h.controller.requestReady(data);
                const response = h.controller.fetch(async () => {
                    calls++;
                    return success ? Response.json({ choices: [{ message: { content: 'Test reply.' } }] })
                        : Response.json({ error: 'busy' }, { status: 503 });
                }, '/api/backends/chat-completions/generate', { method: 'POST', body: JSON.stringify(data) });
                if (!success && (retryEnabled || notificationsEnabled)) await assert.rejects(response, { code: 'upstream-error' });
                else await response;
                h.controller.rendered();
                h.controller.end();
                h.flush();
                assert.equal(calls, !success && retryEnabled ? 2 : 1);
                assert.equal(h.statuses.some(status => status.phase === 'waiting'), !success && retryEnabled);
                assert.deepEqual(h.outcomes.map(result => result.outcome), retryEnabled || notificationsEnabled ? [success ? 'success' : 'failure'] : []);
                const toasts = [];
                const notifier = createNotifier({ environment: {}, toast: (...args) => toasts.push(args) });
                for (const result of h.outcomes) await notifier.publish(result, h.settings);
                assert.deepEqual(toasts.map(([kind]) => kind), notificationsEnabled ? [success ? 'success' : 'error'] : []);
            });
        }
    }
}

test('a new normal generation does not inherit a previous completed failure', async () => {
    const h = setup();
    h.controller.start();
    await h.fetch();
    h.sessions[0].onResult('failure', new GenerationFailure('upstream-error'));
    h.controller.end();
    h.controller.start();
    await h.fetch();
    h.sessions[1].onResult('success', {});
    h.controller.rendered();
    h.controller.end();
    h.flush();
    assert.deepEqual(h.outcomes.map(x => x.outcome), ['failure', 'success']);
});

test('a successful tool-only generation can finish without a rendered assistant message', async () => {
    const h = setup();
    h.controller.start();
    await h.fetch();
    h.sessions[0].onResult('success', { toolCalls: true });
    const tools = h.controller.toolsStarted();
    h.controller.toolsFinished(tools, []);
    h.controller.end();
    h.flush();
    assert.deepEqual(h.outcomes.map(x => x.outcome), ['success']);
});

test('background requests without a native preparation event cannot consume the main request', async () => {
    const h = setup();
    h.controller.start();
    const response = await h.fetch({ type: undefined }, undefined, false);
    assert.equal((await response.json()).passthrough, true);
    assert.equal(h.sessions.length, 0);
    const typedBackground = await h.fetch({}, undefined, false);
    assert.equal((await typedBackground.json()).passthrough, true);
    await h.fetch();
    assert.equal(h.sessions.length, 1);
});

test('allows another extension to transform messages and tools after native preparation', async () => {
    const h = setup();
    const signal = new AbortController().signal;
    h.context.streamingProcessor = { abortController: { signal } };
    h.controller.start();
    h.controller.requestReady({ type: 'normal', model: 'model', stream: true });
    await h.controller.fetch(async () => assert.fail('Native request must be intercepted'), '/api/backends/chat-completions/generate', {
        method: 'POST', signal, body: JSON.stringify({ type: 'normal', model: 'model', stream: true,
            messages: [{ role: 'user', content: 'Transformed by another extension' }], tools: [] }),
    });
    assert.equal(h.sessions.length, 1);
});

test('independent streaming requests cannot steal a native generation before its processor exists', async () => {
    const h = setup();
    h.controller.start();
    const response = await h.fetch({ stream: true });
    assert.equal((await response.json()).passthrough, true);
    assert.equal(h.sessions.length, 0);
    const signal = new AbortController().signal;
    h.context.streamingProcessor = { abortController: { signal } };
    const data = { type: 'normal', stream: true };
    h.controller.requestReady(data);
    await h.controller.fetch(async () => assert.fail('Native request must be intercepted'), '/api/backends/chat-completions/generate', {
        method: 'POST', signal, body: JSON.stringify(data),
    });
    assert.equal(h.sessions.length, 1);
});

test('slow host saves cannot finish before auto-continue starts and fails', async () => {
    const h = setup();
    h.controller.start();
    await h.fetch();
    h.sessions[0].onResult('success', {});
    h.setBusy(true);
    h.controller.rendered();
    h.controller.end();
    for (let tick = 0; tick < 20; tick++) h.flush();
    assert.equal(h.outcomes.length, 0);
    h.controller.start('continue');
    await h.fetch({ type: 'continue' });
    h.sessions[1].onResult('failure', new GenerationFailure('upstream-error'));
    h.setBusy(false);
    h.controller.end();
    h.flush();
    assert.deepEqual(h.outcomes.map(x => x.outcome), ['failure']);
});

test('a group wrapper entered before any member generation stays tracked until wrapper finish', async () => {
    const h = setup();
    h.context.groupId = 'group';
    h.controller.groupStart({ selected_group: 'group', type: 'normal' });
    for (const character of [1, 2]) {
        h.context.characterId = character;
        h.controller.start();
        await h.fetch();
        h.sessions.at(-1).onResult('success', {});
        h.controller.rendered();
        h.controller.end();
        h.flush();
        assert.equal(h.outcomes.length, 0);
    }
    h.controller.groupEnd({ selected_group: 'group' });
    h.flush();
    assert.deepEqual(h.outcomes.map(x => x.outcome), ['success']);
});

test('a failing stealth tool is a final failure, not a successful empty reply', async () => {
    const h = setup();
    h.controller.start();
    await h.fetch();
    h.sessions[0].onResult('success', { toolCalls: true });
    const tools = h.controller.toolsStarted();
    h.controller.toolsFinished(tools, [new Error('Tool diagnostic')]);
    h.controller.end();
    h.flush();
    assert.deepEqual(h.outcomes.map(x => [x.outcome, x.failure?.code]), [['failure', 'tool-error']]);
    assert.equal(h.statuses.at(-1).failure.detail.message, 'Error: Tool diagnostic');
});

test('unhandled tool calls cannot produce a success notification', async () => {
    const h = setup();
    h.controller.start();
    await h.fetch();
    h.sessions[0].onResult('success', { toolCalls: true });
    h.controller.rendered();
    h.controller.end();
    h.flush();
    assert.deepEqual(h.outcomes.map(x => [x.outcome, x.failure?.code]), [['failure', 'tool-error']]);
});

test('malformed persisted settings safely fall back to defaults', () => {
    for (const value of [null, false, 'invalid']) assert.deepEqual(normalizeSettings(value), normalizeSettings());
});

test('notifications request permission only on explicit action and never disclose response bodies', async () => {
    const sent = [], toasts = [];
    let requests = 0;
    class Notification {
        static permission = 'default';
        static async requestPermission() { requests++; this.permission = 'granted'; }
        constructor(title, options) { sent.push({ title, ...options }); queueMicrotask(() => this.onshow?.()); }
    }
    const environment = { Notification, isSecureContext: true, document: { visibilityState: 'visible', hasFocus: () => true } };
    const notifier = createNotifier({ environment, toast: (...args) => toasts.push(args) });
    assert.equal(requests, 0);
    notifier.publish({ outcome: 'success', retries: 1, id: 1 }, normalizeSettings());
    assert.equal(toasts.length, 1);
    await notifier.requestPermission();
    assert.equal(requests, 1);
    notifier.publish({ outcome: 'failure', failure: { code: 'network-error', message: 'PRIVATE', body: 'PRIVATE' }, id: 2 }, normalizeSettings());
    assert.equal(sent.length, 1);
    assert.equal(JSON.stringify(sent).includes('PRIVATE'), false);
    notifier.publish({ outcome: 'success', id: 3 }, normalizeSettings({ backgroundOnly: true }));
    assert.equal(sent.length, 1);
    environment.document.visibilityState = 'hidden';
    notifier.publish({ outcome: 'success', id: 4 }, normalizeSettings({ backgroundOnly: true }));
    assert.equal(sent.length, 2);
});
