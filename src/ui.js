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
            <small class="gr-save-status" role="status" aria-live="polite">设置从酒馆账户加载；修改后会自动保存。</small>
            <div class="gr-actions">
                <button type="button" class="menu_button" data-action="permission">授权桌面通知</button>
                <button type="button" class="menu_button" data-action="test">测试通知</button>
                <button type="button" class="menu_button" data-action="cancel" disabled>停止本次生成 / 重试</button>
            </div>
            <small class="gr-permission"></small>
            <div class="gr-notification-status" role="status" aria-live="polite">点击“测试通知”后，这里会显示浏览器的发送结果。</div>
            <div class="gr-status" role="status" aria-live="polite">等待下一次生成。</div>
        </div>`;
    const inputs = [...element.querySelectorAll('[data-setting]')];
    const apply = value => inputs.forEach(input => {
        input.type === 'checkbox' ? input.checked = value[input.dataset.setting] : input.value = value[input.dataset.setting];
    });
    apply(settings);
    const update = event => {
        if (!event.target.matches('[data-setting]')) return;
        if (event.type === 'input' && (event.target.type !== 'number' || event.target.value === '')) return;
        const next = Object.fromEntries(inputs.map(input => [input.dataset.setting, input.type === 'checkbox' ? input.checked : input.value]));
        const value = onChange(next);
        // Keep an in-progress numeric edit intact, but save valid input before it loses focus.
        if (event.type === 'change') apply(value);
    };
    element.addEventListener('change', update);
    element.addEventListener('input', update);
    const permissionStatus = () => {
        const state = notifier.permission();
        const labels = {
            granted: '浏览器权限：已允许。请用“测试通知”检查系统投递；允许权限不代表 Windows 一定显示横幅。',
            default: '尚未授权桌面通知。点击“授权桌面通知”，并在浏览器中允许。未授权时使用酒馆内提示。',
            denied: '桌面通知被浏览器阻止。请在地址栏的站点权限中允许通知；当前使用酒馆内提示。',
            unsupported: '此浏览器不支持桌面通知；当前使用酒馆内提示。',
            insecure: '桌面通知需要 HTTPS 或 localhost。使用非安全局域网地址时仅显示酒馆内提示。',
        };
        const origin = notifier.details().origin;
        element.querySelector('.gr-permission').textContent = `${origin ? `当前站点：${origin}。` : ''}${labels[state]} 权限由浏览器保存；localhost 与 127.0.0.1、不同浏览器或配置文件各自独立。`;
        const button = element.querySelector('[data-action="permission"]');
        button.disabled = state !== 'default';
        button.textContent = state === 'granted' ? '浏览器已授权' : '授权桌面通知';
    };
    element.querySelector('[data-action="permission"]').addEventListener('click', async () => {
        await notifier.requestPermission();
        permissionStatus();
    });
    element.querySelector('[data-action="test"]').addEventListener('click', async event => {
        const button = event.currentTarget;
        button.disabled = true;
        button.textContent = '正在测试…';
        try { await notifier.test(); }
        finally { button.disabled = false; button.textContent = '测试通知'; permissionStatus(); }
    });
    element.querySelector('[data-action="cancel"]').addEventListener('click', onCancel);
    permissionStatus();
    return {
        element,
        refreshPermission: permissionStatus,
        settingsStatus({ phase, local }) {
            const labels = {
                pending: local ? '设置已保存在此浏览器，正在同步到酒馆；现在刷新也可恢复。' : '浏览器本地存储不可用，正在保存到酒馆；请等同步成功后再刷新。',
                saved: '设置已保存，并从酒馆服务器读回确认。',
                unsynced: local ? '设置已保存在此浏览器，但酒馆服务器尚未确认同步。刷新会恢复并重试同步。' : '设置尚未确认保存，本地存储也不可用。请检查服务器连接，暂勿刷新。',
            };
            element.querySelector('.gr-save-status').textContent = labels[phase];
        },
        notificationStatus({ phase }) {
            const labels = {
                sending: '正在发送桌面通知，等待浏览器显示回执…',
                shown: '浏览器已确认发出通知。若未看到横幅，请按 Win+N 查看通知中心，并检查 Windows 的勿扰模式和浏览器通知开关。',
                error: '浏览器报告通知发送失败。请检查当前站点权限，以及 Windows → 设置 → 系统 → 通知中此浏览器的开关。',
                unconfirmed: '尚未收到浏览器的显示回执。如无通知，请检查 Windows 通知开关和勿扰模式；生成结果会回退为酒馆内提示。',
            };
            if (labels[phase]) element.querySelector('.gr-notification-status').textContent = labels[phase];
            permissionStatus();
        },
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
