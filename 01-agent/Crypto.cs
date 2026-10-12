using System.Security.Cryptography;
using System.Text;

namespace Rdsh;

/// <summary>RFC 6238 TOTP and the request-signing primitives shared by both ends.</summary>
public static class Crypto
{
    private const string B32Alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

    public static string ToBase32(byte[] data)
    {
        var sb = new StringBuilder((data.Length * 8 + 4) / 5);
        int bits = 0, value = 0;
        foreach (var b in data)
        {
            value = (value << 8) | b;
            bits += 8;
            while (bits >= 5)
            {
                sb.Append(B32Alphabet[(value >> (bits - 5)) & 31]);
                bits -= 5;
            }
        }
        if (bits > 0) sb.Append(B32Alphabet[(value << (5 - bits)) & 31]);
        return sb.ToString();
    }

    public static byte[] FromBase32(string s)
    {
        var outBytes = new List<byte>(s.Length * 5 / 8);
        int bits = 0, value = 0;
        foreach (var c in s.Trim().TrimEnd('=').ToUpperInvariant())
        {
            var idx = B32Alphabet.IndexOf(c);
            if (idx < 0) continue;
            value = (value << 5) | idx;
            bits += 5;
            if (bits >= 8)
            {
                outBytes.Add((byte)((value >> (bits - 8)) & 0xFF));
                bits -= 8;
            }
        }
        return outBytes.ToArray();
    }

    /// <summary>RFC 6238 TOTP over a base32 secret.</summary>
    public static string Totp(string base32Secret, long unixSeconds, int period = 30, int digits = 6)
    {
        var counter = unixSeconds / period;
        Span<byte> msg = stackalloc byte[8];
        for (var i = 7; i >= 0; i--)
        {
            msg[i] = (byte)(counter & 0xFF);
            counter >>= 8;
        }
        var key = FromBase32(base32Secret);
        using var hmac = new HMACSHA1(key);
        var hash = hmac.ComputeHash(msg.ToArray());
        var offset = hash[^1] & 0x0F;
        var code = ((hash[offset] & 0x7F) << 24) | (hash[offset + 1] << 16) | (hash[offset + 2] << 8) | hash[offset + 3];
        var mod = (int)Math.Pow(10, digits);
        return (code % mod).ToString().PadLeft(digits, '0');
    }

    /// <summary>Compare two secrets in constant time.</summary>
    public static bool FixedEquals(string a, string b)
    {
        var ba = Encoding.UTF8.GetBytes(a);
        var bb = Encoding.UTF8.GetBytes(b);
        return ba.Length == bb.Length && CryptographicOperations.FixedTimeEquals(ba, bb);
    }

    /// <summary>Verify a TOTP code allowing +/- <paramref name="window"/> steps of clock drift.</summary>
    public static bool VerifyTotp(string secret, string code, long nowSeconds, int window = 1)
    {
        code = code.Trim();
        if (code.Length == 0) return false;
        // Walk whole steps so only identical-length codes are compared per step.
        for (var step = -window; step <= window; step++)
        {
            var candidate = Totp(secret, nowSeconds + step * 30L);
            if (FixedEquals(candidate, code)) return true;
        }
        return false;
    }

    public static string Sha256Hex(byte[] data) => Convert.ToHexString(SHA256.HashData(data)).ToLowerInvariant();

    public static string HmacBase64Url(string secret, string message)
    {
        using var hmac = new HMACSHA256(Encoding.UTF8.GetBytes(secret));
        return Base64Url(hmac.ComputeHash(Encoding.UTF8.GetBytes(message)));
    }

    /// <summary>Canonical signature string: method, path, timestamp, nonce, body hash.</summary>
    public static string Canonical(string method, string path, string ts, string nonce, string bodySha256Hex)
        => string.Join('\n', method.ToUpperInvariant(), path, ts, nonce, bodySha256Hex);

    public static string Sign(string secret, string method, string path, string ts, string nonce, string body)
        => HmacBase64Url(secret, Canonical(method, path, ts, nonce, Sha256Hex(Encoding.UTF8.GetBytes(body))));

    public static string Base64Url(byte[] data)
        => Convert.ToBase64String(data).TrimEnd('=').Replace('+', '-').Replace('/', '_');

    public static byte[] FromBase64Url(string s)
    {
        var t = s.Replace('-', '+').Replace('_', '/');
        return Convert.FromBase64String(t.PadRight((t.Length + 3) / 4 * 4, '='));
    }

    public static string RandomSecret(int bytes = 32) => ToBase32(RandomNumberGenerator.GetBytes(bytes));

    public static string RandomHex(int bytes = 16) => Convert.ToHexString(RandomNumberGenerator.GetBytes(bytes)).ToLowerInvariant();
}
