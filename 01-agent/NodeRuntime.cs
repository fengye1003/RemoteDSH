using System.Diagnostics;

namespace Rdsh;

public static class Version
{
    public const string Full = "rdsh/0.1.0";

    /// <summary>True when this binary was built as the flavor that ships a Node runtime.</summary>
    public static bool EmbedsNode =>
#if EMBED_NODE
        true;
#else
        false;
#endif

    /// <summary>Human-readable build flavor: "full" (ships Node) or "slim".</summary>
    public static string Flavor => EmbedsNode ? "full" : "slim";
}

/// <summary>
/// Locates a Node runtime for the `node` RPC method, in priority order:
///
///  1. A runtime shipped in a `node/` folder next to the executable. This is what
///     the FULL flavor stages, so the target machine needs nothing installed.
///  2. A `node` binary placed directly beside the executable.
///  3. Whatever `node` is already on PATH — the SLIM flavor's only option. We
///     never install anything; we only use what is already on the machine.
///
/// When none of these exist the `node` RPC method fails with an explicit
/// `no_node_runtime` error rather than pretending the feature is unavailable for
/// some other reason.
/// </summary>
public static class NodeRuntime
{
    private static bool _probed;
    private static string? _path;
    private static string? _source;

    /// <summary>Absolute path of the Node runtime in use, or null when there is none.</summary>
    public static string? Path
    {
        get
        {
            if (!_probed) Probe();
            return _path;
        }
    }

    /// <summary>Where the runtime came from: "embedded", "beside the binary", "PATH", or null.</summary>
    public static string? Source
    {
        get
        {
            if (!_probed) Probe();
            return _source;
        }
    }

    public static bool Available => Path is not null;

    private static void Probe()
    {
        _probed = true;

        var exeDir = AppContext.BaseDirectory;
        var localName = OperatingSystem.IsWindows() ? "node.exe" : "node";

        var staged = System.IO.Path.Combine(exeDir, "node", localName);
        if (File.Exists(staged))
        {
            _path = staged;
            _source = "embedded";
            return;
        }

        var beside = System.IO.Path.Combine(exeDir, localName);
        if (File.Exists(beside))
        {
            _path = beside;
            _source = "beside the binary";
            return;
        }

        var onPath = Which("node");
        if (onPath is not null)
        {
            _path = onPath;
            _source = "PATH";
        }
    }

    /// <summary>Resolve an executable from PATH without shelling out.</summary>
    public static string? Which(string name)
    {
        var pathVar = Environment.GetEnvironmentVariable("PATH") ?? "";
        var exts = OperatingSystem.IsWindows()
            ? (Environment.GetEnvironmentVariable("PATHEXT") ?? ".EXE;.CMD;.BAT").Split(';', StringSplitOptions.RemoveEmptyEntries)
            : new[] { "" };

        foreach (var dir in pathVar.Split(System.IO.Path.PathSeparator, StringSplitOptions.RemoveEmptyEntries))
        {
            foreach (var ext in exts)
            {
                try
                {
                    var full = System.IO.Path.Combine(dir.Trim(), name + (OperatingSystem.IsWindows() && !name.EndsWith(ext, StringComparison.OrdinalIgnoreCase) ? ext.ToLowerInvariant() : ""));
                    if (File.Exists(full)) return full;
                }
                catch
                {
                    // Malformed PATH entries are common; skip them.
                }
            }
        }
        return null;
    }
}
