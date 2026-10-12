using System.Text;
using System.Text.Json;

namespace Rdsh;

public static class Program
{
    private static readonly CancellationTokenSource Shutdown = new();

    public static async Task<int> Main(string[] rawArgs)
    {
        // Setting the console encoding throws when stdout is redirected (a pipe or
        // a file), so it must never be allowed to take the agent down.
        try
        {
            // The agent's own text is UTF-8; child-process stdio uses a detected
            // code page, see ConsoleText.
            Console.OutputEncoding = Encoding.UTF8;
        }
        catch
        {
            // Output stays in the platform default encoding; nothing else changes.
        }

        var opts = Cli.Parse(rawArgs);
        if (opts.ShowHelp)
        {
            Cli.PrintHelp();
            return 0;
        }

        if (opts.Reset)
        {
            var old = Config.ConfigPath;
            if (File.Exists(old))
            {
                File.Move(old, old + ".bak-" + DateTimeOffset.UtcNow.ToUnixTimeSeconds(), overwrite: true);
                Console.WriteLine($"[rdsh] previous identity archived: {old}.bak-*");
            }
        }

        var cfg = Config.Load();
        if (opts.Relay is not null) cfg.Relay = opts.Relay;
        if (opts.Name is not null) cfg.Name = opts.Name;
        if (opts.Bind is not null) cfg.Bind = opts.Bind;
        if (opts.Port is not null) cfg.Port = opts.Port.Value;
        Config.Save(cfg);

        var nonces = new NonceCache();
        var dispatcher = new Dispatcher { AgentId = cfg.Id };
        var auth = new Authenticator(cfg.Secret, nonces);
        var tunnelState = new TunnelState();

        // Direct-listen leg (mode B). Off when --no-listen is passed.
        HttpServer? server = null;
        if (!opts.NoListen)
        {
            try
            {
                server = new HttpServer(dispatcher, auth, cfg.Id);
                server.Start(cfg.Bind, cfg.Port);
            }
            catch (Exception ex)
            {
                Console.Error.WriteLine($"[rdsh] direct listener unavailable: {ex.GetType().Name}: {ex.Message}");
                server = null;
            }
        }

        dispatcher.OnDisconnectRequested = () =>
        {
            Console.WriteLine("[rdsh] controller requested disconnect; closing transports");
            Shutdown.Cancel();
        };

        // Reverse leg (mode A). Preferred whenever a relay is known or discoverable.
        var relay = opts.Relay ?? cfg.Relay ?? (opts.NoDiscover ? null : await Probe.DiscoverRelay(cfg.Secret, cfg.Id));
        if (opts.NoTunnel) relay = null;

        Banner(cfg, server, relay, opts);
        if (opts.PrintPair || !opts.NoPair)
        {
            var payload = BuildPair(cfg, relay, server);
            var encoded = "DshAgent:" + Crypto.Base64Url(Encoding.UTF8.GetBytes(
                JsonSerializer.Serialize(payload, RdshJson.Default.PairPayload)));
            Console.WriteLine();
            if (opts.EmitPair is not null)
            {
                File.WriteAllText(opts.EmitPair, encoded, new UTF8Encoding(false));
                Console.WriteLine($"[rdsh] pairing string written to {opts.EmitPair}");
            }
            Console.WriteLine("  pairing string (hand this whole line to the controller):");
            Console.WriteLine();
            Console.WriteLine("  " + encoded);
            Console.WriteLine();
            Console.WriteLine("  current TOTP (30s, also usable for pairing): " + Crypto.Totp(cfg.Secret, DateTimeOffset.UtcNow.ToUnixTimeSeconds()));
            Console.WriteLine();
        }

        if (opts.Once)
        {
            server?.Stop();
            return 0;
        }

        if (relay is not null)
        {
            Console.WriteLine($"[rdsh] reverse mode: dialing out to {relay} (no inbound port needed)");
        }
        else if (server is not null)
        {
            Console.WriteLine($"[rdsh] direct mode only: {server.BaseUrl}  (no relay configured or reachable)");
            Console.WriteLine("[rdsh] the controller must be able to reach this address; pass --relay <url> to use reverse mode");
        }
        else
        {
            Console.Error.WriteLine("[rdsh] no transport available (listener failed and no relay). Nothing to do.");
            return 2;
        }

        if (server is not null && relay is null)
        {
            Console.WriteLine($"[rdsh] hint: this machine is the target; the controller pairs with the string above.");
        }

        using var reg = new Registration();
        Console.CancelKeyPress += (_, e) =>
        {
            e.Cancel = true;
            Console.WriteLine("\n[rdsh] shutting down (audit log kept at " + Config.AuditPath + ")");
            Shutdown.Cancel();
        };

        // Status panel + heartbeat: the visible "a remote controller is connected" indicator.
        var panel = PanelAsync(dispatcher, tunnelState, server, cfg, Shutdown.Token);

        if (relay is not null)
        {
            var tunnel = new Tunnel(dispatcher, cfg.Id, cfg.Secret, tunnelState);
            var tunnelTask = tunnel.RunAsync(relay, Shutdown.Token);
            await Task.WhenAny(tunnelTask, panel);
        }
        else
        {
            await panel;
        }

        server?.Stop();
        Console.WriteLine("[rdsh] stopped.");
        return 0;
    }

    private static PairPayload BuildPair(AgentConfig cfg, string? relay, HttpServer? server) => new()
    {
        V = 1,
        Id = cfg.Id,
        Url = relay,
        Sec = cfg.Secret,
        Host = Environment.MachineName,
        Os = OperatingSystem.IsWindows() ? "windows" : OperatingSystem.IsLinux() ? "linux" : "macos",
        Arch = System.Runtime.InteropServices.RuntimeInformation.ProcessArchitecture.ToString().ToLowerInvariant(),
        Listen = server?.BaseUrl,
        Ver = Version.Full,
    };

    private static void Banner(AgentConfig cfg, HttpServer? server, string? relay, Cli opts)
    {
        Console.WriteLine("RemoteDSH agent " + Version.Full);
        Console.WriteLine("  device    : " + cfg.Id + "  (" + (cfg.Name ?? Environment.MachineName) + ")");
        Console.WriteLine("  config    : " + Config.ConfigPath);
        Console.WriteLine("  audit log : " + Config.AuditPath);
        Console.WriteLine("  direct    : " + (server?.BaseUrl ?? "(disabled)"));
        Console.WriteLine("  reverse   : " + (relay ?? "(none)"));
        Console.WriteLine("  flavor    : " + Version.Flavor + (Version.EmbedsNode ? " (ships a Node runtime)" : " (uses an installed node, if any)"));
        Console.WriteLine("  node      : " + (NodeRuntime.Path is null ? "(none found - the `node` method is unavailable)" : NodeRuntime.Path + "  [" + NodeRuntime.Source + "]"));
    }

    private static async Task PanelAsync(Dispatcher dispatcher, TunnelState state, HttpServer? server, AgentConfig cfg, CancellationToken ct)
    {
        while (!ct.IsCancellationRequested)
        {
            try
            {
                await Task.Delay(5000, ct);
            }
            catch (OperationCanceledException)
            {
                break;
            }

            var jobs = dispatcher.Jobs.List();
            var running = jobs.Count(j => j.Running);
            var connected = state.Connected;
            var line = new StringBuilder();
            line.Append(connected ? "[CONNECTED] " : "[waiting]   ");
            line.Append(connected && state.Relay is not null ? "remote controller attached via " + state.Relay : "no controller attached");
            line.Append("  |  jobs running: ").Append(running);
            line.Append("  |  requests: ").Append(state.RequestsHandled);
            if (state.Reconnects > 0) line.Append("  |  reconnects: ").Append(state.Reconnects);
            if (!connected && state.LastError.Length > 0) line.Append("  |  last error: ").Append(state.LastError);
            Console.WriteLine(line.ToString());
        }
    }
}

/// <summary>Ensures one agent per machine does not fight itself for the same config.</summary>
public sealed class Registration : IDisposable
{
    private FileStream? _lock;

    public Registration()
    {
        try
        {
            Directory.CreateDirectory(Config.HomeDir);
            _lock = new FileStream(Path.Combine(Config.HomeDir, "agent.lock"), FileMode.OpenOrCreate, FileAccess.ReadWrite, FileShare.None);
        }
        catch
        {
            // A second instance is a warning, not a fatal error.
        }
    }

    public void Dispose()
    {
        try { _lock?.Dispose(); } catch { /* ignored */ }
    }
}

/// <summary>CLI surface.</summary>
public sealed class Cli
{
    public string? Relay;
    public string? Name;
    public string? Bind;
    public int? Port;
    public bool NoListen;
    public bool NoTunnel;
    public bool NoDiscover;
    public bool Reset;
    public bool ShowHelp;
    public bool NoPair;
    public bool PrintPair;
    public string? EmitPair;
    public bool Once;

    public static Cli Parse(string[] args)
    {
        var cli = new Cli();
        for (var i = 0; i < args.Length; i++)
        {
            var a = args[i];
            string? Next() => i + 1 < args.Length ? args[++i] : null;
            switch (a)
            {
                case "--relay": cli.Relay = Next(); break;
                case "--name": cli.Name = Next(); break;
                case "--listen": cli.Bind = Next(); break;
                case "--port":
                    if (int.TryParse(Next(), out var p)) cli.Port = p;
                    break;
                case "--no-listen": cli.NoListen = true; break;
                case "--no-tunnel": cli.NoTunnel = true; break;
                case "--no-discover": cli.NoDiscover = true; break;
                case "--reset": cli.Reset = true; break;
                case "--pair": cli.PrintPair = true; break;
                case "--emit-pair": cli.EmitPair = Next(); break;
                case "--once": cli.Once = true; break;
                case "--no-pair": cli.NoPair = true; break;
                case "-h" or "--help" or "/?": cli.ShowHelp = true; break;
                default:
                    Console.Error.WriteLine($"[rdsh] unknown argument: {a}");
                    cli.ShowHelp = true;
                    break;
            }
        }
        return cli;
    }

    public static void PrintHelp()
    {
        Console.WriteLine("""
RemoteDSH agent 鈥?lets a DSH harness operate this machine remotely.

Usage:
  rdsh [options]

Options:
  --relay <url>     DSH relay base URL, e.g. http://your-harness.local:8088
                    When set (or discovered) the agent dials OUT and needs no
                    inbound port at all.
  --listen <ip>     Bind address for the direct HTTP listener (default 127.0.0.1).
                    Use 0.0.0.0 only when you deliberately want LAN exposure.
  --port <n>        Direct listener port (default: a free port).
  --name <label>    Friendly device name shown to the controller.
  --no-listen       Disable the direct listener entirely (reverse mode only).
  --no-tunnel       Disable the reverse connection (direct listener only).
  --no-discover     Do not probe local networks for a DSH relay.
  --pair            Print the pairing string and QR code (on by default).
  --no-pair         Suppress the pairing banner.
  --emit-pair <f>   Also write the pairing string to a file (scripting).
  --once            Print identity/pairing and exit (diagnostics, CI).
  --reset           Archive the current identity and generate a new one.
  -h, --help        Show this help.

First run creates an identity under ~/.rdsh/agent.json and prints a pairing
string. Give that string (or the QR code) to the controller once; from then on
the controller signs every request with the same secret.
""");
    }
}
