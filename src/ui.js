import { failureLabel } from './notifications.js';

export function createSettingsPanel({ settings, onChange, notifier, onCancel }) {
    const element = document.createElement('div');
    element.id = 'generation-retry-settings';
    element.className = 'inline-drawer';
    element.innerHTML = `
        <div class="inline-drawer-toggle inline-drawer-header">
            <b><i class="fa-solid fa-rotate-right"></i> 自动重试与通知</b>
            <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
        </div>
        <div class="inline-drawer-content">
            <label class="checkbox_label"><input type="checkbox" data-setting="enabled"><span>启用自动重试与通知</span></label>
            <small>支持聊天补全（Chat Completion）的普通回复、重新生成、滑动、继续、代写与群聊。后台 quiet 请求不参与。</small>
            <div class="gr-grid">
                <label>最多重试次数<input class="text_pole" type="number" min="0" max="10" step="1" data-setting="maxRetries"></label>
                <label>首次等待（秒）<input class="text_pole" type="number" min="1" max="300" step="1" data-setting="delaySeconds"></label>
                <label>最长等待（秒）<input class="text_pole" type="number" min="1" max="900" step="1" data-setting="maxDelaySeconds"></label>
            </div>
            <small>重试次数不含第一次请求；设为 0 可仅保留通知。收到 Retry-After 时按提示等待，最长不超过上限。</small>
            <label class="checkbox_label"><input type="checkbox" data-setting="exponentialBackoff"><span>每次重试将等待时间翻倍</span></label>
            <label class="checkbox_label"><input type="checkbox" data-setting="retryEmpty"><span>自动重试没有正文、推理或工具调用的空回复</span></label>
            <small>只重试暂时故障；已输出内容后的断流会保留现有内容并通知失败。手动停止、切换聊天或连接会取消等待。</small>
            <hr>
            <label class="checkbox_label"><input type="checkbox" data-setting="notifySuccess"><span>生成成功时发送桌面通知</span></label>
            <label class="checkbox_label"><input type="checkbox" data-setting="notifyFailure"><span>最终失败时发送桌面通知</span></label>
            <label class="checkbox_label"><input type="checkbox" data-setting="backgroundOnly"><span>仅在酒馆页面不在前台时通知</span></label>
            <div class="gr-actions">
                <button type="button" class="menu_button" data-action="permission">授权桌面通知</button>
                <button type="button" class="menu_button" data-action="test">测试通知</button>
                <button type="button" class="menu_button" data-action="cancel" disabled>停止本次生成 / 重试</button>
            </div>
            <small class="gr-permission"></small>
            <div class="gr-status" role="status" aria-live="polite">等待下一次生成。</div>
        </div>`;
    const inputs = [...element.querySelectorAll('[data-setting]')];
    const apply = value => inputs.forEach(input => {
        input.type === 'checkbox' ? input.checked = value[input.dataset.setting] : input.value = value[input.dataset.setting];
    });
    apply(settings);
    element.addEventListener('change', event => {
        if (!event.target.matches('[data-setting]')) return;
        const next = Object.fromEntries(inputs.map(input => [input.dataset.setting, input.type === 'checkbox' ? input.checked : input.value]));
        apply(onChange(next));
    });
    const permissionStatus = () => {
        const state = notifier.permission();
        const labels = {
            granted: '桌面通知已授权；请用“测试通知”确认浏览器及 Windows 通知设置。通知不包含聊天正文。',
            default: '尚未授权桌面通知。点击“授权桌面通知”，并在浏览器中允许。未授权时使用酒馆内提示。',
            denied: '桌面通知被浏览器阻止。请在地址栏的站点权限中允许通知；当前使用酒馆内提示。',
            unsupported: '此浏览器不支持桌面通知；当前使用酒馆内提示。',
            insecure: '桌面通知需要 HTTPS 或 localhost。使用非安全局域网地址时仅显示酒馆内提示。',
        };
        element.querySelector('.gr-permission').textContent = labels[state];
        element.querySelector('[data-action="permission"]').disabled = state !== 'default';
    };
    element.querySelector('[data-action="permission"]').addEventListener('click', async () => {
        await notifier.requestPermission();
        permissionStatus();
    });
    element.querySelector('[data-action="test"]').addEventListener('click', () => { notifier.test(); permissionStatus(); });
    element.querySelector('[data-action="cancel"]').addEventListener('click', onCancel);
    permissionStatus();
    return {
        element,
        refreshPermission: permissionStatus,
        status(value) {
            const labels = {
                preparing: '正在准备生成…',
                generating: '正在请求上游…',
                waiting: `上游暂时失败，将在 ${Math.ceil((value.milliseconds ?? 0) / 1000)} 秒后重试（本次第 ${value.retries} 次）。可点击停止取消。`,
                finishing: '请求已结束，等待酒馆完成本次生成…',
                success: `生成完成${value.retries ? `，共重试 ${value.retries} 次` : ''}。`,
                failure: `生成最终失败：${failureLabel(value.failure)}`,
                cancelled: '已取消本次生成 / 重试，不发送结果通知。',
                unsupported: '当前使用文本补全等其他 API；此扩展只处理聊天补全（Chat Completion）。',
            };
            element.querySelector('.gr-status').textContent = labels[value.phase] ?? '等待下一次生成。';
            element.querySelector('[data-action="cancel"]').disabled = !['preparing', 'generating', 'waiting', 'finishing'].includes(value.phase);
            element.querySelector('.gr-status').classList.toggle('gr-error', value.phase === 'failure');
        },
    };
}
