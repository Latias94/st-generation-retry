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

export function createNotifier({ environment = globalThis, toast = (kind, message) => globalThis.toastr?.[kind]?.(message, '自动重试与通知') } = {}) {
    const permission = () => {
        if (!environment.Notification) return 'unsupported';
        if (!environment.isSecureContext) return 'insecure';
        return environment.Notification.permission;
    };
    const send = (title, body, tag) => {
        try {
            const notification = new environment.Notification(title, { body, tag });
            notification.onclick = () => { environment.focus?.(); notification.close(); };
            return true;
        } catch { return false; }
    };
    return {
        permission,
        async requestPermission() {
            if (permission() !== 'default') return permission();
            try { await environment.Notification.requestPermission(); }
            catch { toast('warning', '通知权限申请未完成，请检查浏览器的站点设置。'); }
            return permission();
        },
        test() {
            if (permission() === 'granted' && send('SillyTavern · 通知测试', '桌面通知已启用。通知不会包含聊天正文。', 'st-generation-retry-test')) return true;
            toast('info', '桌面通知尚不可用。请先授权，并检查浏览器和系统通知设置。');
            return false;
        },
        publish(result, settings) {
            if (result.outcome === 'success' ? !settings.notifySuccess : !settings.notifyFailure) return;
            if (settings.backgroundOnly && environment.document?.visibilityState !== 'hidden' && environment.document?.hasFocus()) return;
            const success = result.outcome === 'success';
            const title = success ? 'SillyTavern · 生成完成' : 'SillyTavern · 生成最终失败';
            const body = `${success ? '回复生成完成。' : failureLabel(result.failure)}${result.retries ? `本次共重试 ${result.retries} 次。` : ''}`;
            if (permission() === 'granted' && send(title, body, `st-generation-retry-${result.id}`)) return;
            toast(success ? 'success' : 'error', body);
        },
    };
}
