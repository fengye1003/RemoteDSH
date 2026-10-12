using System.Collections.Concurrent;
using System.Net;
using System.Text;
using System.Text.Json;

namespace Rdsh;

/// <summary>Replay defence: a nonce is accepted once inside the freshness window.</summary>
public sealed class NonceCache
{
    private readonly ConcurrentDictionary<string, long> _seen = new();
    private readonly long _windowMs;

    public NonceCache(int windowSeconds = 120) => _windowMs = windowSeconds * 1000L;

    public bool TryAccept(string nonce)
    {
        var now = Environment.TickCount64;
        foreach (var kv in _seen)
        {
            if (now - kv.Value > _windowMs) _seen.TryRemove(kv.Key, out _);
        }
        return _seen.TryAdd(nonce, now);
    }
}

/// <summary>Append-only audit trail kept on the target machine.</summary>
public static class Audit
{
    private static readonly object Gate = new();

    public static void Write(string method, bool ok, string detail)
    {
        try
        {
            var line = $"{DateTimeOffset.UtcNow:yyyy-MM-ddTHH:mm:ss.fffZ}\t{(ok ? "ok" : "DENY")}\t{method}\t{detail}";
            lock (Gate)
            {
                Directory.CreateDirectory(Config.HomeDir);
                File.AppendAllText(Config.AuditPath, line + Environment.NewLine);
            }
        }
        catch
        {
            // Auditing must never take the agent down.
        }
    }

    /// <summary>One-line, bounded summary so audit files stay readable.</summary>
    public static string Summarize(string s)
    {
        var flat = s.Replace('\r', ' ').Replace('\n', ' ');
        return flat.Length <= 200 ? flat : flat[..200] + "...";
    }
}

/// <summary>Signature verification for every remote request.</summary>
public sealed class Authenticator
{
    private readonly string _secret;
    private readonly NonceCache _nonces;
    private readonly Func<long> _now;

    public Authenticator(string secret, NonceCache nonces, Func<long>? now = null)
    {
        _secret = secret;
        _nonces = nonces;
        _now = now ?? (() => DateTimeOffset.UtcNow.ToUnixTimeSeconds());
    }

    public (bool Ok, string? Error) Verify(string method, string path, string? ts, string? nonce, string? sig, string body)
    {
        if (string.IsNullOrEmpty(ts) || string.IsNullOrEmpty(nonce) || string.IsNullOrEmpty(sig))
            return (false, "missing signature headers");
        if (!long.TryParse(ts, out var stamp)) return (false, "bad timestamp");
        if (Math.Abs(_now() - stamp) > 120) return (false, "stale timestamp");
        var expected = Crypto.Sign(_secret, method, path, ts, nonce, body);
        if (!Crypto.FixedEquals(expected, sig)) return (false, "bad signature");
        if (!_nonces.TryAccept(nonce)) return (false, "replayed nonce");
        return (true, null);
    }
}

/// <summary>The RPC surface, shared by direct HTTP and the reverse tunnel.</summary>
public sealed class Dispatcher
{
    public JobRegistry Jobs { get; } = new();
    public string AgentId { get; init; } = "";
    public DateTime StartedAt { get; } = DateTime.UtcNow;
    /// <summary>Invoked by the panel's "disconnect" action to drop live sessions.</summary>
    public Action? OnDisconnectRequested { get; set; }

    /// <summary>Run one method; args is the parsed JSON object (never null).</summary>
    public RpcReply Invoke(string method, Dictionary<string, JsonElement> args)
    {
        try
        {
            return method switch
            {
                "hello" => RpcReply.FromHello(Hello()),
                "exec" => Exec(args),
                "poll" => Poll(args),
                "kill" => Kill(args),
                "jobs" => RpcReply.FromJobs(new JobListResult { Jobs = Jobs.List() }),
                "read" => Read(args),
                "write" => WriteFile(args),
                "ls" => Ls(args),
                "stat" => Stat(args),
                "rm" => Rm(args),
                "node" => Node(args),
                "info" => RpcReply.FromHello(Hello()),
                "disconnect" => Disconnect(),
                _ => RpcReply.Bad("unknown_method", $"unknown method: {method}"),
            };
        }
        catch (FileNotFoundException ex)
        {
            return RpcReply.Bad("not_found", ex.Message);
        }
        catch (DirectoryNotFoundException ex)
        {
            return RpcReply.Bad("not_found", ex.Message);
        }
        catch (UnauthorizedAccessException ex)
        {
            return RpcReply.Bad("denied", ex.Message);
        }
        catch (Exception ex)
        {
            return RpcReply.Bad("internal", $"{ex.GetType().Name}: {ex.Message}");
        }
    }

    public HelloResult Hello() => new()
    {
        Id = AgentId,
        Host = Environment.MachineName,
        Os = OperatingSystem.IsWindows() ? "windows" : OperatingSystem.IsLinux() ? "linux" : OperatingSystem.IsMacOS() ? "macos" : "unknown",
        Arch = System.Runtime.InteropServices.RuntimeInformation.ProcessArchitecture.ToString().ToLowerInvariant(),
        Ver = Version.Full,
        User = Environment.UserName,
        Pid = Environment.ProcessId,
        Node = NodeRuntime.Available,
        NodePath = NodeRuntime.Path,
        NodeSource = NodeRuntime.Source,
        Flavor = Version.Flavor,
        ChildEncoding = ConsoleText.ChildOutput.WebName,
        ChildCodePage = ConsoleText.DetectedCodePage,
        Caps = NodeRuntime.Available
            ? new[] { "exec", "poll", "file", "jobs", "node" }
            : new[] { "exec", "poll", "file", "jobs" },
    };

    private RpcReply Exec(Dictionary<string, JsonElement> args)
    {
        var command = Str(args, "command") ?? throw new ArgumentException("command is required");
        var workdir = Str(args, "workdir");
        var timeoutMs = Int(args, "timeoutMs") ?? 120_000;
        var detached = Bool(args, "detached") ?? false;
        var label = Str(args, "label");
        var shell = Str(args, "shell");
        var job = Jobs.Start(command, workdir, detached ? 0 : timeoutMs, detached, label, shell);
        Audit.Write("exec", true, $"{job.Id} {(detached ? "[bg] " : "")}{Audit.Summarize(command)}");
        return RpcReply.FromExec(new ExecResult { RunId = job.Id, Pid = job.Pid });
    }

    private RpcReply Poll(Dictionary<string, JsonElement> args)
    {
        var id = Str(args, "runId") ?? throw new ArgumentException("runId is required");
        var waitMs = Int(args, "waitMs") ?? 0;
        var job = Jobs.Get(id) ?? throw new FileNotFoundException($"no such run: {id}");

        // Bounded long-poll: return as soon as there is output or the job ends.
        var deadline = Environment.TickCount64 + Math.Clamp(waitMs, 0, 60_000);
        var (outText, errText) = job.Drain();
        while (waitMs > 0 && outText.Length == 0 && errText.Length == 0 && job.Running && Environment.TickCount64 < deadline)
        {
            Thread.Sleep(50);
            (outText, errText) = job.Drain();
        }

        return RpcReply.FromPoll(new PollResult
        {
            Out = outText,
            Err = errText,
            ExitCode = job.Running ? -1 : job.ExitCode,
            Done = !job.Running,
            TimedOut = job.TimedOut,
            Truncated = job.Truncated,
            ElapsedMs = job.ElapsedMs,
        });
    }

    private RpcReply Kill(Dictionary<string, JsonElement> args)
    {
        var id = Str(args, "runId") ?? throw new ArgumentException("runId is required");
        var killed = Jobs.Kill(id);
        Audit.Write("kill", true, id);
        return RpcReply.FromOk(new OkResult { Ok = killed, Detail = killed ? null : "already finished or unknown" });
    }

    private static RpcReply Read(Dictionary<string, JsonElement> args)
    {
        var path = Str(args, "path") ?? throw new ArgumentException("path is required");
        var offset = Long(args, "offset") ?? 0;
        var maxBytes = (int)Math.Clamp(Long(args, "maxBytes") ?? 4 * 1024 * 1024, 1, 8 * 1024 * 1024);
        var asBase64 = Bool(args, "base64") ?? false;
        var full = Path.GetFullPath(path);

        using var fs = new FileStream(full, FileMode.Open, FileAccess.Read, FileShare.ReadWrite);
        var length = fs.Length;
        var start = Math.Clamp(offset, 0, length);
        fs.Seek(start, SeekOrigin.Begin);
        var take = (int)Math.Min(maxBytes, length - start);
        var buf = new byte[take];
        var got = fs.Read(buf, 0, take);
        var chunk = buf.AsSpan(0, got).ToArray();

        return RpcReply.FromRead(new ReadResult
        {
            Path = full,
            Offset = start,
            Length = length,
            Eof = start + got >= length,
            Text = asBase64 ? null : SafeText(chunk),
            Base64 = asBase64 ? Convert.ToBase64String(chunk) : null,
        });
    }

    /// <summary>Decode as UTF-8 but fall back to base64 when the bytes are not text.</summary>
    private static string? SafeText(byte[] data)
    {
        try
        {
            var strict = new UTF8Encoding(false, throwOnInvalidBytes: true);
            return strict.GetString(data);
        }
        catch (DecoderFallbackException)
        {
            return null;
        }
    }

    private static RpcReply WriteFile(Dictionary<string, JsonElement> args)
    {
        var path = Str(args, "path") ?? throw new ArgumentException("path is required");
        var full = Path.GetFullPath(path);
        var append = Bool(args, "append") ?? false;
        var dir = Path.GetDirectoryName(full);
        if (!string.IsNullOrEmpty(dir)) Directory.CreateDirectory(dir);

        long written = 0;
        if (args.TryGetValue("base64", out var b64) && b64.ValueKind == JsonValueKind.String)
        {
            var bytes = Convert.FromBase64String(b64.GetString()!);
            using var fs = new FileStream(full, append ? FileMode.Append : FileMode.Create, FileAccess.Write);
            fs.Write(bytes);
            written = bytes.Length;
        }
        else if (args.TryGetValue("text", out var txt) && txt.ValueKind == JsonValueKind.String)
        {
            var bytes = Encoding.UTF8.GetBytes(txt.GetString()!);
            using var fs = new FileStream(full, append ? FileMode.Append : FileMode.Create, FileAccess.Write);
            fs.Write(bytes);
            written = bytes.Length;
        }
        else
        {
            throw new ArgumentException("either base64 or text is required");
        }

        Audit.Write("write", true, $"{full} ({written} bytes)");
        return RpcReply.FromWrite(new WriteResult { Path = full, Bytes = written });
    }

    private static RpcReply Ls(Dictionary<string, JsonElement> args)
    {
        var path = Str(args, "path") ?? ".";
        var full = Path.GetFullPath(path);
        if (!Directory.Exists(full)) throw new DirectoryNotFoundException($"no such directory: {full}");

        var entries = new List<LsEntry>();
        foreach (var dir in Directory.EnumerateDirectories(full))
        {
            var info = new DirectoryInfo(dir);
            entries.Add(new LsEntry { Name = info.Name, IsDir = true, Size = 0, MtimeMs = new DateTimeOffset(info.LastWriteTimeUtc).ToUnixTimeMilliseconds() });
        }
        foreach (var file in Directory.EnumerateFiles(full))
        {
            var info = new FileInfo(file);
            entries.Add(new LsEntry { Name = info.Name, IsDir = false, Size = info.Length, MtimeMs = new DateTimeOffset(info.LastWriteTimeUtc).ToUnixTimeMilliseconds() });
        }
        return RpcReply.FromLs(new LsResult { Path = full, Entries = entries.OrderBy(e => e.Name, StringComparer.OrdinalIgnoreCase).ToArray() });
    }

    private static RpcReply Stat(Dictionary<string, JsonElement> args)
    {
        var path = Str(args, "path") ?? throw new ArgumentException("path is required");
        var full = Path.GetFullPath(path);
        if (Directory.Exists(full))
        {
            var d = new DirectoryInfo(full);
            return RpcReply.FromStat(new StatResult { Path = full, Exists = true, Kind = "dir", IsDir = true, MtimeMs = new DateTimeOffset(d.LastWriteTimeUtc).ToUnixTimeMilliseconds() });
        }
        if (File.Exists(full))
        {
            var f = new FileInfo(full);
            return RpcReply.FromStat(new StatResult { Path = full, Exists = true, Kind = "file", Size = f.Length, MtimeMs = new DateTimeOffset(f.LastWriteTimeUtc).ToUnixTimeMilliseconds() });
        }
        return RpcReply.FromStat(new StatResult { Path = full, Exists = false });
    }

    private static RpcReply Rm(Dictionary<string, JsonElement> args)
    {
        var path = Str(args, "path") ?? throw new ArgumentException("path is required");
        var full = Path.GetFullPath(path);
        var hard = Bool(args, "hard") ?? false;
        var recursive = Bool(args, "recursive") ?? false;

        if (Directory.Exists(full))
        {
            if (!recursive) throw new InvalidOperationException("refusing to remove a directory without recursive=true");
            if (hard) Directory.Delete(full, recursive: true);
            else Directory.Move(full, full + ".rdsh-trash-" + DateTimeOffset.UtcNow.ToUnixTimeSeconds());
        }
        else if (File.Exists(full))
        {
            if (hard) File.Delete(full);
            else File.Move(full, full + ".rdsh-trash-" + DateTimeOffset.UtcNow.ToUnixTimeSeconds(), overwrite: false);
        }
        else
        {
            throw new FileNotFoundException($"no such path: {full}");
        }

        Audit.Write("rm", true, $"{(hard ? "[hard] " : "")}{full}");
        return RpcReply.FromOk(new OkResult());
    }

    private RpcReply Node(Dictionary<string, JsonElement> args)
    {
        if (!NodeRuntime.Available)
        {
            return RpcReply.Bad("no_node_runtime",
                "this rdsh build has no embedded Node runtime (slim flavor). Use a node already installed on the target, or run the --full build.");
        }

        var script = Str(args, "script");
        var scriptPath = Str(args, "path");
        var workdir = Str(args, "cwd");
        var timeoutMs = Int(args, "timeoutMs") ?? 300_000;
        var label = Str(args, "label");

        string file;
        if (!string.IsNullOrEmpty(scriptPath))
        {
            file = Path.GetFullPath(scriptPath);
            if (!File.Exists(file)) throw new FileNotFoundException($"no such script: {file}");
        }
        else if (!string.IsNullOrEmpty(script))
        {
            var dir = Path.Combine(Config.HomeDir, "scripts");
            Directory.CreateDirectory(dir);
            file = Path.Combine(dir, $"inline-{DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()}.mjs");
            File.WriteAllText(file, script, new UTF8Encoding(false));
        }
        else
        {
            throw new ArgumentException("either script or path is required");
        }


        // Start node directly rather than assembling a shell command line: shell
        // quoting differs per platform and a misread argument silently ran the
        // wrong program on Linux.
        var argv = new List<string> { file };
        if (args.TryGetValue("args", out var argEl) && argEl.ValueKind == JsonValueKind.Array)
        {
            foreach (var e in argEl.EnumerateArray())
            {
                if (e.ValueKind == JsonValueKind.String) argv.Add(e.GetString()!);
            }
        }
        var job = Jobs.StartProcess(NodeRuntime.Path!, argv, workdir, timeoutMs, detached: false, label ?? Path.GetFileName(file));
        Audit.Write("node", true, $"{job.Id} {file}");
        return RpcReply.FromExec(new ExecResult { RunId = job.Id, Pid = job.Pid });
    }



    private RpcReply Disconnect()
    {
        Audit.Write("disconnect", true, "requested by controller");
        OnDisconnectRequested?.Invoke();
        return RpcReply.FromOk(new OkResult());
    }

    // ---- argument helpers (JsonElement navigation, AOT-safe) ----

    internal static string? Str(Dictionary<string, JsonElement> args, string key)
        => args.TryGetValue(key, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() : null;

    internal static int? Int(Dictionary<string, JsonElement> args, string key)
        => args.TryGetValue(key, out var v) && v.ValueKind == JsonValueKind.Number && v.TryGetInt32(out var i) ? i : null;

    internal static long? Long(Dictionary<string, JsonElement> args, string key)
        => args.TryGetValue(key, out var v) && v.ValueKind == JsonValueKind.Number && v.TryGetInt64(out var i) ? i : null;

    internal static bool? Bool(Dictionary<string, JsonElement> args, string key)
        => args.TryGetValue(key, out var v)
            ? v.ValueKind switch { JsonValueKind.True => true, JsonValueKind.False => false, _ => null }
            : null;
}
