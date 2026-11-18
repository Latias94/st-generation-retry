import { GenerationFailure, normalizeSettings } from './policy.js';
import { requestWithRetry } from './transport.js';

const GENERATION_PATH = '/api/backends/chat-completions/generate';
const TYPES = new Set(['normal', 'regenerate', 'swipe', 'continue', 'impersonate']);

function contextKey(context) {
    const settings = context.chatCompletionSettings ?? {};
    return JSON.stringify([context.chatId, context.groupId || context.characterId, context.mainApi,
        settings.chat_completion_source, context.getChatCompletionModel?.(), settings.custom_url, settings.reverse_proxy]);
}

export function createRetryController({ getContext, getSettings, onStatus = () => {}, onOutcome = () => {},
    isHostBusy = () => false, request = requestWithRetry, schedule = setTimeout, unschedule = clearTimeout,
    logger = globalThis.console }) {
    let active, wrapper, serial = 0, timer;
    const enabled = () => getSettings().retryEnabled || getSettings().notificationsEnabled;
    const clearTimer = () => { unschedule(timer); timer = undefined; };
    const current = run => active === run && !run.abort.signal.aborted && run.key === contextKey(getContext());
    const finish = run => {
        if (!current(run) || run.inFlight || run.toolsPending || run.group || !run.ended || isHostBusy()) return;
        if (!run.requests) { active = null; return; }
        const failure = run.failure ?? run.toolFailure ?? (run.toolCalls && !run.toolsCompleted ? new GenerationFailure('tool-error') : null);
        const outcome = failure ? 'failure' : run.success ? 'success' : null;
        if (!outcome) return;
        if (outcome === 'success' && !run.rendered && !(run.toolCalls && run.toolsCompleted)) return;
        active = null;
        clearTimer();
        if (failure) {
            // Log only our diagnostic fields, never the upstream body, request, or error object.
            logger?.error?.('[Generation Retry] Generation failed.', { generation: run.id, code: failure.code,
                status: failure.status, partial: failure.partial, retries: run.retries });
        }
        onStatus({ phase: outcome, retries: run.retries, failure });
        onOutcome({ outcome, retries: run.retries, failure, id: run.id }, getSettings());
    };
    const queueFinish = run => {
        clearTimer();
        // An ended event unlocks the UI before streaming saves and auto-continue finish.
        // Poll the actual host state; elapsed time alone never proves completion.
        timer = schedule(() => {
            if (current(run) && run.ended && !run.group && (isHostBusy() || run.toolsPending)) queueFinish(run);
            else finish(run);
        }, 50);
    };
    const cancel = (reason = 'cancelled') => {
        clearTimer();
        const hadWrapper = Boolean(wrapper);
        wrapper = null;
        if (!active) return hadWrapper;
        const run = active;
        active = null;
        run.abort.abort();
        onStatus({ phase: 'cancelled', reason });
        return true;
    };

    return {
        cancel,
        start(type = 'normal', options = {}, dryRun = false) {
            if (dryRun || !TYPES.has(type) || !enabled()) return;
            const context = getContext();
            if (context.mainApi !== 'openai') { onStatus({ phase: 'unsupported' }); return; }
            if (active && (!current(active) || active.inFlight)) cancel('superseded');
            if (active?.ended && !active.group && !(type === 'continue' && active.success && !active.failure)) {
                finish(active);
                if (active) cancel('superseded');
            }
            clearTimer();
            active ??= { id: ++serial, key: contextKey(context), abort: new AbortController(),
                requests: 0, inFlight: false, retries: 0, success: false, failure: null,
                group: wrapper?.key === contextKey(context) };
            active.armed = true;
            active.readyData = null;
            active.ended = false;
            onStatus({ phase: 'preparing', retries: active.retries });
        },
        end() {
            if (!active) return;
            active.ended = true;
            queueFinish(active);
        },
        rendered() {
            if (!active) return;
            active.rendered = true;
            if (active.ended) queueFinish(active);
        },
        requestReady(data) {
            if (active?.armed && TYPES.has(data?.type) && current(active)) {
                active.readyData = { type: data.type, model: data.model, source: data.chat_completion_source, stream: data.stream };
            }
        },
        groupStart({ type, selected_group } = {}) {
            if (type === 'quiet' || !enabled() || getContext().mainApi !== 'openai') return;
            wrapper = { id: selected_group ?? getContext().groupId, key: contextKey(getContext()) };
            if (active && current(active)) active.group = true;
        },
        groupEnd({ selected_group } = {}) {
            if (!wrapper || (selected_group != null && wrapper.id !== selected_group)) return;
            wrapper = null;
            if (!active?.group) return;
            active.group = false;
            active.ended = true;
            queueFinish(active);
        },
        toolsStarted() {
            if (!active || !current(active) || !active.toolCalls || active.inFlight) return null;
            active.toolsPending = true;
            return { run: active, request: active.requests };
        },
        toolsFinished(token, errors = []) {
            if (!token || !current(token.run) || token.request !== token.run.requests) return;
            token.run.toolsPending = false;
            token.run.toolsCompleted = true;
            token.run.toolFailure = errors?.length ? new GenerationFailure('tool-error', {
                detail: { message: errors.map(error => String(error)).join('\n') },
            }) : null;
            if (token.run.ended) queueFinish(token.run);
        },
        async fetch(fetcher, input, init) {
            const run = active;
            if (!run?.armed || !enabled() || !current(run) || typeof init?.body !== 'string'
                || (init.method ?? 'GET').toUpperCase() !== 'POST') return fetcher(input, init);
            let url;
            try { url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url, globalThis.location?.href ?? 'http://localhost'); }
            catch { return fetcher(input, init); }
            // Match the native endpoint exactly; external requests, quiet generations, and other APIs pass through.
            if (url.pathname !== GENERATION_PATH || (globalThis.location && url.origin !== globalThis.location.origin)) return fetcher(input, init);
            // Native requests announce their type and connection immediately before fetch.
            // Other extensions may transform serialized messages/tools after that event.
            const data = run.readyData;
            let body;
            try { body = JSON.parse(init.body); } catch { return fetcher(input, init); }
            const streamSignal = getContext().streamingProcessor?.abortController?.signal;
            if (!data || !TYPES.has(body?.type) || data.type !== body.type || data.model !== body.model
                || data.source !== body.chat_completion_source || data.stream !== body.stream
                || (body.stream && (!streamSignal || streamSignal !== init.signal)) || run.inFlight) return fetcher(input, init);
            const payload = { stream: body.stream, n: body.n };
            run.readyData = null;
            run.armed = false;
            run.inFlight = true;
            run.rendered = false;
            run.toolCalls = false;
            run.toolsPending = run.toolsCompleted = false;
            run.toolFailure = null;
            run.ended = false;
            run.requests++;
            onStatus({ phase: 'generating', retries: run.retries });
            return request(fetcher, input, init, payload, {
                settings: normalizeSettings(getSettings()),
                signal: run.abort.signal,
                isCurrent: () => current(run),
                onAttempt() {
                    if (current(run)) onStatus({ phase: 'generating', retries: run.retries });
                },
                onRetry(detail) {
                    if (!current(run)) return;
                    run.retries++;
                    onStatus({ phase: 'waiting', retries: run.retries, ...detail });
                },
                onResult(outcome, detail) {
                    if (!current(run)) {
                        if (active === run) cancel('context-changed');
                        return;
                    }
                    run.inFlight = false;
                    if (outcome === 'cancelled') { cancel(); return; }
                    if (outcome === 'failure') run.failure ??= detail;
                    if (outcome === 'success') {
                        run.success = true;
                        run.toolCalls = Boolean(detail?.toolCalls);
                    }
                    onStatus({ phase: 'finishing', retries: run.retries });
                    if (run.ended) queueFinish(run);
                },
            });
        },
    };
}
