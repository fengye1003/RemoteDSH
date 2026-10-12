using System.Net.WebSockets;
using System.Text;
using System.Text.Json;

namespace Rdsh;

/// <summary>Frames exchanged over the reverse tunnel to the DSH relay.</summary>
public static class TunnelFrames
{
    public const string Req = "req";
    public const string Res = "res";
    public const string Ping = "ping";
    public const string Pong = "pong";
    public const string Hello = "hello";
}

/// <summary>Status of the reverse connection, surfaced on the console panel.</summary>
public sealed class TunnelState
{
    public volatile bool Connected;
    public string? Relay;
    public string LastError = "";
    public int Reconnects;
    public long ConnectedSinceMs;
    public int RequestsHandled;
    public long LastActivityMs;
}

/// <summary>
/// Reverse transport: this agent dials OUT to the DSH relay and serves RPC over
/// that socket, so the target never needs an inbound port, a public IP, or any
/// third-party tunnel.
/// </summary>
public sealed class Tunnel
{
    private readonly Dispatcher _dispatcher;
    private readonly string _agentId;
    private readonly string _secret;
    private readonly TunnelState _state;

    public Tunnel(Dispatcher dispatcher, string agentId, string secret, TunnelState state)
    {
        _dispatcher = dispatcher;
        _agentId = agentId;
        _secret = secret;
        _state = state;
    }

    /// <summary>Connect and serve forever, reconnecting with capped exponential backoff.</summary>
    public async Task RunAsync(string relayBaseUrl, CancellationToken ct)
    {
        var delay = 1000;
        while (!ct.IsCancellationRequested)
        {
            _state.Relay = relayBaseUrl;
            try
            {
                await ServeOnce(relayBaseUrl, ct);
                delay = 1000;
            }
            catch (OperationCanceledException) when (ct.IsCancellationRequested)
            {
                break;
            }
            catch (Exception ex)
            {
                _state.Connected = false;
                _state.LastError = $"{ex.GetType().Name}: {ex.Message}";
            }

            if (ct.IsCancellationRequested) break;
            _state.Reconnects++;
            try
            {
                await Task.Delay(delay, ct);
            }
            catch (OperationCanceledException)
            {
                break;
            }
            delay = Math.Min(delay * 2, 30_000);
        }
    }

    private async Task ServeOnce(string relayBaseUrl, CancellationToken ct)
    {
        var wsUrl = ToWebSocketUrl(relayBaseUrl) + $"/remote/attach?id={Uri.EscapeDataString(_agentId)}";
        using var ws = new ClientWebSocket();
        ws.Options.SetRequestHeader("Authorization", "Bearer " + Crypto.HmacBase64Url(_secret, "attach:" + _agentId));
        ws.Options.SetRequestHeader("X-RDSH-Agent", Version.Full);
        ws.Options.KeepAliveInterval = TimeSpan.FromSeconds(20);

        await ws.ConnectAsync(new Uri(wsUrl), ct);
        _state.Connected = true;
        _state.ConnectedSinceMs = Environment.TickCount64;
        _state.LastActivityMs = Environment.TickCount64;
        _state.LastError = "";
        Audit.Write("tunnel", true, $"attached to {relayBaseUrl}");

        await SendHello(ws, ct);

        var buffer = new byte[256 * 1024];
        var pending = new MemoryStream();
        while (ws.State == WebSocketState.Open && !ct.IsCancellationRequested)
        {
            var result = await ws.ReceiveAsync(buffer, ct);
            if (result.MessageType == WebSocketMessageType.Close) break;

            pending.Write(buffer, 0, result.Count);
            if (!result.EndOfMessage) continue;

            var text = Encoding.UTF8.GetString(pending.ToArray());
            pending.SetLength(0);
            if (text.Length == 0) continue;
            _state.LastActivityMs = Environment.TickCount64;

            _ = Task.Run(() => HandleFrame(ws, text, ct), ct);
        }

        _state.Connected = false;
    }

    private async Task SendHello(ClientWebSocket ws, CancellationToken ct)
    {
        var hello = new StringBuilder();
        hello.Append("{\"t\":\"").Append(TunnelFrames.Hello).Append("\",\"data\":");
        hello.Append(JsonSerializer.Serialize(_dispatcher.Hello(), RdshJson.Default.HelloResult));
        hello.Append('}');
        await SendText(ws, hello.ToString(), ct);
    }

    private async Task HandleFrame(ClientWebSocket ws, string text, CancellationToken ct)
    {
        string? id = null;
        try
        {
            using var doc = JsonDocument.Parse(text);
            var root = doc.RootElement;
            var type = root.TryGetProperty("t", out var t) ? t.GetString() : null;
            if (type == TunnelFrames.Ping)
            {
                await SendText(ws, "{\"t\":\"pong\"}", ct);
                return;
            }
            if (type != TunnelFrames.Req) return;

            id = root.TryGetProperty("id", out var idEl) ? idEl.GetString() : null;
            var method = root.TryGetProperty("method", out var mEl) ? mEl.GetString() ?? "" : "";
            var argsJson = root.TryGetProperty("args", out var aEl) && aEl.ValueKind == JsonValueKind.Object
                ? aEl.GetRawText()
                : "{}";

            _state.RequestsHandled++;
            _state.LastActivityMs = Environment.TickCount64;

            var args = HttpServer.ParseArgs(argsJson);
            var reply = _dispatcher.Invoke(method, args);
            var body = JsonSerializer.Serialize(reply, RdshJson.Default.RpcReply);
            var frame = $"{{\"t\":\"{TunnelFrames.Res}\",\"id\":{JsonEscape(id ?? "")},\"data\":{body}}}";
            await SendText(ws, frame, ct);
        }
        catch (Exception ex)
        {
            try
            {
                var err = RpcReply.Bad("internal", $"{ex.GetType().Name}: {ex.Message}");
                var body = JsonSerializer.Serialize(err, RdshJson.Default.RpcReply);
                var frame = $"{{\"t\":\"{TunnelFrames.Res}\",\"id\":{JsonEscape(id ?? "")},\"data\":{body}}}";
                await SendText(ws, frame, ct);
            }
            catch
            {
                // The socket is gone; the reconnect loop will handle it.
            }
        }
    }

    /// <summary>Quote a string as a JSON literal without touching reflection-based serializers.</summary>
    public static string JsonEscape(string s)
    {
        var sb = new StringBuilder(s.Length + 2);
        sb.Append('"');
        foreach (var ch in s)
        {
            switch (ch)
            {
                case '"': sb.Append("\\\""); break;
                case '\\': sb.Append("\\\\"); break;
                case '\n': sb.Append("\\n"); break;
                case '\r': sb.Append("\\r"); break;
                case '\t': sb.Append("\\t"); break;
                default:
                    if (ch < 0x20) sb.Append("\\u").Append(((int)ch).ToString("x4"));
                    else sb.Append(ch);
                    break;
            }
        }
        sb.Append('"');
        return sb.ToString();
    }

    private static async Task SendText(ClientWebSocket ws, string text, CancellationToken ct)
    {
        var bytes = Encoding.UTF8.GetBytes(text);
        await ws.SendAsync(bytes, WebSocketMessageType.Text, endOfMessage: true, ct);
    }

    private static string ToWebSocketUrl(string baseUrl)
    {
        var trimmed = baseUrl.TrimEnd('/');
        if (trimmed.StartsWith("https://", StringComparison.OrdinalIgnoreCase))
            return "wss://" + trimmed["https://".Length..];
        if (trimmed.StartsWith("http://", StringComparison.OrdinalIgnoreCase))
            return "ws://" + trimmed["http://".Length..];
        return "ws://" + trimmed;
    }
}
