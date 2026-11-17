import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createNotifier } from '../src/notifications.js';
import { normalizeSettings } from '../src/policy.js';

function setup(mode) {
    const statuses = [], toasts = [], sent = [];
    class Notification {
        static permission = 'granted';
        constructor(title, options) {
            sent.push({ title, options });
            if (mode === 'throw') throw new Error('Browser notification failure');
            if (mode === 'show') queueMicrotask(() => this.onshow?.());
            if (mode === 'error') queueMicrotask(() => this.onerror?.());
        }
    }
    const environment = { Notification, isSecureContext: true, location: { origin: 'http://127.0.0.1:8000' } };
    const notifier = createNotifier({ environment, receiptTimeout: 5, onStatus: value => statuses.push(value), toast: (...value) => toasts.push(value) });
    return { notifier, environment, statuses, toasts, sent };
}

test('a browser error after construction is not reported as successful delivery', async () => {
    const h = setup('error');
    assert.equal(await h.notifier.test(), false);
    assert.equal(h.statuses.at(-1).phase, 'error');
    assert.equal(h.toasts.length, 1);
    assert.equal(h.toasts[0][0], 'warning');
});

test('a silent notification timeout gives visible feedback instead of doing nothing', async () => {
    const h = setup('silent');
    assert.equal(await h.notifier.test(), false);
    assert.equal(h.statuses.at(-1).phase, 'unconfirmed');
    assert.equal(h.toasts.length, 1);
});

test('a displayed test notification confirms the browser receipt and explains Windows checks', async () => {
    const h = setup('show');
    assert.equal(await h.notifier.test(), true);
    assert.equal(h.statuses.at(-1).phase, 'shown');
    assert.equal(h.toasts[0][1].includes('Win+N'), true);
    assert.equal(h.sent[0].options.requireInteraction, true);
});

test('a constructor failure is visible without unhandled rejection', async () => {
    const h = setup('throw');
    assert.equal(await h.notifier.test(), false);
    assert.equal(h.statuses.at(-1).phase, 'error');
});

test('result notifications fall back to a toast if system delivery fails', async () => {
    const h = setup('error');
    await h.notifier.publish({ outcome: 'success', id: 1 }, normalizeSettings());
    assert.equal(h.toasts.length, 1);
    assert.equal(h.toasts[0][0], 'success');
});

for (const mode of ['show', 'error', 'silent', 'throw']) {
    test(`a final failure immediately shows one in-app error with desktop delivery mode ${mode}`, async () => {
        const h = setup(mode);
        const pending = h.notifier.publish({ outcome: 'failure', retries: 2, id: 1,
            failure: { code: 'incomplete-stream', partial: true, message: 'PRIVATE' } }, normalizeSettings());
        assert.equal(h.toasts.length, 1, 'The in-app error must not wait for a desktop receipt');
        assert.equal(h.toasts[0][0], 'error');
        assert.equal(h.toasts[0][1].includes('已保留部分回复'), true);
        assert.equal(h.toasts[0][1].includes('2'), true);
        await pending;
        assert.equal(h.sent.length, 1);
        assert.equal(h.toasts.length, 1, 'A failed receipt must not duplicate the in-app error');
        assert.equal(JSON.stringify([h.sent, h.toasts]).includes('PRIVATE'), false);
    });
}

test('permission information names the exact origin and does not request permission implicitly', async () => {
    const h = setup('show');
    h.environment.Notification.permission = 'default';
    h.environment.Notification.requestPermission = () => assert.fail('Permission must only be requested explicitly');
    assert.equal(await h.notifier.test(), false);
    assert.equal(h.sent.length, 0);
    assert.equal(h.notifier.details().origin, 'http://127.0.0.1:8000');
    assert.equal(h.toasts[0][1].includes('127.0.0.1:8000'), true);
});

test('the notification switch suppresses both desktop and fallback notifications without disabling retry', async () => {
    for (const mode of ['show', 'error']) {
        const h = setup(mode);
        for (const outcome of ['success', 'failure']) {
            await h.notifier.publish({ outcome, id: 1 }, normalizeSettings({ retryEnabled: true, notificationsEnabled: false }));
        }
        assert.equal(h.sent.length, 0);
        assert.equal(h.toasts.length, 0);
        assert.equal(h.statuses.length, 0);
    }
});

test('success and failure desktop notifications remain enabled with retry switched off', async () => {
    const h = setup('show');
    for (const outcome of ['success', 'failure']) {
        await h.notifier.publish({ outcome, id: 1 }, normalizeSettings({ retryEnabled: false, notificationsEnabled: true }));
    }
    assert.equal(h.sent.length, 2);
    assert.equal(h.toasts.length, 1);
    assert.equal(h.toasts[0][0], 'error');
});
