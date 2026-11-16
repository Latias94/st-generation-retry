export const DEFAULT_SETTINGS = Object.freeze({
    enabled: true,
    maxRetries: 3,
    delaySeconds: 2,
    exponentialBackoff: true,
    maxDelaySeconds: 30,
    retryEmpty: true,
    notifySuccess: true,
    notifyFailure: true,
    backgroundOnly: false,
});

export function normalizeSettings(value = {}) {
    if (!value || typeof value !== 'object') value = {};
    const result = { ...DEFAULT_SETTINGS };
    for (const key of Object.keys(result)) {
        if (typeof result[key] === 'boolean' && typeof value[key] === 'boolean') result[key] = value[key];
    }
    for (const [key, min, max] of [['maxRetries', 0, 10], ['delaySeconds', 1, 300], ['maxDelaySeconds', 1, 900]]) {
        const number = Number(value[key] ?? result[key]);
        if (Number.isFinite(number)) result[key] = Math.min(max, Math.max(min, Math.round(number)));
    }
    result.maxDelaySeconds = Math.max(result.delaySeconds, result.maxDelaySeconds);
    return result;
}

export class GenerationFailure extends Error {
    constructor(code, { status = 0, retryable = false, partial = false } = {}) {
        super(`Generation Retry: ${code}${status ? ` (HTTP ${status})` : ''}`);
        this.name = 'GenerationFailure';
        this.code = code;
        this.status = status;
        this.retryable = retryable;
        this.partial = partial;
    }
}

// Only inspect known error fields. Never retain or display the upstream body, which may contain prompts.
export function responseFailure(data, status = 200) {
    const error = data?.error ?? data?.detail?.error;
    if (status < 400 && !error && !data?.quota_error && !data?.promptFeedback?.blockReason) return null;
    const fields = [error, error?.message, error?.code, error?.type, data?.message, data?.detail,
        data?.promptFeedback?.blockReason].filter(x => typeof x === 'string').join(' ');
    const embeddedStatus = Number(error?.status ?? error?.status_code ?? data?.status);
    const actualStatus = embeddedStatus >= 400 && embeddedStatus <= 599 ? embeddedStatus : status;
    const permanent = data?.quota_error || /insufficient.*quota|quota[_ -]?(exceeded|exhausted)|exceeded your current quota|余额不足|额度不足|credit|billing|payment|balance|unauthori[sz]ed|forbidden|invalid[_ -]?(api[_ -]?)?key|authentication|permission|context[_ -]?(length|window)|too many tokens|max(imum)?[_ ]context|token limit|prompt.*too (long|large)|bad request|invalid[_ ](request|argument)|not found|model.*(not exist|not available|not supported)|moderation|content[_ -]?(filter|policy)|safety|blocked/i.test(fields);
    const temporary = /rate[_ -]?limit|too many requests|overload|temporar|timeout|timed out|unavailable|internal server error|bad gateway|gateway timeout|ECONN|ETIMEDOUT|fetch failed/i.test(fields);
    const retryableStatus = [408, 425, 429].includes(actualStatus) || actualStatus >= 500;
    const retryable = !permanent && (retryableStatus || (actualStatus < 400 && (temporary || error === true)));
    return new GenerationFailure(permanent ? 'request-rejected' : 'upstream-error', { status: actualStatus, retryable });
}

export function networkFailure(error) {
    if (error instanceof GenerationFailure) return error;
    if (error?.name === 'AbortError') return error;
    return new GenerationFailure('network-error', { retryable: error instanceof TypeError || /network|fetch|terminated|reset/i.test(error?.message ?? '') });
}

export function retryDelay(settings, retry, retryAfter, now = Date.now()) {
    const cap = settings.maxDelaySeconds * 1000;
    const backoff = settings.delaySeconds * 1000 * (settings.exponentialBackoff ? 2 ** (retry - 1) : 1);
    let requested = 0;
    if (retryAfter) {
        requested = /^\d+(\.\d+)?$/.test(retryAfter.trim()) ? Number(retryAfter) * 1000 : Date.parse(retryAfter) - now;
    }
    return Math.min(cap, Math.max(backoff, Number.isFinite(requested) ? requested : 0));
}

export function abortError() {
    return new DOMException('Generation cancelled', 'AbortError');
}

export function waitForRetry(milliseconds, signal) {
    return new Promise((resolve, reject) => {
        const finish = error => {
            clearTimeout(timer);
            signal.removeEventListener('abort', onAbort);
            error ? reject(error) : resolve();
        };
        const onAbort = () => finish(abortError());
        const timer = setTimeout(() => finish(), milliseconds);
        signal.addEventListener('abort', onAbort, { once: true });
        if (signal.aborted) onAbort();
    });
}
