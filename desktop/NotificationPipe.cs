using System.IO.Pipes;
using System.Text.Json;

namespace SillyTavernNotifier;

internal enum Receipt : byte
{
    Sent = (byte)'S',
    Paused = (byte)'P',
    Disabled = (byte)'D',
    Failed = (byte)'E',
}

internal sealed record GenerationNotice(Guid Id, string Outcome, int Retries = 0, string? Code = null, int? Status = null, bool Partial = false);

internal static class NotificationPipe
{
    private const string Name = "SillyTavern.GenerationNotifier.v1";
    private const int ListenerCount = 3;
    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web);

    public static async Task ListenAsync(Func<GenerationNotice, CancellationToken, Task<Receipt>> deliver, CancellationToken stopping)
    {
        using var lifetime = CancellationTokenSource.CreateLinkedTokenSource(stopping);
        var listeners = Enumerable.Range(0, ListenerCount).Select(_ => AcceptAsync(deliver, lifetime.Token)).ToArray();
        await Task.WhenAny(listeners);
        await lifetime.CancelAsync();
        await Task.WhenAll(listeners);
    }

    private static async Task AcceptAsync(Func<GenerationNotice, CancellationToken, Task<Receipt>> deliver, CancellationToken stopping)
    {
        try
        {
            while (!stopping.IsCancellationRequested)
            {
                await using var pipe = new NamedPipeServerStream(Name, PipeDirection.InOut, NamedPipeServerStream.MaxAllowedServerInstances,
                    PipeTransmissionMode.Byte, PipeOptions.Asynchronous | PipeOptions.CurrentUserOnly);
                await pipe.WaitForConnectionAsync(stopping);
                using var request = CancellationTokenSource.CreateLinkedTokenSource(stopping);
                request.CancelAfter(TimeSpan.FromSeconds(2));

                try
                {
                    var notice = await ReadNoticeAsync(pipe, request.Token);
                    var receipt = notice is null ? Receipt.Failed : await deliver(notice, request.Token);
                    await pipe.WriteAsync(new byte[] { (byte)receipt }, request.Token);
                }
                catch (OperationCanceledException) when (request.IsCancellationRequested) { }
                catch (IOException) { }
            }
        }
        catch (OperationCanceledException) when (stopping.IsCancellationRequested) { }
    }

    private static async Task<GenerationNotice?> ReadNoticeAsync(Stream pipe, CancellationToken stopping)
    {
        var buffer = new byte[512];
        var length = 0;
        while (length < buffer.Length)
        {
            var count = await pipe.ReadAsync(buffer.AsMemory(length), stopping);
            if (count == 0) return null;
            var newline = Array.IndexOf(buffer, (byte)'\n', length, count);
            length += count;
            if (newline < 0) continue;
            if (newline != length - 1) return null;

            try
            {
                var notice = JsonSerializer.Deserialize<GenerationNotice>(buffer.AsSpan(0, newline), JsonOptions);
                return notice is { } && notice.Id != Guid.Empty && notice.Outcome is "success" or "failure" or "test"
                    && notice.Retries >= 0 && notice.Status is null or (>= 400 and <= 599) ? notice : null;
            }
            catch (JsonException) { return null; }
        }
        return null;
    }
}
