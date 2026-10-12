using System.Net;
using System.Text;
using System.Text.Json;

namespace Rdsh;

/// <summary>Small non-RPC envelope (ping / transport-level errors).</summary>
public sealed class SimpleReply
{
    public bool Ok { get; set; }
    public string? Id { get; set; }
    public string? V { get; set; }
    public string? Code { get; set; }
    public string? Error { get; set; }
}

/// <summary>Direct-listen transport: a minimal HTTP surface over the RPC dispatcher.</summary>
public sealed class HttpServer
{
    private readonly Dispatcher _dispatcher;
    private readonly Authenticator _auth;
    private readonly string _agentId;
    private HttpListener? _listener;

    public int Port { get; private set; }
    public string BaseUrl { get; private set; } = "";

    public HttpServer(Dispatcher dispatcher, Authenticator auth, string agentId)
    {
        _dispatcher = dispatcher;
        _auth = auth;
        _agentId = agentId;
    }

    public void Start(string bind, int port)
    {
        var listener = new HttpListener();
        var actualPort = port == 0 ? FreePort(bind) : port;
        var prefixes = new List<string> { $"http://{bind}:{actualPort}/" };
        if (bind is "0.0.0.0" or "+" or "*")
        {
            // A wildcard prefix is not accepted by every platform; also bind loopback explicitly.
            prefixes.Add($"http://127.0.0.1:{actualPort}/");
        }
        foreach (var p in prefixes) listener.Prefixes.Add(p);
        listener.Start();
        _listener = listener;
        Port = actualPort;
        var shown = bind is "0.0.0.0" or "+" or "*" ? "127.0.0.1" : bind;
        BaseUrl = $"http://{shown}:{actualPort}";
        _ = AcceptLoop(listener);
    }

    private static int FreePort(string bind)
    {
        var any = bind is "0.0.0.0" or "+" or "*";
        var probe = new System.Net.Sockets.TcpListener(any ? IPAddress.Any : IPAddress.Loopback, 0);
        probe.Start();
        var port = ((IPEndPoint)probe.LocalEndpoint).Port;
        probe.Stop();
        return port;
    }

    private async Task AcceptLoop(HttpListener listener)
    {
        while (listener.IsListening)
        {
            HttpListenerContext ctx;
            try
            {
                ctx = await listener.GetContextAsync();
            }
            catch
            {
                break;
            }
            _ = Task.Run(() => Handle(ctx));
        }
    }

    private async Task Handle(HttpListenerContext ctx)
    {
        var req = ctx.Request;
        var path = req.Url?.AbsolutePath ?? "/";
        var method = req.HttpMethod;

        try
        {
            if (path == "/v1/ping")
            {
                await Respond(ctx, 200, new SimpleReply { Ok = true, Id = _agentId, V = Version.Full });
                return;
            }

            if (path.StartsWith("/v1/rpc/", StringComparison.Ordinal))
            {
                var rpcMethod = path["/v1/rpc/".Length..];
                var body = await ReadBody(req);
                var verdict = _auth.Verify(method, path, req.Headers["X-RDSH-Ts"], req.Headers["X-RDSH-Nonce"], req.Headers["X-RDSH-Sig"], body);
                if (!verdict.Ok)
                {
                    Audit.Write(rpcMethod, false, verdict.Error ?? "denied");
                    await Respond(ctx, 401, new SimpleReply { Ok = false, Code = "unauthorized", Error = verdict.Error });
                    return;
                }

                var args = ParseArgs(body);
                var reply = _dispatcher.Invoke(rpcMethod, args);
                await Respond(ctx, 200, reply);
                return;
            }

            await Respond(ctx, 404, new SimpleReply { Ok = false, Code = "not_found" });
        }
        catch (Exception ex)
        {
            try
            {
                await Respond(ctx, 500, new SimpleReply { Ok = false, Code = "internal", Error = $"{ex.GetType().Name}: {ex.Message}" });
            }
            catch
            {
                // The client vanished; nothing useful left to do.
            }
        }
    }

    private static async Task<string> ReadBody(HttpListenerRequest req)
    {
        using var reader = new StreamReader(req.InputStream, Encoding.UTF8);
        return await reader.ReadToEndAsync();
    }

    /// <summary>Parse a JSON object into a property bag without reflection.</summary>
    public static Dictionary<string, JsonElement> ParseArgs(string body)
    {
        if (string.IsNullOrWhiteSpace(body)) return new Dictionary<string, JsonElement>();
        using var doc = JsonDocument.Parse(body);
        if (doc.RootElement.ValueKind != JsonValueKind.Object) return new Dictionary<string, JsonElement>();
        var bag = new Dictionary<string, JsonElement>(StringComparer.Ordinal);
        foreach (var prop in doc.RootElement.EnumerateObject())
        {
            bag[prop.Name] = prop.Value.Clone();
        }
        return bag;
    }

    private static async Task Respond(HttpListenerContext ctx, int status, object payload)
    {
        var json = payload switch
        {
            RpcReply reply => JsonSerializer.Serialize(reply, RdshJson.Default.RpcReply),
            SimpleReply simple => JsonSerializer.Serialize(simple, RdshJson.Default.SimpleReply),
            _ => JsonSerializer.Serialize(new SimpleReply { Ok = false, Code = "internal" }, RdshJson.Default.SimpleReply),
        };

        var bytes = Encoding.UTF8.GetBytes(json);
        ctx.Response.StatusCode = status;
        ctx.Response.ContentType = "application/json; charset=utf-8";
        ctx.Response.ContentLength64 = bytes.Length;
        await ctx.Response.OutputStream.WriteAsync(bytes);
        ctx.Response.Close();
    }

    public void Stop()
    {
        try { _listener?.Stop(); } catch { /* ignored */ }
    }
}
