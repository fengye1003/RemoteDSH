using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace Rdsh;

// ---- wire DTOs -------------------------------------------------------------

/// <summary>Payload encoded inside a `DshAgent:` pairing string.</summary>
public sealed class PairPayload
{
    public int V { get; set; } = 1;
    public string Id { get; set; } = "";
    /// <summary>Relay base URL when reverse mode is active.</summary>
    public string? Url { get; set; }
    public string Sec { get; set; } = "";
    public string? Host { get; set; }
    public string? Os { get; set; }
    public string? Arch { get; set; }
    /// <summary>Direct-listen base URL when direct mode is active.</summary>
    public string? Listen { get; set; }
    public string? Ver { get; set; }
}

public sealed class HelloResult
{
    public string Id { get; set; } = "";
    public string Host { get; set; } = "";
    public string Os { get; set; } = "";
    public string Arch { get; set; } = "";
    public string Ver { get; set; } = "";
    public string User { get; set; } = "";
    public int Pid { get; set; }
    public bool Node { get; set; }
    public string? NodePath { get; set; }
    /// <summary>Where the Node runtime came from: embedded / beside the binary / PATH.</summary>
    public string? NodeSource { get; set; }
    /// <summary>Build flavor of this agent: "full" (ships Node) or "slim".</summary>
    public string Flavor { get; set; } = "";
    /// <summary>Encoding used to decode child-process output, and the code page behind it.</summary>
    public string ChildEncoding { get; set; } = "";
    public int ChildCodePage { get; set; }
    public string[] Caps { get; set; } = Array.Empty<string>();
}

public sealed class ExecResult
{
    public string RunId { get; set; } = "";
    public int Pid { get; set; }
}

public sealed class ReadResult
{
    public string Path { get; set; } = "";
    public long Offset { get; set; }
    public long Length { get; set; }
    public bool Eof { get; set; }
    public string? Text { get; set; }
    public string? Base64 { get; set; }
}

public sealed class WriteResult
{
    public string Path { get; set; } = "";
    public long Bytes { get; set; }
}

public sealed class OkResult
{
    public bool Ok { get; set; } = true;
    public string? Detail { get; set; }
}

public sealed class StatResult
{
    public string Path { get; set; } = "";
    public bool Exists { get; set; }
    public string? Kind { get; set; }
    public long Size { get; set; }
    public long MtimeMs { get; set; }
    public bool IsDir { get; set; }
}

public sealed class LsEntry
{
    public string Name { get; set; } = "";
    public bool IsDir { get; set; }
    public long Size { get; set; }
    public long MtimeMs { get; set; }
}

public sealed class LsResult
{
    public string Path { get; set; } = "";
    public LsEntry[] Entries { get; set; } = Array.Empty<LsEntry>();
}

public sealed class PollResult
{
    /// <summary>stdout bytes produced since the caller's last poll, as UTF-8 text.</summary>
    public string Out { get; set; } = "";
    /// <summary>stderr bytes produced since the caller's last poll, as UTF-8 text.</summary>
    public string Err { get; set; } = "";
    public int ExitCode { get; set; }
    public bool Done { get; set; }
    public bool TimedOut { get; set; }
    public bool Truncated { get; set; }
    public long ElapsedMs { get; set; }
}

public sealed class JobInfo
{
    public string Id { get; set; } = "";
    public string Label { get; set; } = "";
    public string Command { get; set; } = "";
    public bool Running { get; set; }
    public int ExitCode { get; set; }
    public long StartedMs { get; set; }
    public long ElapsedMs { get; set; }
    public long OutBytes { get; set; }
    public long ErrBytes { get; set; }
    public bool Detached { get; set; }
    public string? Workdir { get; set; }
}

public sealed class JobListResult
{
    public JobInfo[] Jobs { get; set; } = Array.Empty<JobInfo>();
}

/// <summary>One RPC reply. `Ok=false` carries a machine-readable code and a message.</summary>
public sealed class RpcReply
{
    public bool Ok { get; set; }
    public string? Code { get; set; }
    public string? Error { get; set; }
    public JsonElement? Data { get; set; }

    /// <summary>
    /// Typed constructors. Each names its JsonTypeInfo explicitly: reflection
    /// lookups do not survive NativeAOT trimming, so there is deliberately no
    /// generic overload here.
    /// </summary>
    public static RpcReply FromHello(HelloResult value)
        => new() { Ok = true, Data = JsonSerializer.SerializeToElement(value, RdshJson.Default.HelloResult) };

    public static RpcReply FromExec(ExecResult value)
        => new() { Ok = true, Data = JsonSerializer.SerializeToElement(value, RdshJson.Default.ExecResult) };

    public static RpcReply FromPoll(PollResult value)
        => new() { Ok = true, Data = JsonSerializer.SerializeToElement(value, RdshJson.Default.PollResult) };

    public static RpcReply FromJobs(JobListResult value)
        => new() { Ok = true, Data = JsonSerializer.SerializeToElement(value, RdshJson.Default.JobListResult) };

    public static RpcReply FromRead(ReadResult value)
        => new() { Ok = true, Data = JsonSerializer.SerializeToElement(value, RdshJson.Default.ReadResult) };

    public static RpcReply FromWrite(WriteResult value)
        => new() { Ok = true, Data = JsonSerializer.SerializeToElement(value, RdshJson.Default.WriteResult) };

    public static RpcReply FromLs(LsResult value)
        => new() { Ok = true, Data = JsonSerializer.SerializeToElement(value, RdshJson.Default.LsResult) };

    public static RpcReply FromStat(StatResult value)
        => new() { Ok = true, Data = JsonSerializer.SerializeToElement(value, RdshJson.Default.StatResult) };

    public static RpcReply FromOk(OkResult value)
        => new() { Ok = true, Data = JsonSerializer.SerializeToElement(value, RdshJson.Default.OkResult) };

    public static RpcReply Bad(string code, string message)
        => new() { Ok = false, Code = code, Error = message };
}

// ---- job registry ----------------------------------------------------------

/// <summary>One running or finished command with bounded output capture.</summary>
public sealed class Job
{
    private readonly object _lock = new();
    private readonly List<byte> _stdout = new();
    private readonly List<byte> _stderr = new();
    private int _outRead, _errRead;
    private bool _truncated;
    private const int MaxBuffer = 8 * 1024 * 1024; // per stream, in memory

    public string Id { get; init; } = "";
    public string Label { get; init; } = "";
    public string Command { get; init; } = "";
    public string? Workdir { get; init; }
    public bool Detached { get; init; }
    public int TimeoutMs { get; init; }
    public long StartedMs { get; } = Environment.TickCount64;
    public int Pid { get; private set; }

    private System.Diagnostics.Process? _proc;
    public bool Running { get; private set; }
    public int ExitCode { get; private set; } = -1;
    public bool TimedOut { get; private set; }
    public bool Truncated { get { lock (_lock) return _truncated; } }
    public long ElapsedMs => Environment.TickCount64 - StartedMs;

    private static readonly UTF8Encoding Utf8 = new(encoderShouldEmitUTF8Identifier: false);

    public void Attach(System.Diagnostics.Process proc)
    {
        _proc = proc;
        Pid = proc.Id;
        Running = true;
        _ = PumpAsync(proc.StandardOutput.BaseStream, _stdout);
        _ = PumpAsync(proc.StandardError.BaseStream, _stderr);
        _ = WatchAsync(proc);
    }

    private async Task PumpAsync(Stream stream, List<byte> sink)
    {
        var buf = new byte[16 * 1024];
        try
        {
            while (true)
            {
                var n = await stream.ReadAsync(buf);
                if (n <= 0) break;
                lock (_lock)
                {
                    if (sink.Count < MaxBuffer)
                    {
                        var take = Math.Min(n, MaxBuffer - sink.Count);
                        sink.AddRange(buf.AsSpan(0, take));
                        if (take < n) _truncated = true;
                    }
                    else
                    {
                        _truncated = true;
                    }
                }
            }
        }
        catch
        {
            // Stream torn down by process exit or kill: nothing to report.
        }
    }

    private async Task WatchAsync(System.Diagnostics.Process proc)
    {
        if (TimeoutMs > 0)
        {
            using var cts = new CancellationTokenSource(TimeoutMs);
            try
            {
                await proc.WaitForExitAsync(cts.Token);
            }
            catch (OperationCanceledException)
            {
                TimedOut = true;
                TryKill();
            }
        }
        try
        {
            await proc.WaitForExitAsync();
        }
        catch
        {
            // ignored
        }
        // A detached job outlives its stdio; keep whatever was captured.
        ExitCode = SafeExit(proc);
        Running = false;
    }

    private static int SafeExit(System.Diagnostics.Process proc)
    {
        try { return proc.ExitCode; }
        catch { return -1; }
    }

    public bool TryKill()
    {
        try
        {
            if (_proc is { HasExited: false })
            {
                _proc.Kill(entireProcessTree: true);
                return true;
            }
        }
        catch
        {
            // ignored
        }
        return false;
    }

    /// <summary>Output produced since the previous poll.</summary>
    public (string Out, string Err) Drain()
    {
        lock (_lock)
        {
            var outText = ReadDelta(_stdout, ref _outRead);
            var errText = ReadDelta(_stderr, ref _errRead);
            return (outText, errText);
        }
    }

    private static string ReadDelta(List<byte> sink, ref int read)
    {
        if (read >= sink.Count) return "";
        var text = Utf8.GetString(sink.ToArray(), read, sink.Count - read);
        read = sink.Count;
        return text;
    }

    public JobInfo Info() => new()
    {
        Id = Id,
        Label = Label,
        Command = Command.Length > 400 ? Command[..400] : Command,
        Running = Running,
        ExitCode = Running ? -1 : ExitCode,
        StartedMs = StartedMs,
        ElapsedMs = ElapsedMs,
        OutBytes = _stdout.Count,
        ErrBytes = _stderr.Count,
        Detached = Detached,
        Workdir = Workdir,
    };
}

/// <summary>All jobs this agent ever started, kept in memory and pruned by age.</summary>
public sealed class JobRegistry
{
    private readonly Dictionary<string, Job> _jobs = new();
    private readonly object _lock = new();
    private const int KeepFinishedMs = 60 * 60 * 1000; // one hour of finished history

    public Job Start(string command, string? workdir, int timeoutMs, bool detached, string? label, string? shell)
    {
        var psi = Shell.Build(command, workdir, shell);
        return StartJob(command, workdir, timeoutMs, detached, label, psi);
    }

    /// <summary>
    /// Start a job from a program plus arguments rather than shell text — used by
    /// the `node` method, so no shell is involved and no quoting can be misread.
    /// </summary>
    public Job StartProcess(string fileName, IReadOnlyList<string> arguments, string? workdir, int timeoutMs, bool detached, string? label)
    {
        var psi = new System.Diagnostics.ProcessStartInfo
        {
            FileName = fileName,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            RedirectStandardInput = true,
            UseShellExecute = false,
            CreateNoWindow = true,
            StandardOutputEncoding = ConsoleText.ChildOutput,
            StandardErrorEncoding = ConsoleText.ChildOutput,
        };
        foreach (var a in arguments) psi.ArgumentList.Add(a);
        if (!string.IsNullOrWhiteSpace(workdir))
        {
            if (Directory.Exists(workdir)) psi.WorkingDirectory = workdir;
            else throw new DirectoryNotFoundException($"working directory not found: {workdir}");
        }

        var shown = arguments.Count == 0 ? fileName : fileName + " " + string.Join(' ', arguments);
        return StartJob(shown, workdir, timeoutMs, detached, label ?? Path.GetFileName(fileName), psi);
    }

    private Job StartJob(string command, string? workdir, int timeoutMs, bool detached, string? label, System.Diagnostics.ProcessStartInfo psi)
    {
        var id = Guid.NewGuid().ToString("N")[..12];
        var job = new Job
        {
            Id = id,
            Label = label ?? Shorten(command),
            Command = command,
            Workdir = workdir,
            Detached = detached,
            TimeoutMs = timeoutMs,
        };

        var proc = new System.Diagnostics.Process { StartInfo = psi, EnableRaisingEvents = true };
        proc.Start();
        job.Attach(proc);

        lock (_lock)
        {
            Prune();
            _jobs[id] = job;
        }
        return job;
    }

    public Job? Get(string id)
    {
        lock (_lock)
        {
            return _jobs.TryGetValue(id, out var job) ? job : null;
        }
    }

    public JobInfo[] List()
    {
        lock (_lock)
        {
            Prune();
            return _jobs.Values.Select(j => j.Info()).ToArray();
        }
    }

    public bool Kill(string id)
    {
        var job = Get(id);
        return job is not null && job.TryKill();
    }

    private static string Shorten(string command)
        => command.Length <= 60 ? command : command[..57] + "...";

    private void Prune()
    {
        var stale = _jobs.Values
            .Where(j => !j.Running && j.ElapsedMs > KeepFinishedMs)
            .Select(j => j.Id)
            .ToArray();
        foreach (var id in stale) _jobs.Remove(id);
    }
}

/// <summary>Shell invocation policy per platform.</summary>
public static class Shell
{
    public static System.Diagnostics.ProcessStartInfo Build(string command, string? workdir, string? shell)
    {
        var psi = new System.Diagnostics.ProcessStartInfo
        {
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            RedirectStandardInput = true,
            UseShellExecute = false,
            CreateNoWindow = true,
            // Without this, .NET decodes child output with the agent's own output
            // encoding (UTF-8), mangling every byte from the console code page.
            StandardOutputEncoding = ConsoleText.ChildOutput,
            StandardErrorEncoding = ConsoleText.ChildOutput,
        };

        if (OperatingSystem.IsWindows())
        {
            var chosen = shell?.ToLowerInvariant() switch
            {
                "pwsh" or "powershell" => "powershell.exe",
                _ => "cmd.exe",
            };
            psi.FileName = chosen;
            psi.Arguments = chosen == "cmd.exe" ? $"/d /s /c \"{command}\"" : $"-NoProfile -NonInteractive -Command \"{command}\"";
        }
        else
        {
            var chosen = shell?.ToLowerInvariant() switch
            {
                "bash" => "/bin/bash",
                "sh" or null or "" => "/bin/sh",
                _ => shell,
            };
            psi.FileName = chosen;
            psi.ArgumentList.Add("-c");
            psi.ArgumentList.Add(command);
        }

        if (!string.IsNullOrWhiteSpace(workdir))
        {
            if (Directory.Exists(workdir)) psi.WorkingDirectory = workdir;
            else throw new DirectoryNotFoundException($"working directory not found: {workdir}");
        }

        psi.Environment["RDSH_AGENT"] = "1";
        return psi;
    }
}
