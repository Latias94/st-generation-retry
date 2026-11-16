# Generation Retry

A standalone SillyTavern extension that retries temporary Chat Completion failures and sends desktop notifications when a conversation generation completes or finally fails.

## Install

Open **Extensions → Install extension**, paste the repository URL, and reload SillyTavern:

```text
https://github.com/Latias94/st-generation-retry
```

Requires SillyTavern 1.13.0 or later. No server plugin, Node package installation, API key, or core patch is needed.

Open **Extensions → 自动重试与通知** to configure the extension. It is enabled by default. Select **授权桌面通知** to request permission, allow notifications in the browser, and then select **测试通知**. Permission is requested only after that button is pressed. Notification text never includes character names, prompts, reasoning, or reply content.

Browsers require HTTPS or a localhost origin for desktop notifications. For a local server, use `http://localhost:8000` or `http://127.0.0.1:8000`. A plain HTTP LAN address does not qualify. If permission is denied, unavailable, or delivery fails or has no browser receipt within five seconds, the extension uses a SillyTavern toast. Browser and operating system notification settings still control delivery. Keep the SillyTavern page open while generating.

The panel identifies the exact current origin. `localhost` and `127.0.0.1`, different ports, and different browser profiles have separate permissions. The extension cannot grant or retain browser permissions itself. Allow notifications for the address actually shown in the panel.

**测试通知** reports progress and then the browser's `show`/`error` event, or a timeout. A `show` receipt confirms the browser accepted the notification; it cannot prove that Windows showed a banner to the user. If the browser reports success but no banner appears, press **Win+N** and check **Windows Settings → System → Notifications → Microsoft Edge / your browser → Show notification banners**, together with Do not disturb. Browser permission and the Windows banner switch must both allow display.

## Settings

| Setting | Default | Behavior |
| --- | --- | --- |
| Enable retry and notifications | On | Enables both features for future native Chat Completion generations. |
| Maximum retries | 3 | Additional attempts after the original request; range 0–10. Set to 0 for notifications without retries. |
| Initial delay | 2 seconds | Delay before the first retry; range 1–300 seconds. |
| Exponential backoff | On | Doubles the delay for each retry. |
| Maximum delay | 30 seconds | Caps the delay, including `Retry-After`; range 1–900 seconds and never below the initial delay. |
| Retry empty responses | On | Retries responses without text, reasoning, images, or tool calls. |
| Notify on success | On | One notification after the generation ends and the reply renders. |
| Notify on final failure | On | One notification after retries are exhausted or the failure cannot be retried. |
| Notify only in the background | Off | Limits notifications to a hidden or unfocused SillyTavern page. |

The status area displays preparation, active requests, retry delays, and the final result. **停止本次生成 / 重试** cancels the generation and any pending retry. The native SillyTavern stop button works as well. Manual cancellation sends no success or failure notification.

Settings are saved in SillyTavern's user settings. Valid input is also recorded immediately as a pending local patch, scoped to the current origin and SillyTavern account, so refreshing before the native debounced save completes does not discard the edit. The patch contains only changed extension options; it is replayed on reload and removed after a matching server readback. The panel distinguishes local persistence, pending synchronization, and confirmed server storage. If browser storage is blocked, it warns that synchronization must finish before reloading. Editing retry limits takes effect on the next request; disabling the extension also stops its active generation.

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

Stopping generation, changing chats, changing the API/model/profile, or disabling the extension cancels pending work. Retry checks also verify the chat and connection identity before sending the next request. A network error cannot prove whether an upstream service already processed or billed a request; retries remain subject to the provider's usage policy.

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
