using System.Net;
using System.Net.NetworkInformation;
using System.Net.Sockets;
using System.Text.Json;

namespace Rdsh;

/// <summary>
/// Relay discovery. Reverse mode is only usable when the agent knows where the
/// DSH harness lives; rather than making the user type an address, we probe the
/// local subnet(s) for a reachable harness on the usual port.
/// </summary>
public static class Probe
{
    private static readonly int[] CandidatePorts = { 8088, 8080, 3000, 80 };

    /// <summary>
    /// Look for a DSH harness reachable from here. Returns a base URL such as
    /// http://192.0.2.10:8088, or null when nothing answers.
    /// </summary>
    public static async Task<string?> DiscoverRelay(string secret, string agentId, int perHostTimeoutMs = 250)
    {
        var self = LocalAddresses();
        var candidates = new List<string>();

        // Same machine first: the harness may be running right here.
        candidates.Add("127.0.0.1");

        // Then the local /24(s), which is where a LAN harness would be.
        foreach (var addr in self.Where(a => !IPAddress.IsLoopback(a)))
        {
            var bytes = addr.GetAddressBytes();
            if (bytes.Length != 4) continue;
            for (var host = 1; host <= 254; host++)
            {
                if (host == bytes[3]) continue;
                candidates.Add($"{bytes[0]}.{bytes[1]}.{bytes[2]}.{host}");
            }
        }

        foreach (var port in CandidatePorts)
        {
            var probe = await ProbeHosts(candidates, port, perHostTimeoutMs);
            if (probe is not null) return probe;
        }
        return null;
    }

    private static async Task<string?> ProbeHosts(List<string> hosts, int port, int timeoutMs)
    {
        // Fan out in small batches so discovery finishes fast without flooding.
        const int batch = 64;
        for (var i = 0; i < hosts.Count; i += batch)
        {
            var slice = hosts.Skip(i).Take(batch);
            var tasks = slice.Select(h => ProbeOne(h, port, timeoutMs)).ToArray();
            var results = await Task.WhenAll(tasks);
            var hit = results.FirstOrDefault(r => r is not null);
            if (hit is not null) return hit;
        }
        return null;
    }

    private static async Task<string?> ProbeOne(string host, int port, int timeoutMs)
    {
        try
        {
            using var tcp = new TcpClient();
            var connect = tcp.ConnectAsync(host, port);
            var done = await Task.WhenAny(connect, Task.Delay(timeoutMs));
            if (done != connect || !tcp.Connected) return null;

            using var http = new HttpClient { Timeout = TimeSpan.FromMilliseconds(timeoutMs * 4) };
            var resp = await http.GetAsync($"http://{host}:{port}/remote/ping");
            if (!resp.IsSuccessStatusCode) return null;
            var text = await resp.Content.ReadAsStringAsync();
            using var doc = JsonDocument.Parse(text);
            if (doc.RootElement.TryGetProperty("service", out var svc) && svc.GetString() == "dsh-remote")
            {
                return $"http://{host}:{port}";
            }
        }
        catch
        {
            // Unreachable host, refused port, TLS-only server: all just "not a relay".
        }
        return null;
    }

    /// <summary>Non-loopback IPv4 addresses of this machine.</summary>
    public static List<IPAddress> LocalAddresses()
    {
        var list = new List<IPAddress>();
        try
        {
            foreach (var nic in NetworkInterface.GetAllNetworkInterfaces())
            {
                if (nic.OperationalStatus != OperationalStatus.Up) continue;
                if (nic.NetworkInterfaceType == NetworkInterfaceType.Loopback) continue;
                foreach (var uni in nic.GetIPProperties().UnicastAddresses)
                {
                    if (uni.Address.AddressFamily == AddressFamily.InterNetwork) list.Add(uni.Address);
                }
            }
        }
        catch
        {
            // Fall back to the hostname lookup below.
        }

        if (list.Count == 0)
        {
            try
            {
                list.AddRange(Dns.GetHostAddresses(Dns.GetHostName())
                    .Where(a => a.AddressFamily == AddressFamily.InterNetwork && !IPAddress.IsLoopback(a)));
            }
            catch
            {
                // Nothing to probe with.
            }
        }
        return list;
    }
}
