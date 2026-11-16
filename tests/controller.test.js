import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRetryController } from '../src/controller.js';
import { GenerationFailure, normalizeSettings, retryDelay } from '../src/policy.js';
import { createNotifier } from '../src/notifications.js';

function setup() {
    const context = { chatId: 'test', characterId: 1, mainApi: 'openai', chatCompletionSettings: {} };
    const jobs = new Map(), outcomes = [], sessions = [], statuses = [];
    const settings = normalizeSettings();
    let serial = 0, busy = false;
    const controller = createRetryController({
        getContext: () => context, getSettings: () => settings,
        isHostBusy: () => busy,
        onOutcome: value => outcomes.push(value), onStatus: value => statuses.push(value),
        request: async (...args) => { sessions.push(args[4]); return Response.json({}); },
        schedule: callback => { const id = ++serial; jobs.set(id, callback); return id; },
        unschedule: id => jobs.delete(id),
    });
    const fetcher = async () => Response.json({ passthrough: true });
    const fetch = (payload = {}, url = '/api/backends/chat-completions/generate', prepare = true) => {
        const data = { type: 'normal', ...payload };
        if (prepare) controller.requestReady(data);
        return controller.fetch(fetcher, url, { method: 'POST', body: JSON.stringify(data) });
    };
    return { controller, context, outcomes, sessions, statuses, settings, fetch,
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
        if (mode === 'disabled') h.settings.enabled = false;
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
    assert.equal(settings.enabled, true);
    assert.equal(retryDelay(settings, 2, '5'), 5000);
    assert.equal(retryDelay(settings, 10, '600'), 10000);
    assert.equal(retryDelay(settings, 2, 'bad'), 2000);
});

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
    h.controller.toolsFinished(tools, false);
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
    h.controller.toolsFinished(tools, true);
    h.controller.end();
    h.flush();
    assert.deepEqual(h.outcomes.map(x => [x.outcome, x.failure?.code]), [['failure', 'tool-error']]);
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
        constructor(title, options) { sent.push({ title, ...options }); }
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
