# Generation Retry

A standalone SillyTavern extension that retries temporary Chat Completion failures and sends desktop notifications when a conversation generation completes or finally fails.

## Install

Open **Extensions → Install extension**, paste the repository URL, and reload SillyTavern:

```text
https://github.com/Latias94/st-generation-retry
```

Requires SillyTavern 1.13.0 or later. The browser notification channel works with the frontend extension alone.

Open **Extensions → 自动重试与通知** to configure the extension. **启用自动重试** and **启用结果通知** are independent switches, both on by default. For notifications without retries, turn off **启用自动重试** and leave **启用结果通知** on. Your retry limit and delays are retained. Keep the SillyTavern page open while generating.

### Windows tray notifications

The tray application submits native notifications under **SillyTavern Notifier**, independently of the browser's site notification and local network permissions. SillyTavern and the tray application run on the same Windows computer under the same Windows user. Use `http://127.0.0.1:8000` or `http://localhost:8000`, with the port used by your SillyTavern installation.

1. Place [`desktop/st-generation-notifier.mjs`](desktop/st-generation-notifier.mjs) in the `plugins` folder next to SillyTavern's `server.js`. Set `enableServerPlugins: true` in SillyTavern's `config.yaml`, then restart SillyTavern. The `.mjs` file is the entire relay.
2. Build the tray application with the .NET 10 SDK on Windows. Run `dotnet publish desktop/SillyTavernNotifier.csproj -c Release` from this repository. The default build targets x64. For ARM64, add `-r win-arm64`. The application uses the [.NET 10 Desktop Runtime](https://dotnet.microsoft.com/download/dotnet/10.0) and the [Windows App Runtime 1.8](https://learn.microsoft.com/windows/apps/windows-app-sdk/downloads). Use the current servicing release for your architecture.
3. Start `SillyTavernNotifier.exe` in the `publish` directory as a regular user. Keep the files in that directory together. Double-click the tray icon to open settings. The tray menu can pause results, send a test, or exit. Closing settings leaves the tray application running.
4. In the enabled frontend extension, set **通知方式** to **Windows 托盘应用** and click **测试通知**. The tray app's own test checks Windows delivery. The SillyTavern test also checks the server relay.

When Windows accepts the notification, the extension and the tray window report that receipt. **Windows Settings → System → Notifications** controls the app's notification switch and banner visibility. Do not disturb can suppress banners. Press **Win+N** to check the notification center. If the app is paused, results are skipped and the test still works. If delivery fails or the app is offline, SillyTavern shows the result in the page. Final failures also appear in the page immediately.

The extension sends an event ID, outcome, retry count, and optional failure code, HTTP status, and partial-output flag to SillyTavern's same-origin plugin route. The route uses SillyTavern's existing session and CSRF checks and accepts loopback requests. It forwards the event over a user-scoped Windows named pipe. Notification text contains no character names, prompts, reasoning, or reply content.

### Browser notifications

For **浏览器通知**, use HTTPS or a loopback address. Select **授权桌面通知** to request permission, allow notifications for the address shown in the panel, then select **测试通知**. `localhost` and `127.0.0.1`, different ports, and different browser profiles have separate permissions. The browser test reports the browser's display receipt, an error, or a timeout. If the browser reports success and no banner appears, check the browser's notification entry in Windows and the Do not disturb setting. Failed delivery falls back to a SillyTavern toast.

## Settings

| Setting | Default | Behavior |
| --- | --- | --- |
| Enable automatic retry | On | Retries temporary native Chat Completion failures. Turning this off still allows result notifications. |
| Enable result notifications | On | Sends the selected success/failure notifications, independently of automatic retry. Turning this off also disables result toasts; the explicit test button still works. |
| Notification channel | Browser | Choose browser notifications or the Windows tray application. |
| Maximum retries | 3 | Additional attempts after the original request; range 0–10. Applies only when automatic retry is on; 0 also disables retries. |
| Initial delay | 2 seconds | Delay before the first retry; range 1–300 seconds. |
| Exponential backoff | On | Doubles the delay for each retry. |
| Maximum delay | 30 seconds | Caps the delay, including `Retry-After`; range 1–900 seconds and never below the initial delay. |
| Retry empty responses | On | Retries responses without text, reasoning, images, or tool calls. |
| Notify on success | On | One notification after the generation ends and the reply renders. |
| Notify on final failure | On | An immediate in-app error toast and one desktop notification attempt after retries are exhausted or the failure cannot be retried. |
| Notify only in the background | Off | Limits notifications to a hidden or unfocused SillyTavern page. |

The status area displays preparation, active requests, retry delays, and the final result. **停止本次生成 / 重试** cancels the generation and any pending retry. The native SillyTavern stop button works as well. Manual cancellation sends no success or failure notification.

Expand **最近一次失败详情** under **Extensions → 自动重试与通知** to inspect or copy the latest failure. The pane shows the HTTP status and content type when available, the original parser, network, or tool error, and the response body or SSE data that reached the browser. Long excerpts are capped at 16,384 characters and marked as truncated. The latest failure stays in the current tab until reload or a newer failure. For non-streaming requests, some SillyTavern backends send a generic error to the browser and print the provider's original error in the server terminal.

Each final failure also writes one `[Generation Retry] Generation failed.` entry to the **browser developer console**, with the generation ID, error code, HTTP status when available, partial-output flag, and retry count. The console entry and desktop notifications carry summaries. The failure detail pane and console entry are available independently of notification preferences. Server messages such as `Streaming request finished` also appear when a stream contains an error frame or ends without a completion marker, which the extension detects in the browser.

Settings are saved in SillyTavern's user settings. Valid input is also recorded immediately as a pending patch in `sessionStorage`, scoped to the current tab, origin, and SillyTavern account, so refreshing before the native debounced save completes does not discard the edit. The patch contains only changed extension options; it is replayed on reload and removed after a matching server readback. Tabs keep independent pending patches. The panel distinguishes temporary tab storage, pending synchronization, and confirmed server storage. Wait for confirmation before closing the tab. If browser storage is blocked, it warns that synchronization must finish before reloading. Changes to retry options take effect on the next request; notification options are checked when generation finishes. Turning both switches off also stops the extension's active generation. The old combined switch migrates to both independent switches, preserving its on/off state and all existing retry and notification preferences.

## Supported requests

- Native **Chat Completion** generation: normal replies, regenerate, swipe, continue, impersonate, and group member replies.
- Streaming and non-streaming requests through `/api/backends/chat-completions/generate`.
- OpenAI-compatible response shapes, including custom and proxy connections, plus Anthropic, Gemini, and Cohere stream completion markers.
- Temporary network errors, HTTP 408/425/429/5xx, and recognized transient errors inside HTTP 200 JSON or SSE responses.
- Authentication, permissions, quota exhaustion, billing, invalid requests, context limits, and content policy failures end immediately when the response exposes that information. Some providers replace detailed errors with a generic server error; those follow the HTTP status.
- `Retry-After` is honored up to the configured maximum delay.

The extension excludes `quiet` generation, prompt dry runs, unrelated fetches, and Text Completion/Kobold/NovelAI/Horde endpoints. It does not retry failures that happen before a generation request is sent, such as prompt construction errors or a disconnected SillyTavern server.

## Retry boundaries

The extension repeats the **same serialized HTTP request** within the original native generation. It never calls `Generate()` again, appends another user message, reconstructs the prompt, or reruns already executed tools. Group members, tool follow-up requests, and immediate auto-continues are consolidated into one result notification.

Before a stream emits any output, temporary failures and empty streams can be retried. Once text, reasoning, an image, or a tool call has reached SillyTavern, a subsequent interruption is reported as a final failure without replaying the request. Any partial reply remains available for the user to inspect. A missing completion marker is treated as an interrupted stream. Supported markers include `[DONE]`, finish reasons for every requested choice, Anthropic `message_stop`/`stop_reason`, and Cohere `message-end`.

Stopping generation, changing chats, changing the API/model/profile, or turning both switches off cancels pending work. Retry checks also verify the chat and connection identity before sending the next request. A network error cannot prove whether an upstream service already processed or billed a request; retries remain subject to the provider's usage policy.

Desktop notification success reflects the native generation reaching its end after a valid upstream result. The extension waits for native streaming finalization, saving, and tool execution before settling the result; reported tool errors or unhandled tool calls produce a failure notification. It does not verify downstream third-party rendering scripts, durable file storage, or tool execution side effects.

## Development

This extension is dependency-free ESM. Run checks with Node.js 20 or later:

```text
npm test
npm run check
```

Tests use simulated fetch responses and generation events. They cover request preservation, retry exhaustion, permanent and transient errors, empty replies, SSE framing and Unicode splits, partial output, tool calls, group notifications, cancellation, changed context, and notification privacy. They never call an AI provider.

For manual installation, copy `manifest.json`, `index.js`, `style.css`, and `src/` into `data/<user>/extensions/st-generation-retry/` and reload SillyTavern. Install one copy per user, or use the native global extension installer if it should be shared by all users.

`index.js` binds native events, observes native tool invocation results, and installs a narrowly filtered, chainable `fetch` wrapper. Native request preparation metadata and the active streaming signal associate requests with the current generation, while allowing other extensions to transform messages and tool definitions. `src/transport.js` owns the request retry loop and cancellation. `src/stream.js` inspects SSE without rewriting successful stream bytes. `src/controller.js` consolidates generation outcomes using native lifecycle state rather than a fixed completion delay. Settings, notifications, and the extension panel are kept in small separate modules.

## License

AGPL-3.0-only. See [LICENSE](LICENSE).
