using System.ComponentModel;
using System.Diagnostics;
using Microsoft.Windows.AppNotifications;
using Microsoft.Windows.AppNotifications.Builder;

namespace SillyTavernNotifier;

internal static class Program
{
    [STAThread]
    private static void Main(string[] args)
    {
        using var instance = new Mutex(true, @"Local\SillyTavern.GenerationNotifier", out var firstInstance);
        if (!firstInstance) return;

        ApplicationConfiguration.Initialize();
        using var tray = new TrayApplication();
        if (args.Contains("--settings")) tray.ShowSettings();
        Application.Run(tray);
    }
}

internal sealed class TrayApplication : ApplicationContext
{
    private const string AppName = "SillyTavern Notifier";
    private const int ReceiptHistorySize = 128;
    private readonly CancellationTokenSource stopping = new();
    private readonly HashSet<Guid> seen = [];
    private readonly Queue<Guid> receiptHistory = new();
    private readonly NotifyIcon trayIcon;
    private readonly ContextMenuStrip menu = new();
    private readonly ToolStripMenuItem pauseItem = new();
    private readonly Form settings;
    private readonly CheckBox pauseBox = new() { AutoSize = true, Text = "暂停生成结果通知" };
    private readonly Label activity = new() { AutoSize = true, MaximumSize = new Size(366, 0) };
    private readonly Task listener;
    private AppNotificationManager? notifications;
    private bool paused;

    public TrayApplication()
    {
        settings = CreateSettings();
        _ = settings.Handle;

        menu.Items.Add("打开设置", null, (_, _) => ShowSettings());
        menu.Items.Add("测试通知", null, (_, _) => TestNotification());
        pauseItem.Click += (_, _) => SetPaused(!paused);
        menu.Items.Add(pauseItem);
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add("退出", null, (_, _) => ExitThread());

        trayIcon = new NotifyIcon { Icon = SystemIcons.Information, ContextMenuStrip = menu, Visible = true };
        trayIcon.DoubleClick += (_, _) => ShowSettings();
        SetPaused(false);

        try
        {
            if (!AppNotificationManager.IsSupported())
            {
                activity.Text = "Windows 当前无法发送应用通知。请以普通用户身份启动。";
            }
            else
            {
                var manager = AppNotificationManager.Default;
                manager.NotificationInvoked += OnNotificationInvoked;
                manager.Register();
                notifications = manager;
                activity.Text = DisabledMessage(manager.Setting) ?? "等待 SillyTavern 发送生成结果。";
            }
        }
        catch (Exception error)
        {
            activity.Text = $"无法注册 Windows 通知（0x{error.HResult:X8}）。请检查 Windows App Runtime 1.8。";
        }

        listener = Task.Run(ListenAsync);
    }

    public void ShowSettings()
    {
        settings.Show();
        settings.WindowState = FormWindowState.Normal;
        settings.Activate();
    }

    private void OnNotificationInvoked(AppNotificationManager sender, AppNotificationActivatedEventArgs args)
    {
        if (!stopping.IsCancellationRequested) settings.BeginInvoke(ShowSettings);
    }

    private Form CreateSettings()
    {
        var window = new Form
        {
            Text = AppName,
            Icon = SystemIcons.Information,
            ClientSize = new Size(416, 236),
            AutoScaleMode = AutoScaleMode.Dpi,
            StartPosition = FormStartPosition.CenterScreen,
            FormBorderStyle = FormBorderStyle.FixedDialog,
            MaximizeBox = false,
            MinimizeBox = false,
        };
        var content = new FlowLayoutPanel
        {
            Dock = DockStyle.Fill,
            FlowDirection = FlowDirection.TopDown,
            WrapContents = false,
            Padding = new Padding(18),
        };
        var heading = new Label { AutoSize = true, Text = "SillyTavern 通知", Font = new Font(window.Font.FontFamily, 15, FontStyle.Bold) };
        activity.Margin = new Padding(3, 8, 3, 12);
        var test = new Button { AutoSize = true, Text = "测试 Windows 通知" };
        test.Click += (_, _) => TestNotification();
        pauseBox.CheckedChanged += (_, _) => SetPaused(pauseBox.Checked);
        var notificationSettings = new LinkLabel { AutoSize = true, Text = "打开 Windows 通知设置" };
        notificationSettings.LinkClicked += (_, _) =>
        {
            try { using var process = Process.Start(new ProcessStartInfo("ms-settings:notifications") { UseShellExecute = true }); }
            catch (Win32Exception) { activity.Text = "请通过 Windows 设置 → 系统 → 通知打开通知选项。"; }
        };

        content.Controls.Add(heading);
        content.Controls.Add(activity);
        content.Controls.Add(pauseBox);
        content.Controls.Add(test);
        content.Controls.Add(notificationSettings);
        window.Controls.Add(content);
        window.FormClosing += (_, args) =>
        {
            if (args.CloseReason != CloseReason.UserClosing) return;
            args.Cancel = true;
            window.Hide();
        };
        return window;
    }

    private void SetPaused(bool value)
    {
        paused = value;
        if (pauseBox.Checked != value) pauseBox.Checked = value;
        pauseItem.Checked = value;
        pauseItem.Text = value ? "恢复结果通知" : "暂停结果通知";
        trayIcon.Text = value ? $"{AppName}（已暂停）" : AppName;
    }

    private void TestNotification()
    {
        Deliver(new GenerationNotice(Guid.NewGuid(), "test"));
        ShowSettings();
    }

    private async Task ListenAsync()
    {
        try
        {
            await NotificationPipe.ListenAsync((notice, token) => settings.InvokeAsync(() =>
            {
                token.ThrowIfCancellationRequested();
                return Deliver(notice);
            }, token), stopping.Token);
        }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException)
        {
            if (!stopping.IsCancellationRequested)
            {
                try
                {
                    await settings.InvokeAsync(() => activity.Text = $"无法连接本机通知管道（0x{error.HResult:X8}）。", stopping.Token);
                }
                catch (OperationCanceledException) when (stopping.IsCancellationRequested) { }
            }
        }
    }

    private Receipt Deliver(GenerationNotice notice)
    {
        if (seen.Contains(notice.Id)) return Receipt.Sent;
        if (paused && notice.Outcome != "test") return Receipt.Paused;
        if (notifications is null) return Receipt.Failed;

        try
        {
            if (DisabledMessage(notifications.Setting) is string disabled)
            {
                activity.Text = disabled;
                return Receipt.Disabled;
            }
            var (title, message) = FormatNotice(notice);
            var notification = new AppNotificationBuilder().AddText(title).AddText(message).BuildNotification();
            notifications.Show(notification);
            if (notification.Id == 0)
            {
                activity.Text = "Windows 未接收通知。请检查系统通知设置。";
                return Receipt.Failed;
            }
            seen.Add(notice.Id);
            receiptHistory.Enqueue(notice.Id);
            if (receiptHistory.Count > ReceiptHistorySize) seen.Remove(receiptHistory.Dequeue());
            activity.Text = $"Windows 已接收通知 · {DateTime.Now:HH:mm:ss}。按 Win+N 可查看通知中心。";
            return Receipt.Sent;
        }
        catch (Exception error)
        {
            activity.Text = $"Windows 通知发送失败（0x{error.HResult:X8}）。";
            return Receipt.Failed;
        }
    }

    private static string? DisabledMessage(AppNotificationSetting setting) => setting switch
    {
        AppNotificationSetting.Enabled => null,
        AppNotificationSetting.DisabledForUser => "Windows 通知总开关已关闭。请前往系统通知设置开启。",
        AppNotificationSetting.DisabledForApplication => "此应用的 Windows 通知已关闭。请前往系统通知设置开启。",
        AppNotificationSetting.DisabledByGroupPolicy => "Windows 系统策略禁用了通知。",
        _ => "Windows 当前不允许此应用发送通知。",
    };

    private static (string Title, string Message) FormatNotice(GenerationNotice notice)
    {
        if (notice.Outcome == "test") return ("SillyTavern · 通知测试", "这是一条由 Windows 托盘应用发送的测试通知。");
        var retried = notice.Retries > 0 ? $"本次共重试 {notice.Retries} 次。" : "";
        if (notice.Outcome == "success") return ("SillyTavern · 生成完成", $"回复生成完成。{retried}");

        var reason = notice.Code switch
        {
            "request-rejected" => "上游拒绝了请求",
            "network-error" => "网络连接失败",
            "empty-response" => "上游返回空回复",
            "incomplete-stream" => "流式回复中断",
            "tool-error" => "工具执行失败",
            _ => "生成请求失败",
        };
        var status = notice.Status is int httpStatus ? $"（HTTP {httpStatus}）" : "";
        var partial = notice.Partial ? "已保留部分回复。" : "";
        return ("SillyTavern · 生成最终失败", $"{reason}{status}。{partial}{retried}");
    }

    protected override void ExitThreadCore()
    {
        stopping.Cancel();
        trayIcon.Visible = false;
        base.ExitThreadCore();
    }

    protected override void Dispose(bool disposing)
    {
        if (disposing)
        {
            stopping.Cancel();
            listener.GetAwaiter().GetResult();
            trayIcon.Dispose();
            menu.Dispose();
            settings.Dispose();
            if (notifications is not null)
            {
                notifications.NotificationInvoked -= OnNotificationInvoked;
                notifications.Unregister();
            }
            stopping.Dispose();
        }
        base.Dispose(disposing);
    }
}
