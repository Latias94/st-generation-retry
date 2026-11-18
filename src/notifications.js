export const FAILURE_LABELS = {
    'request-rejected': '请求被拒绝，请检查连接、额度或请求参数',
    'upstream-error': '上游服务返回错误',
    'network-error': '网络连接失败',
    'empty-response': '上游返回空回复',
    'incomplete-stream': '流式回复中断，未收到完成标记',
    'invalid-stream': '上游返回了无效的流式数据',
    'invalid-response': '上游返回了无效的响应',
    'expected-stream': '上游未返回请求的流式响应',
    'tool-error': '工具执行失败，请检查酒馆的工具错误提示',
};

export function failureLabel(failure) {
    return `${FAILURE_LABELS[failure?.code] ?? '生成失败'}${failure?.status >= 400 ? `（HTTP ${failure.status}）` : ''}${failure?.partial ? '；已保留部分回复，请手动决定是否重生成' : ''}。`;
}

const TRAY_ENDPOINT = '/api/plugins/st-generation-notifier/notify';
const TRAY_STATUS = {
    204: 'tray-sent',
    202: 'tray-paused',
    403: 'tray-forbidden',
    404: 'tray-relay-missing',
    409: 'tray-windows-disabled',
    502: 'tray-windows-error',
    503: 'tray-offline',
};

export const TRAY_MESSAGES = {
    'tray-sending': '正在将通知交给 Windows 托盘应用…',
    'tray-sent': 'Windows 已接收通知。若未看到横幅，请按 Win+N 查看通知中心，并检查勿扰模式和 SillyTavern Notifier 的通知开关。',
    'tray-paused': 'Windows 托盘应用已暂停结果通知。',
    'tray-forbidden': '请在这台电脑上用 localhost 或 127.0.0.1 打开酒馆。若地址正确，请刷新酒馆后重试。',
    'tray-relay-missing': '酒馆未加载通知中继。请安装服务端插件并重启酒馆。',
    'tray-windows-disabled': 'Windows 未允许发送通知。请检查 Windows → 设置 → 系统 → 通知中的总开关和 SillyTavern Notifier 的开关。',
    'tray-windows-error': 'Windows 托盘应用未能提交通知。请打开托盘应用查看状态。',
    'tray-offline': 'Windows 托盘应用未连接。请启动 SillyTavern Notifier，再测试通知。',
    'tray-error': '向 Windows 托盘应用发送通知失败。请检查酒馆连接后重试。',
};

export function createNotifier({ environment = globalThis, onStatus = () => {}, receiptTimeout = 5000,
    fetcher = (...args) => globalThis.fetch(...args), getRequestHeaders = () => ({}),
    toast = (kind, message) => globalThis.toastr?.[kind]?.(message, '自动重试与通知') } = {}) {
    const active = new Set();
    const permission = () => {
        if (!environment.Notification) return 'unsupported';
        if (!environment.isSecureContext) return 'insecure';
        return environment.Notification.permission;
    };
    const details = () => ({ permission: permission(), origin: environment.location?.origin ?? '' });
    const report = phase => onStatus(phase.startsWith('tray-') ? { phase } : { phase, ...details() });
    const send = (title, body, tag, test = false) => {
        report('sending');
        return new Promise(resolve => {
            let notification, settled = false;
            const finish = phase => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                if (phase !== 'shown') active.delete(notification);
                report(phase);
                resolve(phase === 'shown');
            };
            const timer = setTimeout(() => finish('unconfirmed'), receiptTimeout);
            try {
                notification = new environment.Notification(title, { body, tag, requireInteraction: test });
                // Hold live objects until close, so garbage collection cannot discard their event handlers.
                if (active.size >= 8) active.delete(active.values().next().value);
                active.add(notification);
                notification.onshow = () => finish('shown');
                notification.onerror = () => finish('error');
                notification.onclose = () => { active.delete(notification); finish('unconfirmed'); };
                notification.onclick = () => { environment.focus?.(); notification.close(); };
            } catch { finish('error'); }
        });
    };
    const sendToTray = async result => {
        report('tray-sending');
        let phase;
        try {
            const event = { id: globalThis.crypto.randomUUID(), outcome: result.outcome, retries: result.retries ?? 0 };
            if (result.outcome === 'failure') {
                if (Object.hasOwn(FAILURE_LABELS, result.failure?.code)) event.code = result.failure.code;
                const status = result.failure?.status;
                if (Number.isInteger(status) && status >= 400 && status <= 599) event.status = status;
                event.partial = Boolean(result.failure?.partial);
            }
            const response = await fetcher(TRAY_ENDPOINT, {
                method: 'POST',
                headers: { ...getRequestHeaders(), 'Content-Type': 'application/json' },
                body: JSON.stringify(event),
                redirect: 'error',
                signal: AbortSignal.timeout(4000),
            });
            phase = TRAY_STATUS[response.status] ?? 'tray-error';
        } catch {
            phase = 'tray-error';
        }
        report(phase);
        return phase;
    };
    return {
        permission,
        details,
        async requestPermission() {
            if (permission() !== 'default') { report('permission'); return permission(); }
            try { await environment.Notification.requestPermission(); }
            catch { toast('warning', '通知权限申请未完成，请检查浏览器的站点设置。'); }
            report('permission');
            return permission();
        },
        async test(settings = {}) {
            if (settings.notificationChannel === 'tray') {
                const phase = await sendToTray({ outcome: 'test' });
                const sent = phase === 'tray-sent';
                toast(sent ? 'info' : 'warning', TRAY_MESSAGES[phase]);
                return sent;
            }
            if (permission() !== 'granted') {
                report('permission');
                toast('warning', `当前站点 ${details().origin} 尚未获得桌面通知权限。请查看下方权限说明。`);
                return false;
            }
            const shown = await send('SillyTavern · 通知测试', '这是一条桌面通知测试，不包含聊天正文。', `st-generation-retry-test-${Date.now()}`, true);
            toast(shown ? 'info' : 'warning', shown
                ? '浏览器已确认发出通知。如未看到横幅，请按 Win+N 查看通知中心，并检查 Windows 的勿扰模式和浏览器通知开关。'
                : '未收到桌面通知的显示回执。请检查当前站点权限、Windows 通知开关，以及浏览器是否被系统允许发送通知。');
            return shown;
        },
        async publish(result, settings) {
            if (!settings.notificationsEnabled) return;
            if (result.outcome === 'success' ? !settings.notifySuccess : !settings.notifyFailure) return;
            if (settings.backgroundOnly && environment.document?.visibilityState !== 'hidden' && environment.document?.hasFocus()) return;
            const success = result.outcome === 'success';
            const title = success ? 'SillyTavern · 生成完成' : 'SillyTavern · 生成最终失败';
            const body = `${success ? '回复生成完成。' : failureLabel(result.failure)}${result.retries ? `本次共重试 ${result.retries} 次。` : ''}`;
            // Failure feedback must remain visible even when desktop delivery succeeds or stalls.
            if (!success) toast('error', `${body}详情见「自动重试与通知 → 最近一次失败详情」。`);
            if (settings.notificationChannel === 'tray') {
                const phase = await sendToTray(result);
                if (phase === 'tray-sent' || phase === 'tray-paused') return;
            } else if (permission() === 'granted' && await send(title, body, `st-generation-retry-${result.id}`)) {
                return;
            }
            if (success) toast('success', body);
        },
    };
}
