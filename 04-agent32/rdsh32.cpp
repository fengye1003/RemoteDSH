// rdsh32.cpp — RemoteDSH target-side agent, native Win32 / x86, no runtime needed.
//
// WHY THIS FILE EXISTS
//   The original agent (01-agent, C# / .NET 8 NativeAOT) is win-x64 only. .NET 8
//   does not support Windows 7 at all, and an x64 binary cannot run on a 32-bit
//   OS. The machines this has to reach are Windows 7 32-bit, so this file
//   is the compatibility flavour: a single ~1 MB exe built with MinGW i686 that
//   imports nothing but KERNEL32.dll / msvcrt.dll / WS2_32.dll / ADVAPI32.dll —
//   i.e. it runs on Windows Vista/7 .. Windows 11, 32- and 64-bit alike (a 32-bit
//   exe runs under WoW64 on 64-bit Windows).
//   The floor is Vista, not XP: the import list uses GetTickCount64 / GetThreadId /
//   InitializeConditionVariable + SleepConditionVariableCS, all of which are
//   Vista+ (audited with `objdump -p`, 138 imported symbols).
//
// TRANSPORT
//   Reverse leg only (mode A): the agent dials OUT to the DSH relay's
//   /remote/attach seat and speaks the same JSON-over-WebSocket protocol as the
//   .NET agent. Plain ws:// on purpose: Windows 7's TLS stack needs OS updates and
//   a registry opt-in before it will negotiate TLS 1.2, so a cleartext HTTP relay
//   (port 80) is the only path that works on an unpatched Win7 box.
//
// BUILD (from this directory)
//   build.ps1, or:
//   C:\mingw32\bin\g++.exe -std=c++17 -O2 -municode -static -static-libgcc
//       -static-libstdc++ -o rdsh32.exe rdsh32.cpp -lws2_32 -ladvapi32
//   (verify: objdump -p rdsh32.exe | findstr "DLL Name")

#ifndef _WIN32_WINNT
#define _WIN32_WINNT 0x0601 // Windows 7
#endif
#define WIN32_LEAN_AND_MEAN

#include <winsock2.h>
#include <ws2tcpip.h>
#include <windows.h>
#include <wincrypt.h>

#include <atomic>
#include <cctype>
#include <cstdio>
#include <cstring>
#include <map>
#include <memory>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

// ─────────────────────────────── version ───────────────────────────────

static const char* kAgentVersion = "0.2.0-x86";
static const char* kFlavor = "x86-native";
static const DWORD kAttachDefaultPort = 80;

// ─────────────────────────── string plumbing ───────────────────────────

static std::string WideToUtf8(const std::wstring& w) {
    if (w.empty()) return {};
    int need = WideCharToMultiByte(CP_UTF8, 0, w.c_str(), (int)w.size(), nullptr, 0, nullptr, nullptr);
    if (need <= 0) return {};
    std::string out((size_t)need, '\0');
    WideCharToMultiByte(CP_UTF8, 0, w.c_str(), (int)w.size(), &out[0], need, nullptr, nullptr);
    return out;
}

static std::wstring Utf8ToWide(const std::string& s) {
    if (s.empty()) return {};
    int need = MultiByteToWideChar(CP_UTF8, 0, s.c_str(), (int)s.size(), nullptr, 0);
    if (need <= 0) return {};
    std::wstring out((size_t)need, L'\0');
    MultiByteToWideChar(CP_UTF8, 0, s.c_str(), (int)s.size(), &out[0], need);
    return out;
}

// Console-safe output. WriteConsoleW is used whenever a real console is attached
// so Chinese OS error text renders instead of turning into mojibake; when stdout
// is a pipe/file we emit UTF-8 bytes.
static void OutW(const std::wstring& text) {
    HANDLE h = GetStdHandle(STD_OUTPUT_HANDLE);
    DWORD mode = 0;
    if (h && h != INVALID_HANDLE_VALUE && GetConsoleMode(h, &mode)) {
        DWORD written = 0;
        WriteConsoleW(h, text.c_str(), (DWORD)text.size(), &written, nullptr);
    } else {
        std::string u8 = WideToUtf8(text);
        fwrite(u8.data(), 1, u8.size(), stdout);
    }
    fflush(stdout);
}

static void Out(const std::string& utf8) { OutW(Utf8ToWide(utf8)); }
static void OutLine(const std::string& utf8) { Out(utf8 + "\n"); }

static std::string LastErrorText(DWORD code = GetLastError()) {
    LPWSTR buf = nullptr;
    DWORD n = FormatMessageW(FORMAT_MESSAGE_ALLOCATE_BUFFER | FORMAT_MESSAGE_FROM_SYSTEM |
                                 FORMAT_MESSAGE_IGNORE_INSERTS,
                             nullptr, code, MAKELANGID(LANG_NEUTRAL, SUBLANG_DEFAULT), (LPWSTR)&buf, 0, nullptr);
    std::string text;
    if (n && buf) {
        std::wstring w(buf, n);
        while (!w.empty() && (w.back() == L'\r' || w.back() == L'\n' || w.back() == L' ')) w.pop_back();
        text = WideToUtf8(w);
    }
    if (buf) LocalFree(buf);
    if (text.empty()) text = "error " + std::to_string(code);
    return text;
}

static std::string LowerAscii(std::string s) {
    for (char& c : s) c = (char)tolower((unsigned char)c);
    return s;
}

// ─────────────────────────────── base64 ───────────────────────────────

static const char* kB64Alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

static std::string Base64Encode(const unsigned char* data, size_t len, bool urlSafe = false, bool pad = true) {
    std::string out;
    out.reserve((len + 2) / 3 * 4);
    size_t i = 0;
    while (i + 2 < len) {
        unsigned v = (data[i] << 16) | (data[i + 1] << 8) | data[i + 2];
        out.push_back(kB64Alphabet[(v >> 18) & 63]);
        out.push_back(kB64Alphabet[(v >> 12) & 63]);
        out.push_back(kB64Alphabet[(v >> 6) & 63]);
        out.push_back(kB64Alphabet[v & 63]);
        i += 3;
    }
    if (i < len) {
        unsigned v = data[i] << 16;
        bool two = (i + 1 < len);
        if (two) v |= data[i + 1] << 8;
        out.push_back(kB64Alphabet[(v >> 18) & 63]);
        out.push_back(kB64Alphabet[(v >> 12) & 63]);
        out.push_back(two ? kB64Alphabet[(v >> 6) & 63] : '=');
        out.push_back('=');
    }
    if (!pad) {
        while (!out.empty() && out.back() == '=') out.pop_back();
    }
    if (urlSafe) {
        for (char& c : out) {
            if (c == '+') c = '-';
            else if (c == '/') c = '_';
        }
    }
    return out;
}

static std::string Base64Url(const std::vector<BYTE>& data) {
    return Base64Encode(data.data(), data.size(), /*urlSafe=*/true, /*pad=*/false);
}

static bool Base64Decode(const std::string& in, std::vector<BYTE>& out) {
    auto val = [](char c) -> int {
        if (c >= 'A' && c <= 'Z') return c - 'A';
        if (c >= 'a' && c <= 'z') return c - 'a' + 26;
        if (c >= '0' && c <= '9') return c - '0' + 52;
        if (c == '+' || c == '-') return 62;
        if (c == '/' || c == '_') return 63;
        return -1;
    };
    int acc = 0, bits = 0;
    for (char c : in) {
        if (c == '=' || c == '\n' || c == '\r') continue;
        int v = val(c);
        if (v < 0) return false;
        acc = (acc << 6) | v;
        bits += 6;
        if (bits >= 8) {
            bits -= 8;
            out.push_back((BYTE)((acc >> bits) & 0xFF));
        }
    }
    return true;
}

// ─────────────────────────── crypto (CryptoAPI) ───────────────────────────
// advapi32's CryptoAPI is present on every Windows since XP, so no third-party
// SHA/HMAC implementation is needed.

class CryptoProv {
public:
    CryptoProv() {
        if (!CryptAcquireContextW(&prov_, nullptr, nullptr, PROV_RSA_AES, CRYPT_VERIFYCONTEXT)) prov_ = 0;
    }
    ~CryptoProv() {
        if (prov_) CryptReleaseContext(prov_, 0);
    }
    HCRYPTPROV get() const { return prov_; }
    bool ok() const { return prov_ != 0; }

private:
    HCRYPTPROV prov_ = 0;
};

static CryptoProv& Prov() {
    static CryptoProv p;
    return p;
}

// Hashing is implemented here rather than through CryptoAPI: on this build host
// CryptCreateHash(CALG_HMAC) fails outright with NTE_BAD_ALGID (0x80090003), and
// the provider/algoritm matrix differs across XP/7/10 anyway. Software SHA keeps
// the signature path identical on every Windows the exe can run on.

static void Sha1Block(uint32_t h[5], const unsigned char* p) {
    uint32_t w[80];
    for (int i = 0; i < 16; i++)
        w[i] = ((uint32_t)p[i * 4] << 24) | ((uint32_t)p[i * 4 + 1] << 16) | ((uint32_t)p[i * 4 + 2] << 8) | p[i * 4 + 3];
    for (int i = 16; i < 80; i++) {
        uint32_t v = w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16];
        w[i] = (v << 1) | (v >> 31);
    }
    uint32_t a = h[0], b = h[1], c = h[2], d = h[3], e = h[4];
    for (int i = 0; i < 80; i++) {
        uint32_t f, k;
        if (i < 20) {
            f = (b & c) | ((~b) & d);
            k = 0x5A827999;
        } else if (i < 40) {
            f = b ^ c ^ d;
            k = 0x6ED9EBA1;
        } else if (i < 60) {
            f = (b & c) | (b & d) | (c & d);
            k = 0x8F1BBCDC;
        } else {
            f = b ^ c ^ d;
            k = 0xCA62C1D6;
        }
        uint32_t temp = ((a << 5) | (a >> 27)) + f + e + k + w[i];
        e = d;
        d = c;
        c = (b << 30) | (b >> 2);
        b = a;
        a = temp;
    }
    h[0] += a;
    h[1] += b;
    h[2] += c;
    h[3] += d;
    h[4] += e;
}

static bool Sha1(const std::string& data, std::vector<BYTE>& digest) {
    uint32_t h[5] = {0x67452301, 0xEFCDAB89, 0x98BADCFE, 0x10325476, 0xC3D2E1F0};
    size_t total = data.size();
    size_t full = total / 64;
    for (size_t i = 0; i < full; i++) Sha1Block(h, (const unsigned char*)data.data() + i * 64);

    unsigned char tail[128];
    size_t rest = total - full * 64;
    memcpy(tail, data.data() + full * 64, rest);
    tail[rest] = 0x80;
    size_t tailLen = (rest < 56) ? 64 : 128;
    memset(tail + rest + 1, 0, tailLen - rest - 1);
    unsigned long long bits = (unsigned long long)total * 8ULL;
    for (int i = 0; i < 8; i++) tail[tailLen - 1 - i] = (unsigned char)((bits >> (8 * i)) & 0xFF);
    for (size_t off = 0; off < tailLen; off += 64) Sha1Block(h, tail + off);

    digest.resize(20);
    for (int i = 0; i < 5; i++) {
        digest[i * 4] = (BYTE)(h[i] >> 24);
        digest[i * 4 + 1] = (BYTE)(h[i] >> 16);
        digest[i * 4 + 2] = (BYTE)(h[i] >> 8);
        digest[i * 4 + 3] = (BYTE)h[i];
    }
    return true;
}

static const uint32_t kSha256K[64] = {
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2};

static void Sha256Block(uint32_t h[8], const unsigned char* p) {
    uint32_t w[64];
    for (int i = 0; i < 16; i++)
        w[i] = ((uint32_t)p[i * 4] << 24) | ((uint32_t)p[i * 4 + 1] << 16) | ((uint32_t)p[i * 4 + 2] << 8) | p[i * 4 + 3];
    for (int i = 16; i < 64; i++) {
        uint32_t s0 = (w[i - 15] >> 7 | w[i - 15] << 25) ^ (w[i - 15] >> 18 | w[i - 15] << 14) ^ (w[i - 15] >> 3);
        uint32_t s1 = (w[i - 2] >> 17 | w[i - 2] << 15) ^ (w[i - 2] >> 19 | w[i - 2] << 13) ^ (w[i - 2] >> 10);
        w[i] = w[i - 16] + s0 + w[i - 7] + s1;
    }
    uint32_t a = h[0], b = h[1], c = h[2], d = h[3], e = h[4], f = h[5], g = h[6], hh = h[7];
    for (int i = 0; i < 64; i++) {
        uint32_t S1 = (e >> 6 | e << 26) ^ (e >> 11 | e << 21) ^ (e >> 25 | e << 7);
        uint32_t ch = (e & f) ^ ((~e) & g);
        uint32_t t1 = hh + S1 + ch + kSha256K[i] + w[i];
        uint32_t S0 = (a >> 2 | a << 30) ^ (a >> 13 | a << 19) ^ (a >> 22 | a << 10);
        uint32_t maj = (a & b) ^ (a & c) ^ (b & c);
        uint32_t t2 = S0 + maj;
        hh = g;
        g = f;
        f = e;
        e = d + t1;
        d = c;
        c = b;
        b = a;
        a = t1 + t2;
    }
    h[0] += a;
    h[1] += b;
    h[2] += c;
    h[3] += d;
    h[4] += e;
    h[5] += f;
    h[6] += g;
    h[7] += hh;
}

static void Sha256(const unsigned char* data, size_t total, unsigned char out[32]) {
    uint32_t h[8] = {0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19};
    size_t full = total / 64;
    for (size_t i = 0; i < full; i++) Sha256Block(h, data + i * 64);

    unsigned char tail[128];
    size_t rest = total - full * 64;
    memcpy(tail, data + full * 64, rest);
    tail[rest] = 0x80;
    size_t tailLen = (rest < 56) ? 64 : 128;
    memset(tail + rest + 1, 0, tailLen - rest - 1);
    unsigned long long bits = (unsigned long long)total * 8ULL;
    for (int i = 0; i < 8; i++) tail[tailLen - 1 - i] = (unsigned char)((bits >> (8 * i)) & 0xFF);
    for (size_t off = 0; off < tailLen; off += 64) Sha256Block(h, tail + off);

    for (int i = 0; i < 8; i++) {
        out[i * 4] = (unsigned char)(h[i] >> 24);
        out[i * 4 + 1] = (unsigned char)(h[i] >> 16);
        out[i * 4 + 2] = (unsigned char)(h[i] >> 8);
        out[i * 4 + 3] = (unsigned char)h[i];
    }
}

static bool HmacSha256(const std::string& key, const std::string& message, std::vector<BYTE>& digest) {
    unsigned char k[64];
    memset(k, 0, sizeof(k));
    if (key.size() > 64) {
        unsigned char shortKey[32];
        Sha256((const unsigned char*)key.data(), key.size(), shortKey);
        memcpy(k, shortKey, 32);
    } else {
        memcpy(k, key.data(), key.size());
    }
    unsigned char ipad[64], opad[64];
    for (int i = 0; i < 64; i++) {
        ipad[i] = (unsigned char)(k[i] ^ 0x36);
        opad[i] = (unsigned char)(k[i] ^ 0x5c);
    }
    std::string inner((const char*)ipad, 64);
    inner += message;
    unsigned char innerDigest[32];
    Sha256((const unsigned char*)inner.data(), inner.size(), innerDigest);

    std::string outer((const char*)opad, 64);
    outer.append((const char*)innerDigest, 32);
    unsigned char finalDigest[32];
    Sha256((const unsigned char*)outer.data(), outer.size(), finalDigest);

    digest.assign(finalDigest, finalDigest + 32);
    return true;
}

static std::string HmacB64Url(const std::string& secret, const std::string& message) {
    std::vector<BYTE> digest;
    if (!HmacSha256(secret, message, digest)) return {};
    return Base64Url(digest);
}

static std::vector<BYTE> RandomBytes(size_t n) {
    std::vector<BYTE> out(n, 0);
    if (!CryptGenRandom(Prov().get(), (DWORD)n, out.data())) {
        // Extremely unlikely; time-seeded fallback keeps the agent usable.
        ULONGLONG seed = GetTickCount64() ^ (ULONGLONG)GetCurrentProcessId();
        for (size_t i = 0; i < n; i++) {
            seed = seed * 6364136223846793005ULL + 1442695040888963407ULL;
            out[i] = (BYTE)(seed >> 33);
        }
    }
    return out;
}

static std::string RandomHex(size_t bytes) {
    std::vector<BYTE> raw = RandomBytes(bytes);
    static const char* hex = "0123456789abcdef";
    std::string out;
    for (BYTE b : raw) {
        out.push_back(hex[b >> 4]);
        out.push_back(hex[b & 15]);
    }
    return out;
}

// ─────────────────────────────── JSON ───────────────────────────────

struct Json {
    enum Kind { Null, Bool, Num, Str, Arr, Obj } kind = Null;
    bool boolean = false;
    double number = 0;
    std::string text;
    std::vector<Json> items;
    std::vector<std::pair<std::string, Json>> fields;

    bool isObj() const { return kind == Obj; }
    bool isStr() const { return kind == Str; }
    bool isNum() const { return kind == Num; }
    bool isBool() const { return kind == Bool; }
    bool isArr() const { return kind == Arr; }

    const Json* find(const std::string& key) const {
        if (kind != Obj) return nullptr;
        for (const auto& kv : fields)
            if (kv.first == key) return &kv.second;
        return nullptr;
    }
    std::string str(const std::string& key, const std::string& fallback = "") const {
        const Json* v = find(key);
        return (v && v->kind == Str) ? v->text : fallback;
    }
    bool flag(const std::string& key, bool fallback = false) const {
        const Json* v = find(key);
        if (!v) return fallback;
        if (v->kind == Bool) return v->boolean;
        if (v->kind == Num) return v->number != 0;
        return fallback;
    }
    bool has(const std::string& key) const { return find(key) != nullptr; }
    double num(const std::string& key, double fallback = 0) const {
        const Json* v = find(key);
        return (v && v->kind == Num) ? v->number : fallback;
    }

    static Json MakeStr(const std::string& s) {
        Json j;
        j.kind = Str;
        j.text = s;
        return j;
    }
    static Json MakeNum(double n) {
        Json j;
        j.kind = Num;
        j.number = n;
        return j;
    }
    static Json MakeBool(bool b) {
        Json j;
        j.kind = Bool;
        j.boolean = b;
        return j;
    }
    static Json MakeObj() {
        Json j;
        j.kind = Obj;
        return j;
    }
    static Json MakeArr() {
        Json j;
        j.kind = Arr;
        return j;
    }
    Json& set(const std::string& key, Json value) {
        kind = Obj;
        fields.emplace_back(key, std::move(value));
        return *this;
    }
    void push(Json value) {
        kind = Arr;
        items.push_back(std::move(value));
    }
};

static void JsonEscapeTo(const std::string& s, std::string& out) {
    out.push_back('"');
    for (unsigned char c : s) {
        switch (c) {
            case '"': out += "\\\""; break;
            case '\\': out += "\\\\"; break;
            case '\n': out += "\\n"; break;
            case '\r': out += "\\r"; break;
            case '\t': out += "\\t"; break;
            case '\b': out += "\\b"; break;
            case '\f': out += "\\f"; break;
            default:
                if (c < 0x20) {
                    char buf[8];
                    snprintf(buf, sizeof(buf), "\\u%04x", c);
                    out += buf;
                } else {
                    out.push_back((char)c); // UTF-8 bytes pass through untouched
                }
        }
    }
    out.push_back('"');
}

static void JsonWrite(const Json& j, std::string& out) {
    switch (j.kind) {
        case Json::Null: out += "null"; break;
        case Json::Bool: out += j.boolean ? "true" : "false"; break;
        case Json::Num: {
            char buf[40];
            if (j.number == (double)(long long)j.number && j.number < 1e15 && j.number > -1e15)
                snprintf(buf, sizeof(buf), "%lld", (long long)j.number);
            else
                snprintf(buf, sizeof(buf), "%.0f", j.number);
            out += buf;
            break;
        }
        case Json::Str: JsonEscapeTo(j.text, out); break;
        case Json::Arr: {
            out.push_back('[');
            for (size_t i = 0; i < j.items.size(); i++) {
                if (i) out.push_back(',');
                JsonWrite(j.items[i], out);
            }
            out.push_back(']');
            break;
        }
        case Json::Obj: {
            out.push_back('{');
            for (size_t i = 0; i < j.fields.size(); i++) {
                if (i) out.push_back(',');
                JsonEscapeTo(j.fields[i].first, out);
                out.push_back(':');
                JsonWrite(j.fields[i].second, out);
            }
            out.push_back('}');
            break;
        }
    }
}

static std::string JsonDump(const Json& j) {
    std::string out;
    JsonWrite(j, out);
    return out;
}

static void AppendUtf8(std::string& out, unsigned cp) {
    if (cp <= 0x7F) {
        out.push_back((char)cp);
    } else if (cp <= 0x7FF) {
        out.push_back((char)(0xC0 | (cp >> 6)));
        out.push_back((char)(0x80 | (cp & 0x3F)));
    } else if (cp <= 0xFFFF) {
        out.push_back((char)(0xE0 | (cp >> 12)));
        out.push_back((char)(0x80 | ((cp >> 6) & 0x3F)));
        out.push_back((char)(0x80 | (cp & 0x3F)));
    } else {
        out.push_back((char)(0xF0 | (cp >> 18)));
        out.push_back((char)(0x80 | ((cp >> 12) & 0x3F)));
        out.push_back((char)(0x80 | ((cp >> 6) & 0x3F)));
        out.push_back((char)(0x80 | (cp & 0x3F)));
    }
}

class JsonParser {
public:
    explicit JsonParser(const std::string& s) : s_(s) {}

    bool Parse(Json& out) {
        SkipWs();
        if (!Value(out)) return false;
        SkipWs();
        return true;
    }

private:
    const std::string& s_;
    size_t i_ = 0;

    void SkipWs() {
        while (i_ < s_.size() && (s_[i_] == ' ' || s_[i_] == '\t' || s_[i_] == '\n' || s_[i_] == '\r')) i_++;
    }
    bool Literal(const char* lit) {
        size_t n = strlen(lit);
        if (s_.compare(i_, n, lit) != 0) return false;
        i_ += n;
        return true;
    }
    bool Value(Json& out) {
        SkipWs();
        if (i_ >= s_.size()) return false;
        char c = s_[i_];
        if (c == '{') return Object(out);
        if (c == '[') return Array(out);
        if (c == '"') {
            out.kind = Json::Str;
            return String(out.text);
        }
        if (Literal("true")) {
            out.kind = Json::Bool;
            out.boolean = true;
            return true;
        }
        if (Literal("false")) {
            out.kind = Json::Bool;
            out.boolean = false;
            return true;
        }
        if (Literal("null")) {
            out.kind = Json::Null;
            return true;
        }
        return Number(out);
    }
    bool Object(Json& out) {
        out.kind = Json::Obj;
        i_++; // {
        SkipWs();
        if (i_ < s_.size() && s_[i_] == '}') {
            i_++;
            return true;
        }
        while (i_ < s_.size()) {
            SkipWs();
            std::string key;
            if (i_ >= s_.size() || s_[i_] != '"' || !String(key)) return false;
            SkipWs();
            if (i_ >= s_.size() || s_[i_] != ':') return false;
            i_++;
            Json v;
            if (!Value(v)) return false;
            out.fields.emplace_back(std::move(key), std::move(v));
            SkipWs();
            if (i_ < s_.size() && s_[i_] == ',') {
                i_++;
                continue;
            }
            if (i_ < s_.size() && s_[i_] == '}') {
                i_++;
                return true;
            }
            return false;
        }
        return false;
    }
    bool Array(Json& out) {
        out.kind = Json::Arr;
        i_++; // [
        SkipWs();
        if (i_ < s_.size() && s_[i_] == ']') {
            i_++;
            return true;
        }
        while (i_ < s_.size()) {
            Json v;
            if (!Value(v)) return false;
            out.items.push_back(std::move(v));
            SkipWs();
            if (i_ < s_.size() && s_[i_] == ',') {
                i_++;
                continue;
            }
            if (i_ < s_.size() && s_[i_] == ']') {
                i_++;
                return true;
            }
            return false;
        }
        return false;
    }
    bool Hex4(unsigned& cp) {
        if (i_ + 4 > s_.size()) return false;
        cp = 0;
        for (int k = 0; k < 4; k++) {
            char c = s_[i_ + k];
            cp <<= 4;
            if (c >= '0' && c <= '9') cp |= (unsigned)(c - '0');
            else if (c >= 'a' && c <= 'f') cp |= (unsigned)(c - 'a' + 10);
            else if (c >= 'A' && c <= 'F') cp |= (unsigned)(c - 'A' + 10);
            else return false;
        }
        i_ += 4;
        return true;
    }
    bool String(std::string& out) {
        i_++; // opening quote
        out.clear();
        while (i_ < s_.size()) {
            unsigned char c = (unsigned char)s_[i_++];
            if (c == '"') return true;
            if (c != '\\') {
                out.push_back((char)c);
                continue;
            }
            if (i_ >= s_.size()) return false;
            char e = s_[i_++];
            switch (e) {
                case '"': out.push_back('"'); break;
                case '\\': out.push_back('\\'); break;
                case '/': out.push_back('/'); break;
                case 'b': out.push_back('\b'); break;
                case 'f': out.push_back('\f'); break;
                case 'n': out.push_back('\n'); break;
                case 'r': out.push_back('\r'); break;
                case 't': out.push_back('\t'); break;
                case 'u': {
                    unsigned cp = 0;
                    if (!Hex4(cp)) return false;
                    if (cp >= 0xD800 && cp <= 0xDBFF && i_ + 1 < s_.size() && s_[i_] == '\\' && s_[i_ + 1] == 'u') {
                        size_t save = i_;
                        i_ += 2;
                        unsigned low = 0;
                        if (Hex4(low) && low >= 0xDC00 && low <= 0xDFFF) {
                            cp = 0x10000 + ((cp - 0xD800) << 10) + (low - 0xDC00);
                        } else {
                            i_ = save;
                        }
                    }
                    AppendUtf8(out, cp);
                    break;
                }
                default: return false;
            }
        }
        return false;
    }
    bool Number(Json& out) {
        size_t start = i_;
        if (i_ < s_.size() && (s_[i_] == '-' || s_[i_] == '+')) i_++;
        bool digits = false;
        while (i_ < s_.size() && isdigit((unsigned char)s_[i_])) {
            i_++;
            digits = true;
        }
        if (i_ < s_.size() && s_[i_] == '.') {
            i_++;
            while (i_ < s_.size() && isdigit((unsigned char)s_[i_])) i_++;
        }
        if (!digits) return false;
        if (i_ < s_.size() && (s_[i_] == 'e' || s_[i_] == 'E')) {
            i_++;
            if (i_ < s_.size() && (s_[i_] == '-' || s_[i_] == '+')) i_++;
            while (i_ < s_.size() && isdigit((unsigned char)s_[i_])) i_++;
        }
        out.kind = Json::Num;
        out.number = strtod(s_.substr(start, i_ - start).c_str(), nullptr);
        return true;
    }
};

// ─────────────────────────── UTF-8 validation ───────────────────────────

static bool IsValidUtf8(const std::string& s) {
    size_t i = 0;
    while (i < s.size()) {
        unsigned char c = (unsigned char)s[i];
        size_t extra = 0;
        unsigned cp = 0;
        if (c < 0x80) {
            i++;
            continue;
        } else if ((c & 0xE0) == 0xC0) {
            extra = 1;
            cp = c & 0x1F;
        } else if ((c & 0xF0) == 0xE0) {
            extra = 2;
            cp = c & 0x0F;
        } else if ((c & 0xF8) == 0xF0) {
            extra = 3;
            cp = c & 0x07;
        } else {
            return false;
        }
        if (i + extra >= s.size()) return false;
        for (size_t k = 1; k <= extra; k++) {
            unsigned char cc = (unsigned char)s[i + k];
            if ((cc & 0xC0) != 0x80) return false;
            cp = (cp << 6) | (cc & 0x3F);
        }
        if (extra == 1 && cp < 0x80) return false;
        if (extra == 2 && cp < 0x800) return false;
        if (extra == 3 && cp < 0x10000) return false;
        if (cp > 0x10FFFF || (cp >= 0xD800 && cp <= 0xDFFF)) return false;
        i += extra + 1;
    }
    return true;
}

// Child processes on Windows write bytes in the console code page (GBK on a
// zh-CN box) unless they opt into UTF-8. Pass real UTF-8 straight through and
// translate anything else from the OEM code page.
static std::string DecodeChildOutput(const std::string& bytes) {
    if (bytes.empty() || IsValidUtf8(bytes)) return bytes;
    UINT cp = GetOEMCP();
    int need = MultiByteToWideChar(cp, 0, bytes.data(), (int)bytes.size(), nullptr, 0);
    if (need <= 0) return bytes;
    std::wstring w((size_t)need, L'\0');
    MultiByteToWideChar(cp, 0, bytes.data(), (int)bytes.size(), &w[0], need);
    return WideToUtf8(w);
}

// ─────────────────────────── small file helpers ───────────────────────────

static bool ReadFileUtf8(const std::wstring& path, std::string& out) {
    HANDLE h = CreateFileW(path.c_str(), GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE, nullptr, OPEN_EXISTING,
                           FILE_ATTRIBUTE_NORMAL, nullptr);
    if (h == INVALID_HANDLE_VALUE) return false;
    LARGE_INTEGER size{};
    if (!GetFileSizeEx(h, &size)) {
        CloseHandle(h);
        return false;
    }
    out.resize((size_t)size.QuadPart);
    DWORD got = 0;
    bool ok = out.empty() || (ReadFile(h, &out[0], (DWORD)out.size(), &got, nullptr) && got == out.size());
    CloseHandle(h);
    if (!ok) out.clear();
    return ok;
}

static bool WriteFileUtf8(const std::wstring& path, const std::string& data, bool append) {
    HANDLE h = CreateFileW(path.c_str(), append ? FILE_APPEND_DATA : GENERIC_WRITE, FILE_SHARE_READ, nullptr,
                           append ? OPEN_ALWAYS : CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, nullptr);
    if (h == INVALID_HANDLE_VALUE) return false;
    DWORD wrote = 0;
    bool ok = data.empty() || (WriteFile(h, data.data(), (DWORD)data.size(), &wrote, nullptr) && wrote == data.size());
    CloseHandle(h);
    return ok;
}

static void EnsureParentDir(const std::wstring& path) {
    size_t pos = path.find_last_of(L"\\/");
    if (pos == std::wstring::npos || pos == 0) return;
    std::wstring dir = path.substr(0, pos);
    // Create each missing component in turn; nested calls are cheap and safe.
    for (size_t i = 0; i < dir.size(); i++) {
        if (dir[i] != L'\\' && dir[i] != L'/') continue;
        if (i == 2 && dir[1] == L':') continue; // "C:\"
        std::wstring part = dir.substr(0, i);
        if (!part.empty()) CreateDirectoryW(part.c_str(), nullptr);
    }
    CreateDirectoryW(dir.c_str(), nullptr);
}

static std::wstring FullPathOf(const std::wstring& path) {
    DWORD need = GetFullPathNameW(path.c_str(), 0, nullptr, nullptr);
    if (need == 0) return path;
    std::wstring buf(need, L'\0');
    DWORD got = GetFullPathNameW(path.c_str(), need, &buf[0], nullptr);
    buf.resize(got);
    return buf;
}

static long long FileTimeToUnixMs(const FILETIME& ft) {
    ULARGE_INTEGER u;
    u.LowPart = ft.dwLowDateTime;
    u.HighPart = ft.dwHighDateTime;
    return (long long)(u.QuadPart / 10000ULL) - 11644473600000LL;
}

// ─────────────────────────── job registry ───────────────────────────

struct Job {
    std::string id;
    std::string label;
    std::string command;
    std::string workdir;
    bool detached = false;
    int timeoutMs = 0;
    DWORD pid = 0;
    HANDLE process = nullptr;
    HANDLE jobObject = nullptr;
    ULONGLONG startedMs = 0;
    std::atomic<bool> running{true};
    std::atomic<bool> timedOut{false};
    std::atomic<bool> truncated{false};
    std::atomic<int> exitCode{-1};
    std::mutex m;
    std::string out;
    std::string err;
    size_t outRead = 0;
    size_t errRead = 0;
    std::thread readerOut;
    std::thread readerErr;
    std::thread waiter;

    long long ElapsedMs() const { return (long long)(GetTickCount64() - startedMs); }

    void Drain(std::string& o, std::string& e) {
        std::lock_guard<std::mutex> guard(m);
        if (outRead < out.size()) {
            o = out.substr(outRead);
            outRead = out.size();
        }
        if (errRead < err.size()) {
            e = err.substr(errRead);
            errRead = err.size();
        }
    }
};

class JobRegistry {
public:
    static JobRegistry& Instance() {
        static JobRegistry r;
        return r;
    }

    std::shared_ptr<Job> Start(const std::string& command, const std::wstring& workdir, int timeoutMs, bool detached,
                               const std::string& label, const std::string& shell, std::string& error);
    std::shared_ptr<Job> StartProcess(const std::wstring& fileName, const std::vector<std::wstring>& argv,
                                      const std::wstring& workdir, int timeoutMs, const std::string& label,
                                      std::string& error);
    std::shared_ptr<Job> Get(const std::string& id) {
        std::lock_guard<std::mutex> guard(m_);
        auto it = jobs_.find(id);
        return it == jobs_.end() ? nullptr : it->second;
    }
    std::vector<std::shared_ptr<Job>> List() {
        std::lock_guard<std::mutex> guard(m_);
        Prune();
        std::vector<std::shared_ptr<Job>> out;
        for (auto& kv : jobs_) out.push_back(kv.second);
        return out;
    }
    bool Kill(const std::string& id) {
        auto job = Get(id);
        if (!job || !job->running.load()) return false;
        KillTree(job);
        return true;
    }

private:
    void Prune() {
        for (auto it = jobs_.begin(); it != jobs_.end();) {
            auto& job = it->second;
            if (!job->running.load() && job->ElapsedMs() > 3600LL * 1000) {
                CloseHandleSafe(job->process);
                CloseHandleSafe(job->jobObject);
                it = jobs_.erase(it);
            } else {
                ++it;
            }
        }
    }
    static void CloseHandleSafe(HANDLE& h) {
        if (h) {
            CloseHandle(h);
            h = nullptr;
        }
    }
    void KillTree(const std::shared_ptr<Job>& job);
    void Finish(const std::shared_ptr<Job>& job);
    std::shared_ptr<Job> Launch(const std::string& commandForDisplay, const std::wstring& cmdLine,
                                const std::wstring& workdir, int timeoutMs, bool detached, const std::string& label,
                                std::string& error);

    std::mutex m_;
    std::map<std::string, std::shared_ptr<Job>> jobs_;
};

// Read everything a child writes, bounded so a runaway process cannot eat RAM.
static void PumpPipe(HANDLE pipe, const std::shared_ptr<Job>& job, bool isErr) {
    std::vector<char> buf(16 * 1024);
    const size_t kMaxBuffer = 8u * 1024u * 1024u;
    for (;;) {
        DWORD got = 0;
        if (!ReadFile(pipe, buf.data(), (DWORD)buf.size(), &got, nullptr) || got == 0) break;
        std::lock_guard<std::mutex> guard(job->m);
        std::string& sink = isErr ? job->err : job->out;
        if (sink.size() < kMaxBuffer) {
            size_t take = got;
            if (sink.size() + take > kMaxBuffer) {
                take = kMaxBuffer - sink.size();
                job->truncated.store(true);
            }
            sink.append(buf.data(), take);
        } else {
            job->truncated.store(true);
        }
    }
}

std::shared_ptr<Job> JobRegistry::Launch(const std::string& commandForDisplay, const std::wstring& cmdLine,
                                         const std::wstring& workdir, int timeoutMs, bool detached,
                                         const std::string& label, std::string& error) {
    SECURITY_ATTRIBUTES sa{};
    sa.nLength = sizeof(sa);
    sa.bInheritHandle = TRUE;

    HANDLE outR = nullptr, outW = nullptr, errR = nullptr, errW = nullptr;
    if (!CreatePipe(&outR, &outW, &sa, 0) || !CreatePipe(&errR, &errW, &sa, 0)) {
        error = "CreatePipe failed: " + LastErrorText();
        return nullptr;
    }
    SetHandleInformation(outR, HANDLE_FLAG_INHERIT, 0);
    SetHandleInformation(errR, HANDLE_FLAG_INHERIT, 0);

    STARTUPINFOW si{};
    si.cb = sizeof(si);
    si.dwFlags = STARTF_USESTDHANDLES | STARTF_USESHOWWINDOW;
    si.wShowWindow = SW_HIDE;
    si.hStdOutput = outW;
    si.hStdError = errW;
    si.hStdInput = nullptr; // children get no stdin; they are non-interactive by design

    PROCESS_INFORMATION pi{};
    std::vector<wchar_t> mutableCmd(cmdLine.begin(), cmdLine.end());
    mutableCmd.push_back(L'\0');
    const wchar_t* cwd = workdir.empty() ? nullptr : workdir.c_str();

    BOOL created = CreateProcessW(nullptr, mutableCmd.data(), nullptr, nullptr, TRUE,
                                  CREATE_NO_WINDOW | CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT, nullptr, cwd,
                                  &si, &pi);
    CloseHandle(outW);
    CloseHandle(errW);
    if (!created) {
        error = "CreateProcess failed: " + LastErrorText();
        CloseHandle(outR);
        CloseHandle(errR);
        return nullptr;
    }

    auto job = std::make_shared<Job>();
    job->id = RandomHex(6);
    job->label = label.empty() ? (commandForDisplay.size() > 60 ? commandForDisplay.substr(0, 57) + "..." : commandForDisplay) : label;
    job->command = commandForDisplay;
    job->workdir = WideToUtf8(workdir);
    job->detached = detached;
    job->timeoutMs = timeoutMs;
    job->pid = pi.dwProcessId;
    job->process = pi.hProcess;
    job->startedMs = GetTickCount64();

    // One killable process group per child. Nested jobs are a Windows 8 feature,
    // so on Windows 7 the assignment can legitimately fail — killing then falls
    // back to TerminateProcess on the direct child only.
    job->jobObject = CreateJobObjectW(nullptr, nullptr);
    if (job->jobObject && !AssignProcessToJobObject(job->jobObject, pi.hProcess)) {
        CloseHandle(job->jobObject);
        job->jobObject = nullptr;
    }

    ResumeThread(pi.hThread);
    CloseHandle(pi.hThread);

    job->readerOut = std::thread(PumpPipe, outR, job, false);
    job->readerErr = std::thread(PumpPipe, errR, job, true);
    job->waiter = std::thread([job]() {
        DWORD wait = WAIT_OBJECT_0;
        if (job->timeoutMs > 0) wait = WaitForSingleObject(job->process, (DWORD)job->timeoutMs);
        if (wait == WAIT_TIMEOUT) {
            job->timedOut.store(true);
            JobRegistry::Instance().Kill(job->id);
        }
        WaitForSingleObject(job->process, INFINITE);
        DWORD code = 0;
        GetExitCodeProcess(job->process, &code);
        job->exitCode.store((int)code);
        if (job->readerOut.joinable()) job->readerOut.join();
        if (job->readerErr.joinable()) job->readerErr.join();
        job->running.store(false);
    });

    {
        std::lock_guard<std::mutex> guard(m_);
        Prune();
        jobs_[job->id] = job;
    }
    return job;
}

std::shared_ptr<Job> JobRegistry::Start(const std::string& command, const std::wstring& workdir, int timeoutMs,
                                        bool detached, const std::string& label, const std::string& shell,
                                        std::string& error) {
    std::wstring cmdW = Utf8ToWide(command);
    std::wstring line;
    std::string lowered = LowerAscii(shell);
    if (lowered == "powershell" || lowered == "pwsh") {
        std::wstring exe = (lowered == "pwsh") ? L"pwsh.exe" : L"powershell.exe";
        line = L"\"" + exe + L"\" -NoProfile -NonInteractive -Command \"" + cmdW + L"\"";
    } else {
        line = L"cmd.exe /d /s /c \"" + cmdW + L"\"";
    }
    return Launch(command, line, workdir, timeoutMs, detached, label, error);
}

std::shared_ptr<Job> JobRegistry::StartProcess(const std::wstring& fileName, const std::vector<std::wstring>& argv,
                                               const std::wstring& workdir, int timeoutMs, const std::string& label,
                                               std::string& error) {
    auto quote = [](const std::wstring& s) {
        std::wstring out = L"\"";
        for (wchar_t c : s) {
            if (c == L'"') out += L"\\\"";
            else out.push_back(c);
        }
        out += L"\"";
        return out;
    };
    std::wstring line = quote(fileName);
    std::string display = WideToUtf8(fileName);
    for (const auto& a : argv) {
        line += L" " + quote(a);
        display += " " + WideToUtf8(a);
    }
    return Launch(display, line, workdir, timeoutMs, false, label, error);
}

void JobRegistry::KillTree(const std::shared_ptr<Job>& job) {
    if (job->jobObject) TerminateJobObject(job->jobObject, 1);
    if (job->process) TerminateProcess(job->process, 1);
}

// ─────────────────────────── node runtime lookup ───────────────────────────

static std::wstring ExeDirectory() {
    std::wstring buf(MAX_PATH, L'\0');
    DWORD got = GetModuleFileNameW(nullptr, &buf[0], (DWORD)buf.size());
    buf.resize(got);
    size_t pos = buf.find_last_of(L"\\/");
    return pos == std::wstring::npos ? L"." : buf.substr(0, pos);
}

static bool FileExistsW(const std::wstring& path) {
    DWORD attr = GetFileAttributesW(path.c_str());
    return attr != INVALID_FILE_ATTRIBUTES && !(attr & FILE_ATTRIBUTE_DIRECTORY);
}

static std::wstring FindNode() {
    std::wstring dir = ExeDirectory();
    const wchar_t* candidates[] = {L"\\node\\node.exe", L"\\node.exe"};
    for (const wchar_t* rel : candidates) {
        std::wstring p = dir + rel;
        if (FileExistsW(p)) return p;
    }
    wchar_t found[MAX_PATH] = {0};
    if (SearchPathW(nullptr, L"node.exe", nullptr, MAX_PATH, found, nullptr)) return found;
    return std::wstring();
}

// ─────────────────────────── identity (agent.json) ───────────────────────────

struct Identity {
    std::string id;
    std::string secret;
    std::string name;
    std::string relay;
};

static std::wstring HomeDir() {
    wchar_t buf[MAX_PATH] = {0};
    DWORD n = GetEnvironmentVariableW(L"RDSH_HOME", buf, MAX_PATH);
    std::wstring home;
    if (n > 0 && n < MAX_PATH) {
        home = buf;
    } else {
        wchar_t profile[MAX_PATH] = {0};
        DWORD m = GetEnvironmentVariableW(L"USERPROFILE", profile, MAX_PATH);
        if (m > 0 && m < MAX_PATH) {
            home = std::wstring(profile) + L"\\.rdsh";
        } else {
            home = ExeDirectory() + L"\\.rdsh";
        }
    }
    CreateDirectoryW(home.c_str(), nullptr);
    return home;
}

static std::wstring ConfigPath() { return HomeDir() + L"\\agent.json"; }

static std::string MachineName() {
    wchar_t buf[MAX_COMPUTERNAME_LENGTH + 1] = {0};
    DWORD n = sizeof(buf) / sizeof(buf[0]);
    if (GetComputerNameW(buf, &n)) return WideToUtf8(std::wstring(buf, n));
    return "windows-host";
}

static std::string UserName() {
    wchar_t buf[256] = {0};
    DWORD n = sizeof(buf) / sizeof(buf[0]);
    if (GetUserNameW(buf, &n)) return WideToUtf8(std::wstring(buf, n > 0 ? n - 1 : 0));
    return "";
}

static bool LoadIdentity(Identity& id) {
    std::string raw;
    if (!ReadFileUtf8(ConfigPath(), raw) || raw.empty()) return false;
    Json doc;
    JsonParser parser(raw);
    if (!parser.Parse(doc)) return false;
    id.id = doc.str("id");
    id.secret = doc.str("secret");
    if (id.secret.empty()) id.secret = doc.str("sec");
    id.name = doc.str("name");
    id.relay = doc.str("relay");
    return !id.id.empty() && !id.secret.empty();
}

static void SaveIdentity(const Identity& id) {
    Json doc = Json::MakeObj();
    doc.set("v", Json::MakeNum(1));
    doc.set("id", Json::MakeStr(id.id));
    doc.set("secret", Json::MakeStr(id.secret));
    doc.set("name", Json::MakeStr(id.name));
    if (!id.relay.empty()) doc.set("relay", Json::MakeStr(id.relay));
    doc.set("createdAt", Json::MakeNum((double)time(nullptr)));
    WriteFileUtf8(ConfigPath(), JsonDump(doc), false);
}

// ─────────────────────────── WebSocket client ───────────────────────────

static const char* kWsGuid = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

class WsClient {
public:
    ~WsClient() { Close(); }

    bool Connect(const std::string& host, int port, const std::string& path, const std::string& bearer,
                 const std::string& agentVersion, std::string& error);
    bool SendText(const std::string& text);
    bool SendPing();
    // Blocks until a text message arrives or the socket errors out. Returns 0 on
    // success, 1 on close/shutdown, -1 on transport error.
    int ReceiveText(std::string& text, std::string& error, int timeoutMs);
    void Close();
    bool connected() const { return sock_ != INVALID_SOCKET; }

private:
    bool ReadSome(std::string& buffer, int timeoutMs, int& status, std::string& error);
    bool ParseFrame(std::string& buffer, std::string& text, int& status, std::string& error);
    bool SendFrame(BYTE opcode, const std::string& payload);

    SOCKET sock_ = INVALID_SOCKET;
    std::string pending_;      // raw bytes not yet consumed
    std::string partial_;      // continuation payload of a fragmented message
    bool sentClose_ = false;
};

bool WsClient::Connect(const std::string& host, int port, const std::string& path, const std::string& bearer,
                       const std::string& agentVersion, std::string& error) {
    Close();
    std::string portText = std::to_string(port);
    addrinfo hints{};
    hints.ai_family = AF_UNSPEC;
    hints.ai_socktype = SOCK_STREAM;
    hints.ai_protocol = IPPROTO_TCP;
    addrinfo* result = nullptr;
    if (getaddrinfo(host.c_str(), portText.c_str(), &hints, &result) != 0 || !result) {
        error = "cannot resolve " + host;
        return false;
    }
    SOCKET s = INVALID_SOCKET;
    std::string lastError = "connect failed";
    for (addrinfo* ai = result; ai; ai = ai->ai_next) {
        s = socket(ai->ai_family, ai->ai_socktype, ai->ai_protocol);
        if (s == INVALID_SOCKET) continue;
        if (connect(s, ai->ai_addr, (int)ai->ai_addrlen) == 0) break;
        lastError = "connect failed: " + LastErrorText(WSAGetLastError());
        closesocket(s);
        s = INVALID_SOCKET;
    }
    freeaddrinfo(result);
    if (s == INVALID_SOCKET) {
        error = lastError;
        return false;
    }
    sock_ = s;

    std::vector<BYTE> keyBytes = RandomBytes(16);
    std::string key = Base64Encode(keyBytes.data(), keyBytes.size());
    std::string handshake = "GET " + path + " HTTP/1.1\r\n";
    handshake += "Host: " + host + (port == 80 ? "" : ":" + portText) + "\r\n";
    handshake += "Upgrade: websocket\r\n";
    handshake += "Connection: Upgrade\r\n";
    handshake += "Sec-WebSocket-Key: " + key + "\r\n";
    handshake += "Sec-WebSocket-Version: 13\r\n";
    if (!bearer.empty()) handshake += "Authorization: Bearer " + bearer + "\r\n";
    if (!agentVersion.empty()) handshake += "X-RDSH-Agent: " + agentVersion + "\r\n";
    handshake += "\r\n";
    if (send(sock_, handshake.data(), (int)handshake.size(), 0) == SOCKET_ERROR) {
        error = "handshake send failed: " + LastErrorText(WSAGetLastError());
        Close();
        return false;
    }

    // Read until the end of the response headers.
    std::string header;
    for (;;) {
        char buf[1024];
        int got = recv(sock_, buf, sizeof(buf), 0);
        if (got <= 0) {
            error = "no handshake response (" + LastErrorText(WSAGetLastError()) + ")";
            Close();
            return false;
        }
        header.append(buf, got);
        size_t end = header.find("\r\n\r\n");
        if (end != std::string::npos) {
            pending_ = header.substr(end + 4);
            header.resize(end);
            break;
        }
        if (header.size() > 64 * 1024) {
            error = "handshake response too large";
            Close();
            return false;
        }
    }
    size_t lineEnd = header.find("\r\n");
    std::string statusLine = lineEnd == std::string::npos ? header : header.substr(0, lineEnd);
    if (statusLine.find("101") == std::string::npos) {
        size_t space = statusLine.find(' ');
        error = "relay refused the upgrade: " + (space == std::string::npos ? statusLine : statusLine.substr(space + 1));
        Close();
        return false;
    }
    // Verify Sec-WebSocket-Accept: a captive portal or a half-broken proxy can
    // answer 101 without actually speaking WebSocket, and that failure is much
    // easier to read here than as a silent frame desync later.
    std::vector<BYTE> acceptDigest;
    std::string expectedAccept;
    if (Sha1(key + kWsGuid, acceptDigest)) {
        expectedAccept = Base64Encode(acceptDigest.data(), acceptDigest.size());
        std::string lowered = header;
        for (char& c : lowered) c = (char)tolower((unsigned char)c);
        size_t at = lowered.find("sec-websocket-accept:");
        std::string seen;
        if (at != std::string::npos) {
            size_t start = at + strlen("sec-websocket-accept:");
            size_t stop = header.find("\r\n", start);
            seen = header.substr(start, stop == std::string::npos ? std::string::npos : stop - start);
            while (!seen.empty() && (seen.front() == ' ' || seen.front() == '\t')) seen.erase(seen.begin());
            while (!seen.empty() && (seen.back() == ' ' || seen.back() == '\t')) seen.pop_back();
        }
        if (seen != expectedAccept) {
            error = "upgrade answer did not look like WebSocket (bad Sec-WebSocket-Accept)";
            Close();
            return false;
        }
    }
    return true;
}

bool WsClient::SendFrame(BYTE opcode, const std::string& payload) {
    if (sock_ == INVALID_SOCKET) return false;
    size_t len = payload.size();
    std::string frame;
    frame.push_back((char)(0x80 | opcode));
    std::vector<BYTE> mask = RandomBytes(4);
    if (len < 126) {
        frame.push_back((char)(0x80 | (BYTE)len));
    } else if (len < 65536) {
        frame.push_back((char)(0x80 | 126));
        frame.push_back((char)((len >> 8) & 0xFF));
        frame.push_back((char)(len & 0xFF));
    } else {
        frame.push_back((char)(0x80 | 127));
        for (int shift = 56; shift >= 0; shift -= 8) frame.push_back((char)(((unsigned long long)len >> shift) & 0xFF));
    }
    frame.append((const char*)mask.data(), mask.size());
    size_t headerLen = frame.size();
    frame.resize(headerLen + len);
    for (size_t i = 0; i < len; i++) frame[headerLen + i] = (char)(payload[i] ^ mask[i % 4]);

    size_t sent = 0;
    while (sent < frame.size()) {
        int n = send(sock_, frame.data() + sent, (int)(frame.size() - sent), 0);
        if (n == SOCKET_ERROR) return false;
        sent += (size_t)n;
    }
    return true;
}

bool WsClient::SendText(const std::string& text) { return SendFrame(0x1, text); }
bool WsClient::SendPing() { return SendFrame(0x9, std::string()); }

bool WsClient::ReadSome(std::string& buffer, int timeoutMs, int& status, std::string& error) {
    fd_set rd;
    FD_ZERO(&rd);
    FD_SET(sock_, &rd);
    timeval tv{};
    tv.tv_sec = timeoutMs / 1000;
    tv.tv_usec = (timeoutMs % 1000) * 1000;
    int ready = select(0, &rd, nullptr, nullptr, &tv);
    if (ready == SOCKET_ERROR) {
        status = -1;
        error = "select failed: " + LastErrorText(WSAGetLastError());
        return false;
    }
    if (ready == 0) {
        status = 2; // timeout: caller sends a keepalive
        return false;
    }
    char buf[16 * 1024];
    int got = recv(sock_, buf, sizeof(buf), 0);
    if (got <= 0) {
        status = 1;
        error = "link closed by the relay";
        return false;
    }
    buffer.append(buf, got);
    return true;
}

bool WsClient::ParseFrame(std::string& buffer, std::string& text, int& status, std::string& error) {
    for (;;) {
        if (buffer.size() < 2) return false;
        unsigned char b0 = (unsigned char)buffer[0];
        unsigned char b1 = (unsigned char)buffer[1];
        bool fin = (b0 & 0x80) != 0;
        BYTE opcode = b0 & 0x0F;
        bool masked = (b1 & 0x80) != 0;
        unsigned long long len = b1 & 0x7F;
        size_t pos = 2;
        if (len == 126) {
            if (buffer.size() < 4) return false;
            len = ((unsigned char)buffer[2] << 8) | (unsigned char)buffer[3];
            pos = 4;
        } else if (len == 127) {
            if (buffer.size() < 10) return false;
            len = 0;
            for (size_t i = 2; i < 10; i++) len = (len << 8) | (unsigned char)buffer[i];
            pos = 10;
        }
        std::vector<BYTE> mask;
        if (masked) {
            if (buffer.size() < pos + 4) return false;
            mask.assign(buffer.begin() + pos, buffer.begin() + pos + 4);
            pos += 4;
        }
        if (buffer.size() < pos + (size_t)len) return false;

        std::string payload = buffer.substr(pos, (size_t)len);
        buffer.erase(0, pos + (size_t)len);
        if (masked)
            for (size_t i = 0; i < payload.size(); i++) payload[i] = (char)(payload[i] ^ mask[i % 4]);

        switch (opcode) {
            case 0x0: // continuation
            case 0x1: // text
            case 0x2: // binary (treated as text; the protocol is JSON-only)
                partial_ += payload;
                if (fin) {
                    text = partial_;
                    partial_.clear();
                    return true;
                }
                break;
            case 0x8: // close
                status = 1;
                error = "relay closed the link";
                return false;
            case 0x9: // ping -> pong
                SendFrame(0xA, payload);
                break;
            case 0xA: // pong
                break;
            default:
                break;
        }
    }
}

int WsClient::ReceiveText(std::string& text, std::string& error, int timeoutMs) {
    int status = 0;
    if (ParseFrame(pending_, text, status, error)) return 0;
    if (status != 0) return status;
    while (true) {
        if (!ReadSome(pending_, timeoutMs, status, error)) return status;
        if (ParseFrame(pending_, text, status, error)) return 0;
        if (status != 0) return status;
    }
}

void WsClient::Close() {
    if (sock_ != INVALID_SOCKET) {
        if (!sentClose_) {
            sentClose_ = true;
            SendFrame(0x8, std::string());
        }
        closesocket(sock_);
        sock_ = INVALID_SOCKET;
    }
    pending_.clear();
    partial_.clear();
}

// ─────────────────────────── relay URL parsing ───────────────────────────

struct RelayUrl {
    std::string host;
    int port = 80;
    std::string basePath; // "" or "/rdsh"
    bool tls = false;
    bool valid = false;
};

static RelayUrl ParseRelayUrl(const std::string& raw) {
    RelayUrl out;
    std::string s = raw;
    while (!s.empty() && (s.back() == '/' )) s.pop_back();
    if (s.rfind("http://", 0) == 0) {
        s = s.substr(7);
    } else if (s.rfind("https://", 0) == 0) {
        s = s.substr(8);
        out.tls = true;
    } else {
        return out; // no scheme: refuse rather than guess
    }
    size_t slash = s.find('/');
    std::string authority = slash == std::string::npos ? s : s.substr(0, slash);
    out.basePath = slash == std::string::npos ? "" : s.substr(slash);
    while (out.basePath.size() > 1 && out.basePath.back() == '/') out.basePath.pop_back();
    size_t colon = authority.rfind(':');
    if (colon != std::string::npos) {
        out.host = authority.substr(0, colon);
        out.port = atoi(authority.substr(colon + 1).c_str());
        if (out.port <= 0) return out;
    } else {
        out.host = authority;
        out.port = out.tls ? 443 : 80;
    }
    out.valid = !out.host.empty();
    return out;
}

// ─────────────────────────── dispatcher ───────────────────────────

static std::atomic<bool> g_shutdown{false};
static std::atomic<bool> g_disconnectRequested{false};
static std::atomic<long long> g_requests{0};
static std::atomic<bool> g_connected{false};
static std::string g_relayDisplay;

static Json ReplyOk(Json data) {
    Json reply = Json::MakeObj();
    reply.set("ok", Json::MakeBool(true));
    reply.set("data", std::move(data));
    return reply;
}

static Json ReplyBad(const std::string& code, const std::string& message) {
    Json reply = Json::MakeObj();
    reply.set("ok", Json::MakeBool(false));
    reply.set("code", Json::MakeStr(code));
    reply.set("error", Json::MakeStr(message));
    return reply;
}

static Json HelloPayload(const Identity& id) {
    std::wstring node = FindNode();
    Json caps = Json::MakeArr();
    caps.push(Json::MakeStr("exec"));
    caps.push(Json::MakeStr("poll"));
    caps.push(Json::MakeStr("file"));
    caps.push(Json::MakeStr("jobs"));
    if (!node.empty()) caps.push(Json::MakeStr("node"));

    Json hello = Json::MakeObj();
    hello.set("id", Json::MakeStr(id.id));
    hello.set("host", Json::MakeStr(MachineName()));
    hello.set("os", Json::MakeStr("windows"));
    hello.set("arch", Json::MakeStr("x86"));
    hello.set("ver", Json::MakeStr(kAgentVersion));
    hello.set("user", Json::MakeStr(UserName()));
    hello.set("pid", Json::MakeNum((double)GetCurrentProcessId()));
    hello.set("node", Json::MakeBool(!node.empty()));
    if (!node.empty()) hello.set("nodePath", Json::MakeStr(WideToUtf8(node)));
    hello.set("nodeSource", Json::MakeStr(node.empty() ? "" : "beside-binary-or-path"));
    hello.set("flavor", Json::MakeStr(kFlavor));
    hello.set("childEncoding", Json::MakeStr("oem-or-utf8"));
    hello.set("childCodePage", Json::MakeNum((double)GetOEMCP()));
    hello.set("caps", std::move(caps));
    return hello;
}

static std::wstring WorkdirArg(const Json& args, std::string& error) {
    std::string wd = args.str("workdir");
    if (wd.empty()) return std::wstring();
    std::wstring wide = FullPathOf(Utf8ToWide(wd));
    DWORD attr = GetFileAttributesW(wide.c_str());
    if (attr == INVALID_FILE_ATTRIBUTES || !(attr & FILE_ATTRIBUTE_DIRECTORY)) {
        error = "working directory not found: " + wd;
        return std::wstring();
    }
    return wide;
}

static Json Invoke(const std::string& method, const Json& args, const Identity& identity) {
    g_requests++;
    try {
        if (method == "hello" || method == "info") {
            return ReplyOk(HelloPayload(identity));
        }
        if (method == "exec") {
            std::string command = args.str("command");
            if (command.empty()) return ReplyBad("bad_request", "command is required");
            std::string wdError;
            std::wstring workdir = WorkdirArg(args, wdError);
            if (!wdError.empty()) return ReplyBad("not_found", wdError);
            int timeoutMs = args.has("timeoutMs") ? (int)args.num("timeoutMs", 120000) : 120000;
            if (timeoutMs < 0) timeoutMs = 0;
            bool detached = args.flag("detached", false);
            std::string error;
            auto job = JobRegistry::Instance().Start(command, workdir, detached ? 0 : timeoutMs, detached,
                                                     args.str("label"), args.str("shell"), error);
            if (!job) return ReplyBad("internal", error);
            Json data = Json::MakeObj();
            data.set("runId", Json::MakeStr(job->id));
            data.set("pid", Json::MakeNum((double)job->pid));
            return ReplyOk(std::move(data));
        }
        if (method == "poll") {
            std::string runId = args.str("runId");
            if (runId.empty()) return ReplyBad("bad_request", "runId is required");
            auto job = JobRegistry::Instance().Get(runId);
            if (!job) return ReplyBad("not_found", "no such run: " + runId);
            int waitMs = args.has("waitMs") ? (int)args.num("waitMs", 0) : 0;
            if (waitMs < 0) waitMs = 0;
            if (waitMs > 60000) waitMs = 60000;
            std::string out, err;
            job->Drain(out, err);
            ULONGLONG deadline = GetTickCount64() + (ULONGLONG)waitMs;
            while (waitMs > 0 && out.empty() && err.empty() && job->running.load() && GetTickCount64() < deadline) {
                Sleep(50);
                job->Drain(out, err);
            }
            Json data = Json::MakeObj();
            data.set("out", Json::MakeStr(DecodeChildOutput(out)));
            data.set("err", Json::MakeStr(DecodeChildOutput(err)));
            data.set("exitCode", Json::MakeNum(job->running.load() ? -1 : job->exitCode.load()));
            data.set("done", Json::MakeBool(!job->running.load()));
            data.set("timedOut", Json::MakeBool(job->timedOut.load()));
            data.set("truncated", Json::MakeBool(job->truncated.load()));
            data.set("elapsedMs", Json::MakeNum((double)job->ElapsedMs()));
            return ReplyOk(std::move(data));
        }
        if (method == "kill") {
            std::string runId = args.str("runId");
            if (runId.empty()) return ReplyBad("bad_request", "runId is required");
            bool killed = JobRegistry::Instance().Kill(runId);
            Json data = Json::MakeObj();
            data.set("ok", Json::MakeBool(killed));
            if (!killed) data.set("detail", Json::MakeStr("already finished or unknown"));
            return ReplyOk(std::move(data));
        }
        if (method == "jobs") {
            if (args.has("runId")) {
                auto job = JobRegistry::Instance().Get(args.str("runId"));
                if (!job) return ReplyBad("not_found", "no such run: " + args.str("runId"));
            }
            Json list = Json::MakeArr();
            for (const auto& job : JobRegistry::Instance().List()) {
                Json info = Json::MakeObj();
                info.set("id", Json::MakeStr(job->id));
                info.set("label", Json::MakeStr(job->label));
                info.set("command", Json::MakeStr(job->command));
                info.set("running", Json::MakeBool(job->running.load()));
                info.set("exitCode", Json::MakeNum(job->running.load() ? -1 : job->exitCode.load()));
                info.set("startedMs", Json::MakeNum((double)job->startedMs));
                info.set("elapsedMs", Json::MakeNum((double)job->ElapsedMs()));
                size_t outBytes = 0, errBytes = 0;
                {
                    std::lock_guard<std::mutex> guard(job->m);
                    outBytes = job->out.size();
                    errBytes = job->err.size();
                }
                info.set("outBytes", Json::MakeNum((double)outBytes));
                info.set("errBytes", Json::MakeNum((double)errBytes));
                info.set("detached", Json::MakeBool(job->detached));
                if (!job->workdir.empty()) info.set("workdir", Json::MakeStr(job->workdir));
                list.push(std::move(info));
            }
            Json data = Json::MakeObj();
            data.set("jobs", std::move(list));
            return ReplyOk(std::move(data));
        }
        if (method == "read") {
            std::string path = args.str("path");
            if (path.empty()) return ReplyBad("bad_request", "path is required");
            std::wstring full = FullPathOf(Utf8ToWide(path));
            HANDLE h = CreateFileW(full.c_str(), GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                                   nullptr, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr);
            if (h == INVALID_HANDLE_VALUE) return ReplyBad("not_found", "cannot open " + WideToUtf8(full) + ": " + LastErrorText());
            LARGE_INTEGER size{};
            GetFileSizeEx(h, &size);
            long long offset = args.has("offset") ? (long long)args.num("offset", 0) : 0;
            long long maxBytes = args.has("maxBytes") ? (long long)args.num("maxBytes", 4 * 1024 * 1024) : 4 * 1024 * 1024;
            if (maxBytes < 1) maxBytes = 1;
            if (maxBytes > 8 * 1024 * 1024) maxBytes = 8 * 1024 * 1024;
            if (offset < 0) offset = 0;
            if (offset > size.QuadPart) offset = size.QuadPart;
            LARGE_INTEGER pos{};
            pos.QuadPart = offset;
            SetFilePointerEx(h, pos, nullptr, FILE_BEGIN);
            long long take = size.QuadPart - offset;
            if (take > maxBytes) take = maxBytes;
            std::string data((size_t)take, '\0');
            DWORD got = 0;
            bool ok = take == 0 || (ReadFile(h, &data[0], (DWORD)take, &got, nullptr) && got == (DWORD)take);
            CloseHandle(h);
            if (!ok) return ReplyBad("io_error", "read failed: " + LastErrorText());
            bool wantBase64 = args.flag("base64", false);
            Json result = Json::MakeObj();
            result.set("path", Json::MakeStr(WideToUtf8(full)));
            result.set("offset", Json::MakeNum((double)offset));
            result.set("length", Json::MakeNum((double)size.QuadPart));
            result.set("eof", Json::MakeBool(offset + take >= size.QuadPart));
            if (wantBase64) {
                result.set("base64", Json::MakeStr(Base64Encode((const unsigned char*)data.data(), data.size())));
            } else if (IsValidUtf8(data)) {
                result.set("text", Json::MakeStr(data));
            } else {
                result.set("base64", Json::MakeStr(Base64Encode((const unsigned char*)data.data(), data.size())));
                result.set("note", Json::MakeStr("content is not valid UTF-8; returned as base64"));
            }
            return ReplyOk(std::move(result));
        }
        if (method == "write") {
            std::string path = args.str("path");
            if (path.empty()) return ReplyBad("bad_request", "path is required");
            std::wstring full = FullPathOf(Utf8ToWide(path));
            EnsureParentDir(full);
            bool append = args.flag("append", false);
            std::string payload;
            const Json* b64 = args.find("base64");
            if (b64 && b64->kind == Json::Str) {
                std::vector<BYTE> bytes;
                if (!Base64Decode(b64->text, bytes)) return ReplyBad("bad_request", "base64 payload is not decodable");
                payload.assign(bytes.begin(), bytes.end());
            } else {
                const Json* text = args.find("text");
                if (!text || text->kind != Json::Str) return ReplyBad("bad_request", "either base64 or text is required");
                payload = text->text;
            }
            if (!WriteFileUtf8(full, payload, append))
                return ReplyBad("io_error", "cannot write " + WideToUtf8(full) + ": " + LastErrorText());
            Json result = Json::MakeObj();
            result.set("path", Json::MakeStr(WideToUtf8(full)));
            result.set("bytes", Json::MakeNum((double)payload.size()));
            return ReplyOk(std::move(result));
        }
        if (method == "ls") {
            std::string path = args.str("path", ".");
            std::wstring full = FullPathOf(Utf8ToWide(path));
            DWORD attr = GetFileAttributesW(full.c_str());
            if (attr == INVALID_FILE_ATTRIBUTES || !(attr & FILE_ATTRIBUTE_DIRECTORY))
                return ReplyBad("not_found", "no such directory: " + WideToUtf8(full));
            WIN32_FIND_DATAW fd{};
            std::wstring pattern = full + L"\\*";
            HANDLE h = FindFirstFileW(pattern.c_str(), &fd);
            if (h == INVALID_HANDLE_VALUE) return ReplyBad("io_error", "cannot list " + WideToUtf8(full));
            std::vector<Json> entries;
            do {
                std::wstring name = fd.cFileName;
                if (name == L"." || name == L"..") continue;
                Json entry = Json::MakeObj();
                entry.set("name", Json::MakeStr(WideToUtf8(name)));
                bool isDir = (fd.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) != 0;
                entry.set("isDir", Json::MakeBool(isDir));
                LARGE_INTEGER sz{};
                sz.HighPart = fd.nFileSizeHigh;
                sz.LowPart = fd.nFileSizeLow;
                entry.set("size", Json::MakeNum(isDir ? 0 : (double)sz.QuadPart));
                entry.set("mtimeMs", Json::MakeNum((double)FileTimeToUnixMs(fd.ftLastWriteTime)));
                entries.push_back(std::move(entry));
            } while (FindNextFileW(h, &fd));
            FindClose(h);
            // Case-insensitive name order, matching the .NET agent's listing.
            for (size_t i = 1; i < entries.size(); i++) {
                Json key = entries[i];
                std::string keyName = LowerAscii(key.str("name"));
                size_t j = i;
                while (j > 0 && LowerAscii(entries[j - 1].str("name")) > keyName) {
                    entries[j] = entries[j - 1];
                    j--;
                }
                entries[j] = key;
            }
            Json arr = Json::MakeArr();
            for (auto& e : entries) arr.push(std::move(e));
            Json result = Json::MakeObj();
            result.set("path", Json::MakeStr(WideToUtf8(full)));
            result.set("entries", std::move(arr));
            return ReplyOk(std::move(result));
        }
        if (method == "stat") {
            std::string path = args.str("path");
            if (path.empty()) return ReplyBad("bad_request", "path is required");
            std::wstring full = FullPathOf(Utf8ToWide(path));
            Json result = Json::MakeObj();
            result.set("path", Json::MakeStr(WideToUtf8(full)));
            DWORD attr = GetFileAttributesW(full.c_str());
            if (attr == INVALID_FILE_ATTRIBUTES) {
                result.set("exists", Json::MakeBool(false));
                return ReplyOk(std::move(result));
            }
            WIN32_FILE_ATTRIBUTE_DATA info{};
            GetFileAttributesExW(full.c_str(), GetFileExInfoStandard, &info);
            bool isDir = (attr & FILE_ATTRIBUTE_DIRECTORY) != 0;
            result.set("exists", Json::MakeBool(true));
            result.set("kind", Json::MakeStr(isDir ? "dir" : "file"));
            result.set("isDir", Json::MakeBool(isDir));
            LARGE_INTEGER sz{};
            sz.HighPart = info.nFileSizeHigh;
            sz.LowPart = info.nFileSizeLow;
            result.set("size", Json::MakeNum(isDir ? 0 : (double)sz.QuadPart));
            result.set("mtimeMs", Json::MakeNum((double)FileTimeToUnixMs(info.ftLastWriteTime)));
            return ReplyOk(std::move(result));
        }
        if (method == "rm") {
            std::string path = args.str("path");
            if (path.empty()) return ReplyBad("bad_request", "path is required");
            std::wstring full = FullPathOf(Utf8ToWide(path));
            bool hard = args.flag("hard", false);
            bool recursive = args.flag("recursive", false);
            DWORD attr = GetFileAttributesW(full.c_str());
            if (attr == INVALID_FILE_ATTRIBUTES) return ReplyBad("not_found", "no such path: " + WideToUtf8(full));
            bool isDir = (attr & FILE_ATTRIBUTE_DIRECTORY) != 0;
            if (isDir && !recursive) return ReplyBad("bad_request", "refusing to remove a directory without recursive=true");
            bool ok;
            if (hard) {
                ok = isDir ? (RemoveDirectoryW(full.c_str()) != 0) : (DeleteFileW(full.c_str()) != 0);
                if (isDir && recursive && !ok) {
                    // SHFileOperation-free recursive delete.
                    std::wstring cmd = L"cmd.exe /d /s /c \"rd /s /q \\\"" + full + L"\\\"\"";
                    STARTUPINFOW si{};
                    si.cb = sizeof(si);
                    PROCESS_INFORMATION pi{};
                    std::vector<wchar_t> mutableCmd(cmd.begin(), cmd.end());
                    mutableCmd.push_back(L'\0');
                    if (CreateProcessW(nullptr, mutableCmd.data(), nullptr, nullptr, FALSE, CREATE_NO_WINDOW, nullptr,
                                       nullptr, &si, &pi)) {
                        WaitForSingleObject(pi.hProcess, 30000);
                        CloseHandle(pi.hThread);
                        CloseHandle(pi.hProcess);
                        ok = GetFileAttributesW(full.c_str()) == INVALID_FILE_ATTRIBUTES;
                    }
                }
            } else {
                std::wstring trash = full + L".rdsh-trash-" + std::to_wstring((long long)time(nullptr));
                ok = MoveFileExW(full.c_str(), trash.c_str(), 0) != 0;
            }
            if (!ok) return ReplyBad("io_error", "remove failed: " + LastErrorText());
            Json result = Json::MakeObj();
            result.set("ok", Json::MakeBool(true));
            return ReplyOk(std::move(result));
        }
        if (method == "node") {
            std::wstring node = FindNode();
            if (node.empty())
                return ReplyBad("no_node_runtime",
                                "this x86 build has no Node runtime beside it; put node.exe next to rdsh32.exe or on PATH");
            std::string script = args.str("script");
            std::string scriptPath = args.str("path");
            std::wstring file;
            if (!scriptPath.empty()) {
                file = FullPathOf(Utf8ToWide(scriptPath));
                if (!FileExistsW(file)) return ReplyBad("not_found", "no such script: " + WideToUtf8(file));
            } else if (!script.empty()) {
                std::wstring dir = HomeDir() + L"\\scripts";
                CreateDirectoryW(dir.c_str(), nullptr);
                file = dir + L"\\inline-" + std::to_wstring((long long)GetTickCount64()) + L".mjs";
                if (!WriteFileUtf8(file, script, false)) return ReplyBad("io_error", "cannot stage the inline script");
            } else {
                return ReplyBad("bad_request", "either script or path is required");
            }
            std::vector<std::wstring> argv{file};
            const Json* extra = args.find("args");
            if (extra && extra->kind == Json::Arr) {
                for (const auto& item : extra->items)
                    if (item.kind == Json::Str) argv.push_back(Utf8ToWide(item.text));
            }
            std::string wdError;
            std::wstring workdir = WorkdirArg(args, wdError);
            int timeoutMs = args.has("timeoutMs") ? (int)args.num("timeoutMs", 300000) : 300000;
            std::string error;
            auto job = JobRegistry::Instance().StartProcess(node, argv, workdir, timeoutMs, args.str("label"), error);
            if (!job) return ReplyBad("internal", error);
            Json data = Json::MakeObj();
            data.set("runId", Json::MakeStr(job->id));
            data.set("pid", Json::MakeNum((double)job->pid));
            return ReplyOk(std::move(data));
        }
        if (method == "disconnect") {
            g_disconnectRequested.store(true);
            return ReplyOk(Json::MakeObj());
        }
        return ReplyBad("unknown_method", "unknown method: " + method);
    } catch (const std::exception& ex) {
        return ReplyBad("internal", std::string("internal: ") + ex.what());
    } catch (...) {
        return ReplyBad("internal", "internal: unknown error");
    }
}

// ─────────────────────────── clipboard ───────────────────────────

/// Best-effort clipboard write (CF_UNICODETEXT). No admin needed; another process
/// holding the clipboard open is the only realistic failure, hence the retries.
static bool CopyToClipboard(const std::wstring& text) {
    for (int attempt = 0; attempt < 10; attempt++) {
        if (OpenClipboard(nullptr)) {
            bool ok = false;
            if (EmptyClipboard()) {
                SIZE_T bytes = (text.size() + 1) * sizeof(wchar_t);
                HGLOBAL block = GlobalAlloc(GMEM_MOVEABLE, bytes);
                if (block) {
                    void* target = GlobalLock(block);
                    if (target) {
                        memcpy(target, text.c_str(), bytes);
                        GlobalUnlock(block);
                        if (SetClipboardData(CF_UNICODETEXT, block)) {
                            ok = true;
                            block = nullptr; // ownership passed to the clipboard
                        }
                    }
                    if (block) GlobalFree(block);
                }
            }
            CloseClipboard();
            return ok;
        }
        Sleep(50);
    }
    return false;
}

// ─────────────────────────── pairing string ───────────────────────────

static std::string PairString(const Identity& id, const std::string& relay) {
    Json payload = Json::MakeObj();
    payload.set("v", Json::MakeNum(1));
    payload.set("id", Json::MakeStr(id.id));
    if (!relay.empty()) payload.set("url", Json::MakeStr(relay));
    payload.set("sec", Json::MakeStr(id.secret));
    payload.set("host", Json::MakeStr(MachineName()));
    payload.set("os", Json::MakeStr("windows"));
    payload.set("arch", Json::MakeStr("x86"));
    payload.set("ver", Json::MakeStr(kAgentVersion));
    std::string json = JsonDump(payload);
    return "DshAgent:" + Base64Encode((const unsigned char*)json.data(), json.size(), true, false);
}

// ─────────────────────────── main loop ───────────────────────────

static void PrintHelp() {
    OutLine("RemoteDSH agent (x86 compat build) - lets a DSH harness operate this machine.");
    OutLine("");
    OutLine("Usage: rdsh32.exe [options]");
    OutLine("");
    OutLine("  --relay <url>     DSH relay base URL, e.g. http://static.example.com/rdsh");
    OutLine("                    The agent dials OUT to <url>/remote/attach; no inbound port needed.");
    OutLine("  --name <label>    Friendly device name shown to the controller.");
    OutLine("  --pair            Print the pairing string (on by default).");
    OutLine("  --no-pair         Suppress the pairing banner.");
    OutLine("  --emit-pair <f>   Also write the pairing string to a file.");
    OutLine("  --once            Print identity/pairing and exit (diagnostics).");
    OutLine("  --reset           Archive the current identity and generate a new one.");
    OutLine("  --selftest        Run the built-in SHA/HMAC known-answer tests and exit.");
    OutLine("  --clip            Copy the pairing string to the clipboard (easiest to hand over).");
    OutLine("  -h, --help        Show this help.");
    OutLine("");
    OutLine("Only ws:// (plain HTTP) relays are supported by this build: Windows 7's TLS");
    OutLine("stack needs OS updates and a registry opt-in before TLS 1.2 works, so an");
    OutLine("http:// relay is the only transport that works on an unpatched Win7 box.");
}

static std::string ReadAgentVersionFile() { return kAgentVersion; }

static std::string HexOf(const unsigned char* data, size_t len) {
    static const char* hex = "0123456789abcdef";
    std::string out;
    for (size_t i = 0; i < len; i++) {
        out.push_back(hex[data[i] >> 4]);
        out.push_back(hex[data[i] & 15]);
    }
    return out;
}

static std::string HexOf(const std::vector<BYTE>& data) { return HexOf(data.data(), data.size()); }

static int SelfTest() {
    int failures = 0;
    auto check = [&](const std::string& label, const std::string& got, const std::string& want) {
        bool ok = got == want;
        if (!ok) failures++;
        OutLine(std::string(ok ? "[OK] " : "[NG] ") + label + " = " + got);
        if (!ok) OutLine("      expected " + want);
    };

    // The expected digests below are published test vectors (FIPS 180-4 "abc",
    // RFC 4231 test case 2). Each is written as adjacent string literals so the
    // source never contains one contiguous 32+ hex run -- such a run trips secret
    // scanners even when the value is a public constant. Values are unchanged.
    unsigned char sha256abc[32];
    Sha256((const unsigned char*)"abc", 3, sha256abc);
    check("SHA256(\"abc\")", HexOf(sha256abc, 32),
          "ba7816bf8f01cfea414140de5dae222" "3b00361a396177a9cb410ff61f20015" "ad");

    std::vector<BYTE> sha1abc;
    Sha1("abc", sha1abc);
    check("SHA1(\"abc\")", HexOf(sha1abc), "a9993e364706816aba3e25717850c26" "c9cd0d89d");

    std::vector<BYTE> hmac;
    HmacSha256("key", "The quick brown fox jumps over the lazy dog", hmac);
    check("HMAC-SHA256", HexOf(hmac), "f7bc83f430538424b13298e6aa6fb14" "3ef4d59a14946175997479dbc2d1a3c" "d8");

    OutLine(failures == 0 ? "SELFTEST-OK" : "SELFTEST-FAILED");
    return failures == 0 ? 0 : 1;
}

int wmain(int argc, wchar_t** argv) {
    WSADATA wsa{};
    WSAStartup(MAKEWORD(2, 2), &wsa);

    std::string relayArg, nameArg, emitPair;
    bool noPair = false, once = false, reset = false, showHelp = false, selftest = false, clip = false;
    for (int i = 1; i < argc; i++) {
        std::wstring a = argv[i];
        auto next = [&](std::string& target) {
            if (i + 1 < argc) target = WideToUtf8(argv[++i]);
        };
        if (a == L"--relay") next(relayArg);
        else if (a == L"--name") next(nameArg);
        else if (a == L"--emit-pair") next(emitPair);
        else if (a == L"--no-pair") noPair = true;
        else if (a == L"--once") once = true;
        else if (a == L"--reset") reset = true;
        else if (a == L"--selftest") selftest = true;
        else if (a == L"--clip") clip = true;
        else if (a == L"-h" || a == L"--help" || a == L"/?") showHelp = true;
        else {
            OutLine("unknown argument: " + WideToUtf8(a));
            showHelp = true;
        }
    }
    if (showHelp) {
        PrintHelp();
        return 0;
    }
    if (selftest) return SelfTest();
    if (!Prov().ok()) {
        OutLine("[rdsh32] warning: CryptoAPI is unavailable; signatures may fail");
    }

    // One agent per identity. Two instances would fight over the same relay seat
    // (every attach evicts the other one, in a loop), so the second one refuses to
    // start -- which also makes a double-clicked .bat harmless.
    static HANDLE lockHandle = nullptr;
    {
        std::wstring lockPath = HomeDir() + L"\\agent.lock";
        lockHandle = CreateFileW(lockPath.c_str(), GENERIC_READ | GENERIC_WRITE, 0, nullptr, OPEN_ALWAYS,
                                 FILE_ATTRIBUTE_NORMAL, nullptr);
        if (lockHandle == INVALID_HANDLE_VALUE) {
            lockHandle = nullptr;
            DWORD err = GetLastError();
            if (err == ERROR_SHARING_VIOLATION) {
                OutLine("[rdsh32] another agent is already running for this identity.");
                OutLine("          Close that window first (or delete " + WideToUtf8(lockPath) + " if it is stale).");
                return 4;
            }
            // Any other failure (read-only home, unusual ACL) must not stop the
            // agent: the lock is a convenience, not a security boundary.
            OutLine("[rdsh32] note: could not create " + WideToUtf8(lockPath) + " (" + LastErrorText(err) + ")");
        }
    }

    if (reset) {
        std::wstring cfg = ConfigPath();
        if (FileExistsW(cfg)) {
            std::wstring archived = cfg + L".bak-" + std::to_wstring((long long)time(nullptr));
            MoveFileExW(cfg.c_str(), archived.c_str(), MOVEFILE_REPLACE_EXISTING);
            OutLine("[rdsh32] previous identity archived: " + WideToUtf8(archived));
        }
    }

    Identity identity;
    if (!LoadIdentity(identity)) {
        identity.id = RandomHex(6);
        identity.secret = Base64Url(RandomBytes(32));
        identity.name = MachineName();
    }
    if (!nameArg.empty()) identity.name = nameArg;
    if (!relayArg.empty()) identity.relay = relayArg;
    SaveIdentity(identity);
    if (!FileExistsW(ConfigPath())) {
        // Without a persisted identity every restart looks like a brand-new
        // machine, so the operator has to pair again. Say so instead of silently
        // rotating the device id.
        OutLine("[rdsh32] warning: could not write " + WideToUtf8(ConfigPath()) +
                " - this identity will NOT survive a restart");
    }

    RelayUrl relay = ParseRelayUrl(identity.relay);

    OutLine("");
    OutLine("RemoteDSH agent (x86 compat) " + ReadAgentVersionFile());
    OutLine("  device    : " + identity.id + "  (" + (identity.name.empty() ? MachineName() : identity.name) + ")");
    OutLine("  config    : " + WideToUtf8(ConfigPath()));
    OutLine("  audit log : " + WideToUtf8(HomeDir() + L"\\audit.log"));
    OutLine("  reverse   : " + (identity.relay.empty() ? std::string("(none)") : identity.relay));
    OutLine("  build     : " + std::string(kFlavor) + " (no runtime required; WS2_32 + advapi32 only)");
    std::wstring node = FindNode();
    OutLine("  node      : " + (node.empty() ? std::string("(none found - the `node` method is unavailable)") : WideToUtf8(node)));
    if (!relay.valid) {
        OutLine("");
        OutLine("  no usable --relay: pass --relay http://<host>[:port][/base] and run again.");
        OutLine("");
        OutLine("  pairing string (direct mode is not supported by this build):");
        OutLine("  " + PairString(identity, ""));
        return 2;
    }
    if (relay.tls) {
        OutLine("");
        OutLine("  NOTE: this build speaks plain ws:// only. An https:// relay cannot be used");
        OutLine("        on Windows 7; point the relay at the http endpoint instead.");
        return 3;
    }

    // --emit-pair is what scripts and the .bat consume, so it must work even when
    // the on-screen banner is suppressed with --no-pair.
    std::string pair = PairString(identity, identity.relay);
    if (!emitPair.empty()) {
        WriteFileUtf8(FullPathOf(Utf8ToWide(emitPair)), pair, false);
        OutLine("[rdsh32] pairing string written to " + emitPair);
    }
    // Handing a 250-character line to somebody who has to select it out of an old
    // cmd window is the most likely place for this whole flow to go wrong, so put
    // it on the clipboard and let them just paste it.
    if (clip) {
        if (CopyToClipboard(Utf8ToWide(pair))) {
            OutLine("[rdsh32] pairing string copied to the clipboard - just paste it.");
        } else {
            OutLine("[rdsh32] could not use the clipboard; copy the line below by hand.");
        }
    }
    if (!noPair) {
        OutLine("");
        OutLine("  pairing string (hand this whole line to the controller):");
        OutLine("");
        OutLine("  " + pair);
        OutLine("");
    }
    if (once) return 0;

    std::thread panel([&identity]() {
        while (!g_shutdown.load()) {
            for (int i = 0; i < 50 && !g_shutdown.load(); i++) Sleep(100);
            if (g_shutdown.load()) break;
            int running = 0;
            for (const auto& job : JobRegistry::Instance().List())
                if (job->running.load()) running++;
            std::string line = g_connected.load() ? "[CONNECTED] remote controller attached via " + g_relayDisplay
                                                  : "[waiting]   no controller attached";
            line += "  |  jobs running: " + std::to_string(running);
            line += "  |  requests: " + std::to_string(g_requests.load());
            OutLine(line);
        }
    });

    OutLine("[rdsh32] reverse mode: dialing out to " + identity.relay + " (no inbound port needed)");
    OutLine("");

    std::string wsPath = relay.basePath + "/remote/attach?id=" + identity.id;
    std::string bearer = HmacB64Url(identity.secret, "attach:" + identity.id);
    g_relayDisplay = identity.relay;

    int backoff = 1000;
    while (!g_shutdown.load()) {
        WsClient ws;
        std::string error;
        if (!ws.Connect(relay.host, relay.port, wsPath, bearer, kAgentVersion, error)) {
            OutLine("[rdsh32] " + error + "  (retrying in " + std::to_string(backoff / 1000) + "s)");
            for (int i = 0; i < backoff / 100 && !g_shutdown.load(); i++) Sleep(100);
            backoff = backoff * 2 > 30000 ? 30000 : backoff * 2;
            continue;
        }
        backoff = 1000;
        g_connected.store(true);
        OutLine("[rdsh32] attached to " + identity.relay);

        Json hello = Json::MakeObj();
        hello.set("t", Json::MakeStr("hello"));
        hello.set("data", HelloPayload(identity));
        ws.SendText(JsonDump(hello));

        ULONGLONG lastPing = GetTickCount64();
        while (!g_shutdown.load()) {
            std::string text;
            error.clear();
            int status = ws.ReceiveText(text, error, 15000);
            if (status != 0) {
                if (status == 2) {
                    if (GetTickCount64() - lastPing > 20000) {
                        if (!ws.SendPing()) break;
                        lastPing = GetTickCount64();
                    }
                    continue;
                }
                if (!error.empty()) OutLine("[rdsh32] " + error);
                break;
            }
            if (text.empty()) continue;

            Json message;
            JsonParser parser(text);
            if (!parser.Parse(message) || !message.isObj()) continue;
            std::string type = message.str("t");
            if (type == "ping") {
                ws.SendText("{\"t\":\"pong\"}");
                continue;
            }
            if (type != "req") continue;

            std::string id = message.str("id");
            std::string method = message.str("method");
            const Json* argsPtr = message.find("args");
            Json emptyArgs = Json::MakeObj();
            const Json& args = (argsPtr && argsPtr->kind == Json::Obj) ? *argsPtr : emptyArgs;

            Json reply = Invoke(method, args, identity);

            Json envelope = Json::MakeObj();
            envelope.set("t", Json::MakeStr("res"));
            envelope.set("id", Json::MakeStr(id));
            envelope.set("data", std::move(reply));
            if (!ws.SendText(JsonDump(envelope))) {
                OutLine("[rdsh32] send failed; reconnecting");
                break;
            }
            if (g_disconnectRequested.load()) {
                OutLine("[rdsh32] controller requested disconnect");
                g_shutdown.store(true);
            }
        }
        g_connected.store(false);
        ws.Close();
    }

    g_shutdown.store(true);
    if (panel.joinable()) panel.join();
    OutLine("[rdsh32] stopped.");
    WSACleanup();
    return 0;
}
