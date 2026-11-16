import { createRetryController } from './src/controller.js';
import { createNotifier } from './src/notifications.js';
import { createSettingsPanel } from './src/ui.js';
import { createSettingsStore } from './src/settings.js';
import { isGenerating } from '/script.js';
import { getCurrentUserHandle } from '/scripts/user.js';

const INSTANCE = Symbol.for('st-generation-retry.instance');

function initialize() {
    if (globalThis[INSTANCE] || !globalThis.SillyTavern?.getContext) return;
    const getContext = () => globalThis.SillyTavern.getContext();
    let view, saveStatus;
    const store = createSettingsStore({
        getContext, userId: getCurrentUserHandle(),
        storage: {
            getItem: key => globalThis.sessionStorage.getItem(key),
            setItem: (key, value) => globalThis.sessionStorage.setItem(key, value),
            removeItem: key => globalThis.sessionStorage.removeItem(key),
        },
        async readSaved() {
            const response = await fetch('/api/settings/get', {
                method: 'POST', headers: getContext().getRequestHeaders(), body: '{}', cache: 'no-cache',
            });
            if (!response.ok) throw new Error('Settings readback failed');
            const data = await response.json();
            return JSON.parse(data.settings).extension_settings?.generation_retry;
        },
        onStatus(status) { saveStatus = status; view?.settingsStatus(status); },
    });
    const getSettings = store.read;
    store.restore();
    const notifier = createNotifier({ onStatus: status => view?.notificationStatus(status) });
    const controller = createRetryController({
        getContext, getSettings,
        isHostBusy: () => isGenerating() || Boolean(getContext().streamingProcessor && !getContext().streamingProcessor.isStopped),
        onStatus: status => view?.status(status),
        onOutcome: (result, settings) => notifier.publish(result, settings),
    });
    const subscriptions = [];
    const { eventSource, eventTypes } = getContext();
    const on = (type, callback) => {
        if (!type) return;
        eventSource.on(type, callback);
        subscriptions.push([type, callback]);
    };
    on(eventTypes.GENERATION_AFTER_COMMANDS, (...args) => controller.start(...args));
    on(eventTypes.SETTINGS_UPDATED, () => { void store.confirm(); });
    on(eventTypes.GENERATION_ENDED, () => controller.end());
    on(eventTypes.CHAT_COMPLETION_SETTINGS_READY, data => controller.requestReady(data));
    on(eventTypes.CHARACTER_MESSAGE_RENDERED, () => controller.rendered());
    on(eventTypes.IMPERSONATE_READY, () => controller.rendered());
    on(eventTypes.GROUP_WRAPPER_STARTED, options => controller.groupStart(options));
    on(eventTypes.GROUP_WRAPPER_FINISHED, options => controller.groupEnd(options));
    for (const name of ['GENERATION_STOPPED', 'CHAT_CHANGED', 'MAIN_API_CHANGED', 'CHATCOMPLETION_SOURCE_CHANGED',
        'CHATCOMPLETION_MODEL_CHANGED', 'CONNECTION_PROFILE_LOADED', 'OAI_PRESET_CHANGED_BEFORE']) {
        on(eventTypes[name], () => controller.cancel(name));
    }
    const previousFetch = globalThis.fetch;
    const fetcher = (...args) => previousFetch.apply(globalThis, args);
    const wrappedFetch = (input, init) => controller.fetch(fetcher, input, init);
    globalThis.fetch = wrappedFetch;
    const manager = getContext().ToolManager;
    const previousInvokeTools = manager?.invokeFunctionTools;
    const wrappedInvokeTools = async function (...args) {
        const token = controller.toolsStarted();
        try {
            const result = await previousInvokeTools.apply(this, args);
            controller.toolsFinished(token, Boolean(result?.errors?.length));
            return result;
        } catch (error) {
            controller.toolsFinished(token, true);
            throw error;
        }
    };
    if (previousInvokeTools) manager.invokeFunctionTools = wrappedInvokeTools;
    const installPanel = () => {
        if (document.getElementById('generation-retry-settings')) return;
        const parent = document.getElementById('extensions_settings2') ?? document.getElementById('extensions_settings');
        if (!parent) return;
        view = createSettingsPanel({
            settings: getSettings(), notifier,
            onChange(value) {
                const next = store.update(value), context = getContext();
                if (!next.retryEnabled && !next.notificationsEnabled && controller.cancel('disabled')) context.stopGeneration();
                return next;
            },
            onCancel() { getContext().stopGeneration(); controller.cancel(); },
        });
        if (saveStatus) view.settingsStatus(saveStatus);
        parent.append(view.element);
    };
    on(eventTypes.APP_READY, installPanel);
    const onFocus = () => view?.refreshPermission();
    globalThis.addEventListener('focus', onFocus);
    installPanel();
    globalThis[INSTANCE] = {
        dispose() {
            controller.cancel('unloaded');
            for (const [type, callback] of subscriptions) eventSource.removeListener(type, callback);
            if (globalThis.fetch === wrappedFetch) globalThis.fetch = previousFetch;
            if (manager?.invokeFunctionTools === wrappedInvokeTools) manager.invokeFunctionTools = previousInvokeTools;
            globalThis.removeEventListener('focus', onFocus);
            view?.element.remove();
            delete globalThis[INSTANCE];
        },
    };
}

initialize();
