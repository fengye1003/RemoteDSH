using System.Text;

namespace Rdsh;

/// <summary>
/// Detects the encoding that command output actually uses on this machine.
///
/// This cannot be read from <c>Console.OutputEncoding</c>: when a child process
/// has no console of its own (the agent always redirects its stdio), Windows
/// falls back to the system ANSI/OEM code page for that child, which is often
/// NOT the code page the agent itself is using. Decoding with the wrong one
/// turns every non-ASCII byte into U+FFFD.
///
/// So the active code page is measured by running <c>chcp.com</c>, which reports
/// it in pure ASCII, and the answer is cached for the process lifetime. When the
/// measurement or the lookup fails, UTF-8 is the fallback: the agent's own text
/// paths are UTF-8, and a wrong guess here only affects exotic locales.
/// </summary>
public static class ConsoleText
{
    private static Encoding? _childOutput;
    private static readonly object Gate = new();

    /// <summary>Encoding for redirected child-process stdio.</summary>
    public static Encoding ChildOutput
    {
        get
        {
            lock (Gate)
            {
                return _childOutput ??= Detect();
            }
        }
    }

    /// <summary>Code page reported by chcp, or 0 when it could not be measured.</summary>
    public static int DetectedCodePage { get; private set; }

    private static bool _providerRegistered;

    private static Encoding Detect()
    {
        if (!OperatingSystem.IsWindows()) return new UTF8Encoding(false);

        // .NET Core ships only Unicode encodings; the legacy code pages arrive
        // through this provider. Registering is idempotent and cheap.
        if (!_providerRegistered)
        {
            try
            {
                Encoding.RegisterProvider(CodePagesEncodingProvider.Instance);
            }
            catch
            {
                // Provider unavailable: we fall back to UTF-8 below.
            }
            _providerRegistered = true;
        }

        var codePage = RunChcp();
        DetectedCodePage = codePage;
        if (codePage <= 0 || codePage == 65001) return new UTF8Encoding(false);

        try
        {
            return Encoding.GetEncoding(codePage, EncoderFallback.ReplacementFallback, DecoderFallback.ReplacementFallback);
        }
        catch
        {
            // The code page is unavailable in this runtime; UTF-8 remains the best
            // default because the transport itself is UTF-8 end to end.
            return new UTF8Encoding(false);
        }
    }

    private static int RunChcp()
    {
        try
        {
            var psi = new System.Diagnostics.ProcessStartInfo
            {
                FileName = "chcp.com",
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
                CreateNoWindow = true,
            };
            using var proc = System.Diagnostics.Process.Start(psi);
            if (proc is null) return 0;
            var text = proc.StandardOutput.ReadToEnd();
            proc.WaitForExit(3000);

            // "Active code page: 936" — localized prefix, ASCII digits.
            var digits = new StringBuilder();
            foreach (var ch in text)
            {
                if (char.IsAsciiDigit(ch)) digits.Append(ch);
                else if (digits.Length > 0) break;
            }
            return digits.Length > 0 && int.TryParse(digits.ToString(), out var value) ? value : 0;
        }
        catch
        {
            return 0;
        }
    }
}
