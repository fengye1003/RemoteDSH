using System.Text.Json;
using System.Text.Json.Serialization;

namespace Rdsh;

/// <summary>On-disk agent configuration. Created on first run; the secret never leaves this machine.</summary>
public sealed class AgentConfig
{
    public int V { get; set; } = 1;
    public string Id { get; set; } = "";
    public string Secret { get; set; } = "";
    /// <summary>Optional DSH relay, e.g. http://your-harness.local:8088 or http://192.0.2.10:8088.</summary>
    public string? Relay { get; set; }
    /// <summary>Direct-listen port; 0 asks the OS for a free one.</summary>
    public int Port { get; set; } = 0;
    /// <summary>Direct-listen bind address. Loopback by default; "--listen 0.0.0.0" opts into LAN exposure.</summary>
    public string Bind { get; set; } = "127.0.0.1";
    public string? Name { get; set; }
    public int CreatedAt { get; set; }
}

/// <summary>Configuration persistence and first-run key generation.</summary>
public static class Config
{
    public static string HomeDir =>
        Environment.GetEnvironmentVariable("RDSH_HOME")
        ?? Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),
            ".rdsh");

    public static string ConfigPath => Path.Combine(HomeDir, "agent.json");
    public static string AuditPath => Path.Combine(HomeDir, "audit.log");

    public static AgentConfig Load()
    {
        Directory.CreateDirectory(HomeDir);
        if (File.Exists(ConfigPath))
        {
            try
            {
                var text = File.ReadAllText(ConfigPath);
                var cfg = JsonSerializer.Deserialize(text, RdshJson.Default.AgentConfig);
                if (cfg is not null && cfg.Id.Length > 0 && cfg.Secret.Length > 0) return cfg;
            }
            catch (Exception ex)
            {
                Console.Error.WriteLine($"[rdsh] config unreadable ({ex.GetType().Name}); generating a fresh identity");
            }
        }

        var fresh = new AgentConfig
        {
            Id = Guid.NewGuid().ToString("N")[..12],
            Secret = Crypto.RandomSecret(32),
            Name = Environment.MachineName,
            CreatedAt = (int)DateTimeOffset.UtcNow.ToUnixTimeSeconds(),
        };
        Save(fresh);
        return fresh;
    }

    public static void Save(AgentConfig cfg)
    {
        Directory.CreateDirectory(HomeDir);
        var json = JsonSerializer.Serialize(cfg, RdshJson.Default.AgentConfig);
        var tmp = ConfigPath + ".tmp";
        File.WriteAllText(tmp, json);
        File.Move(tmp, ConfigPath, overwrite: true);
        TryTighten(ConfigPath);
    }

    private static void TryTighten(string path)
    {
        if (OperatingSystem.IsWindows()) return;
        try
        {
            File.SetUnixFileMode(path, UnixFileMode.UserRead | UnixFileMode.UserWrite);
        }
        catch
        {
            // Best effort: a filesystem without unix modes must not break startup.
        }
    }
}

/// <summary>AOT-friendly JSON context. Every type crossing the wire is declared here.</summary>
[JsonSourceGenerationOptions(WriteIndented = false, PropertyNamingPolicy = JsonKnownNamingPolicy.CamelCase, DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull)]
[JsonSerializable(typeof(AgentConfig))]
[JsonSerializable(typeof(PairPayload))]
[JsonSerializable(typeof(RpcReply))]
[JsonSerializable(typeof(SimpleReply))]
[JsonSerializable(typeof(HelloResult))]
[JsonSerializable(typeof(ExecResult))]
[JsonSerializable(typeof(PollResult))]
[JsonSerializable(typeof(StatResult))]
[JsonSerializable(typeof(LsResult))]
[JsonSerializable(typeof(JobInfo))]
[JsonSerializable(typeof(JobListResult))]
[JsonSerializable(typeof(WriteResult))]
[JsonSerializable(typeof(OkResult))]
[JsonSerializable(typeof(ReadResult))]
[JsonSerializable(typeof(Dictionary<string, JsonElement>))]
[JsonSerializable(typeof(Dictionary<string, string>))]
internal partial class RdshJson : JsonSerializerContext;
