import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createSettingsStore } from '../src/settings.js';
import { normalizeSettings } from '../src/policy.js';

function setup(storage = new Map(), userId = 'test-user') {
    const context = { extensionSettings: {}, saveSettingsDebounced() { saves++; } };
    const statuses = [];
    let saves = 0, saved;
    const options = { getContext: () => context, userId,
        storage: { getItem: key => storage.get(key), setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) },
        readSaved: async () => saved, onStatus: value => statuses.push(value) };
    return { store: createSettingsStore(options), context, statuses, options,
        setSaved: value => { saved = value; }, saves: () => saves };
}

test('a pending edit survives reload before native debounced save executes', () => {
    const local = new Map(), before = setup(local);
    before.store.update({ ...normalizeSettings(), maxRetries: 7, notifySuccess: false });
    const after = setup(local);
    assert.equal(after.store.restore().maxRetries, 7);
    assert.equal(after.store.read().notifySuccess, false);
    assert.equal(after.saves(), 1);
});

test('local edits are cleared only after matching server readback', async () => {
    const local = new Map(), h = setup(local);
    const next = h.store.update({ ...normalizeSettings(), maxRetries: 7 });
    await h.store.confirm();
    assert.equal(local.size, 1);
    assert.equal(h.statuses.at(-1).phase, 'unsynced');
    h.setSaved(next);
    await h.store.confirm();
    assert.equal(local.size, 0);
    assert.equal(h.statuses.at(-1).phase, 'saved');
});
test('restoring pending fields preserves unrelated server-side settings', () => {
    const local = new Map(), before = setup(local);
    before.store.update({ ...normalizeSettings(), maxRetries: 7 });
    const after = setup(local);
    after.context.extensionSettings.generation_retry = { ...normalizeSettings(), delaySeconds: 18, notifyFailure: false };
    const restored = after.store.restore();
    assert.equal(restored.maxRetries, 7);
    assert.equal(restored.delaySeconds, 18);
    assert.equal(restored.notifyFailure, false);
});

test('pending settings are scoped to the SillyTavern account', () => {
    const local = new Map(), first = setup(local, 'first');
    first.store.update({ ...normalizeSettings(), maxRetries: 7 });
    assert.equal(setup(local, 'second').store.restore().maxRetries, 3);
});

test('blocked storage does not prevent native persistence and reports the limitation', () => {
    const h = setup();
    const store = createSettingsStore({ ...h.options, storage: { getItem() { throw new Error(); }, setItem() { throw new Error(); }, removeItem() { throw new Error(); } } });
    store.restore();
    store.update({ ...normalizeSettings(), maxRetries: 7 });
    assert.equal(h.context.extensionSettings.generation_retry.maxRetries, 7);
    assert.equal(h.saves(), 1);
    assert.deepEqual(h.statuses.at(-1), { phase: 'pending', local: false });
});

test('a slow readback cannot clear newer pending edits', async () => {
    const local = new Map(), h = setup(local);
    const reads = [];
    const store = createSettingsStore({ ...h.options, readSaved: () => new Promise(done => { reads.push(done); }) });
    const old = store.update({ ...normalizeSettings(), maxRetries: 7 });
    const confirm = store.confirm();
    const next = store.update({ ...normalizeSettings(), maxRetries: 8 });
    reads[0](old);
    await confirm;
    assert.equal(setup(local).store.restore().maxRetries, 8);
    assert.equal(reads.length, 2);
    const latest = store.confirm();
    reads[1](next);
    await latest;
    assert.equal(local.size, 0);
    assert.equal(h.statuses.at(-1).phase, 'saved');
});

test('overlapping save confirmations reread even when no newer edit changed the revision', async () => {
    const local = new Map(), h = setup(local), reads = [];
    const store = createSettingsStore({ ...h.options, readSaved: () => new Promise(done => reads.push(done)) });
    const next = store.update({ ...normalizeSettings(), maxRetries: 7 });
    const first = store.confirm();
    void store.confirm();
    reads[0](normalizeSettings());
    await first;
    assert.equal(reads.length, 2);
    const latest = store.confirm();
    reads[1](next);
    await latest;
    assert.equal(local.size, 0);
    assert.equal(h.statuses.at(-1).phase, 'saved');
});
