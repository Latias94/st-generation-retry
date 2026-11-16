import { DEFAULT_SETTINGS, normalizeSettings } from './policy.js';

/** Keep unsynchronized edits in tab storage, scoped to the current SillyTavern account. */
export function createSettingsStore({ getContext, storage, userId, readSaved, onStatus = () => {} }) {
    const key = `st-generation-retry:pending:${encodeURIComponent(userId)}`;
    let pending = {}, revision = 0, checking, confirmRequested = false;
    const read = () => normalizeSettings(getContext().extensionSettings.generation_retry);
    const persist = () => {
        try {
            Object.keys(pending).length ? storage.setItem(key, JSON.stringify(pending)) : storage.removeItem(key);
            return true;
        } catch { return false; }
    };
    const apply = () => {
        const value = normalizeSettings({ ...read(), ...pending });
        getContext().extensionSettings.generation_retry = value;
        return value;
    };
    const status = local => onStatus({ phase: Object.keys(pending).length ? 'pending' : 'saved', local });
    const confirm = async () => {
        if (checking) { confirmRequested = true; return checking; }
        if (!Object.keys(pending).length) return;
        const version = revision;
        checking = (async () => {
            try {
                const saved = normalizeSettings(await readSaved());
                if (version !== revision) return;
                for (const [name, value] of Object.entries(pending)) {
                    if (saved[name] === value) delete pending[name];
                }
                const local = persist();
                if (Object.keys(pending).length) onStatus({ phase: 'unsynced', local });
                else onStatus({ phase: 'saved', local });
            } catch { onStatus({ phase: 'unsynced', local: persist() }); }
            finally {
                checking = undefined;
                // A native save can finish after an older GET even without another UI edit.
                if (confirmRequested || version !== revision) {
                    confirmRequested = false;
                    void confirm();
                }
            }
        })();
        return checking;
    };
    return {
        read,
        restore() {
            try {
                const value = JSON.parse(storage.getItem(key) ?? '{}');
                if (value && typeof value === 'object' && !Array.isArray(value)) {
                    const normalized = normalizeSettings(value);
                    const names = Object.keys(DEFAULT_SETTINGS).filter(name => Object.hasOwn(value, name));
                    if (typeof value.enabled === 'boolean') names.push('retryEnabled', 'notificationsEnabled');
                    pending = Object.fromEntries(names.map(name => [name, normalized[name]]));
                }
            } catch { /* Invalid or blocked local storage must not prevent native settings loading. */ }
            if (!Object.keys(pending).length) return read();
            const value = apply();
            status(persist());
            getContext().saveSettingsDebounced();
            return value;
        },
        update(value) {
            const before = read(), next = normalizeSettings(value);
            for (const name of Object.keys(DEFAULT_SETTINGS)) {
                if (next[name] !== before[name]) pending[name] = next[name];
            }
            revision++;
            getContext().extensionSettings.generation_retry = next;
            status(persist());
            getContext().saveSettingsDebounced();
            return next;
        },
        confirm,
    };
}
