// 子铭软件授权 API · C# 示例（Preview）
//
// 成功路径：挑战 → 签名 → 激活 → 心跳
// 失败路径：无效授权码 → 422 LICENSE_INVALID → LicenseRejectedException
//
// 依赖：BouncyCastle.Cryptography（.NET Framework 没有内置 Ed25519）。
//   nuget install BouncyCastle.Cryptography -Version 2.6.2 -OutputDirectory packages
//   mcs -out:/tmp/csharp-example/Quickstart.exe \
//       -r:packages/BouncyCastle.Cryptography.2.6.2/lib/net461/BouncyCastle.Cryptography.dll \
//       sdk-examples/csharp/Quickstart.cs
//
// 运行时 dll 必须和 exe 同目录，否则报
//   FileNotFoundException: Could not load file or assembly 'BouncyCastle.Cryptography'
//   cp packages/BouncyCastle.Cryptography.2.6.2/lib/net461/BouncyCastle.Cryptography.dll /tmp/csharp-example/
//
//   mono /tmp/csharp-example/Quickstart.exe
//
// 标 Preview 而不是 Stable：这是示例代码，不是已发布的 SDK。

using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Net.Http;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading.Tasks;
using Org.BouncyCastle.Crypto;
using Org.BouncyCastle.Crypto.Generators;
using Org.BouncyCastle.Crypto.Parameters;
using Org.BouncyCastle.Crypto.Signers;
using Org.BouncyCastle.Pkcs;
using Org.BouncyCastle.Security;
using Org.BouncyCastle.X509;

public class Quickstart
{
    /// <summary>默认指向 Sandbox 占位符：生产域名属于部署信息，不进示例。</summary>
    private const string DefaultBase = "https://<LICENSE_SANDBOX_DOMAIN>/api/v1";
    private const string DefaultClientId = "";

    // ------------------------------------------------------------ 异常

    /// <summary>所有授权错误的基类，字段与 API 信封一一对应。</summary>
    public class LicenseException : Exception
    {
        public string Code { get; }
        public string RequestId { get; }
        public int Status { get; }

        public LicenseException(string code, string message, string requestId, int status)
            : base(code + ": " + message)
        {
            Code = code;
            RequestId = requestId;
            Status = status;
        }
    }

    // 每类错误单独一个类型，调用方才能 catch 到具体类别，而不是比对字符串。
    public sealed class AuthenticationException : LicenseException
    {
        public AuthenticationException(string c, string m, string r, int s) : base(c, m, r, s) { }
    }
    public sealed class LicenseRejectedException : LicenseException
    {
        public LicenseRejectedException(string c, string m, string r, int s) : base(c, m, r, s) { }
    }
    public sealed class LicenseExpiredException : LicenseException
    {
        public LicenseExpiredException(string c, string m, string r, int s) : base(c, m, r, s) { }
    }
    public sealed class LicenseSuspendedException : LicenseException
    {
        public LicenseSuspendedException(string c, string m, string r, int s) : base(c, m, r, s) { }
    }
    public sealed class DeviceLimitException : LicenseException
    {
        public DeviceLimitException(string c, string m, string r, int s) : base(c, m, r, s) { }
    }
    public sealed class ActivationLimitException : LicenseException
    {
        public ActivationLimitException(string c, string m, string r, int s) : base(c, m, r, s) { }
    }
    public sealed class RateLimitException : LicenseException
    {
        public RateLimitException(string c, string m, string r, int s) : base(c, m, r, s) { }
    }
    public sealed class ServiceDownException : LicenseException
    {
        public ServiceDownException(string c, string m, string r, int s) : base(c, m, r, s) { }
    }

    static LicenseException MapError(string code, string message, string requestId, int status)
    {
        switch (code)
        {
            case "CLIENT_AUTH_FAILED":
            case "FORBIDDEN":
                return new AuthenticationException(code, message, requestId, status);
            case "LICENSE_INVALID":
            case "PRODUCT_MISMATCH":
                return new LicenseRejectedException(code, message, requestId, status);
            case "LICENSE_EXPIRED":
            case "ACTIVATION_WINDOW_EXPIRED":
                return new LicenseExpiredException(code, message, requestId, status);
            case "LICENSE_SUSPENDED":
            case "DEVICE_BLOCKED":
                return new LicenseSuspendedException(code, message, requestId, status);
            case "DEVICE_LIMIT_EXCEEDED":
                return new DeviceLimitException(code, message, requestId, status);
            case "ACTIVATION_LIMIT_REACHED":
                return new ActivationLimitException(code, message, requestId, status);
            case "RATE_LIMITED":
                return new RateLimitException(code, message, requestId, status);
            case "LICENSE_SERVICE_UNAVAILABLE":
                return new ServiceDownException(code, message, requestId, status);
            default:
                return new LicenseException(code, message, requestId, status);
        }
    }

    // ------------------------------------------------------------ HTTP 客户端

    private static readonly HttpClient Http = CreateClient();
    private readonly string _baseUrl;
    private readonly string _clientId;

    static HttpClient CreateClient()
    {
        var client = new HttpClient { Timeout = TimeSpan.FromSeconds(15) };
        // 超时必须设：不设超时的客户端在服务端卡住时会永远挂住。
        client.DefaultRequestHeaders.TryAddWithoutValidation("Accept", "application/json");
        return client;
    }

    Quickstart(string baseUrl, string clientId)
    {
        _baseUrl = baseUrl;
        _clientId = clientId;
    }

    /// <summary>极简 JSON 信封解析：示例只依赖 BouncyCastle，不引第三方 JSON 库。</summary>
    Dictionary<string, object> Post(string path, string jsonBody, Dictionary<string, string> headers)
    {
        var request = new HttpRequestMessage(HttpMethod.Post, _baseUrl + path)
        {
            Content = new StringContent(jsonBody, Encoding.UTF8, "application/json"),
        };
        request.Headers.TryAddWithoutValidation("X-Client-ID", _clientId);
        request.Headers.TryAddWithoutValidation("X-SDK-Version", "csharp-example/1.5.0");
        if (headers != null)
        {
            foreach (var pair in headers) request.Headers.TryAddWithoutValidation(pair.Key, pair.Value);
        }

        HttpResponseMessage response;
        string body;
        try
        {
            response = Http.SendAsync(request).GetAwaiter().GetResult();
            body = response.Content.ReadAsStringAsync().GetAwaiter().GetResult();
        }
        catch (Exception e)
        {
            // 网络层失败没有 code 可用，单独给一个本地码，避免调用方去解析英文报错。
            throw new LicenseException("NETWORK_ERROR", e.Message, null, 0);
        }

        var envelope = Json.ParseObject(body);
        if (envelope == null)
        {
            throw new LicenseException("UNEXPECTED_RESPONSE", Truncate(body, 200), null, (int)response.StatusCode);
        }
        // 成功也检查 ok，不靠 HTTP 状态码猜。
        if (!(envelope.TryGetValue("ok", out var ok) && ok is bool b && b))
        {
            throw MapError(
                AsString(envelope, "code"),
                AsString(envelope, "message"),
                AsString(envelope, "request_id"),
                (int)response.StatusCode);
        }
        return envelope.TryGetValue("data", out var data) ? data as Dictionary<string, object> : null;
    }

    static string AsString(Dictionary<string, object> map, string key)
    {
        return map != null && map.TryGetValue(key, out var value) && value != null
            ? Convert.ToString(value, CultureInfo.InvariantCulture)
            : null;
    }

    static string Truncate(string s, int n)
    {
        if (s == null) return null;
        return s.Length <= n ? s : s.Substring(0, n);
    }

    // ------------------------------------------------------------ 设备密钥

    /// <summary>
    /// 首次生成并持久化；生产环境请把私钥交给系统凭据库
    /// （Windows DPAPI / macOS Keychain / Linux libsecret）。
    /// </summary>
    static AsymmetricCipherKeyPair LoadOrCreateDeviceKey(string dir)
    {
        Directory.CreateDirectory(dir);
        var privatePath = Path.Combine(dir, "ziming-example-device.pk8");
        var publicPath = Path.Combine(dir, "ziming-example-device.spki");

        if (File.Exists(privatePath) && File.Exists(publicPath))
        {
            var priv = (Ed25519PrivateKeyParameters)PrivateKeyFactory.CreateKey(File.ReadAllBytes(privatePath));
            var pub = (Ed25519PublicKeyParameters)PublicKeyFactory.CreateKey(File.ReadAllBytes(publicPath));
            return new AsymmetricCipherKeyPair(pub, priv);
        }

        var generator = new Ed25519KeyPairGenerator();
        generator.Init(new Ed25519KeyGenerationParameters(new SecureRandom()));
        var pair = generator.GenerateKeyPair();

        // BouncyCastle 的 GetEncoded() 已经是 PKCS#8 / SPKI，不用手工补前缀。
        File.WriteAllBytes(privatePath, PrivateKeyInfoFactory.CreatePrivateKeyInfo(pair.Private).GetDerEncoded());
        File.WriteAllBytes(publicPath,
            SubjectPublicKeyInfoFactory.CreateSubjectPublicKeyInfo(pair.Public).GetDerEncoded());
        return pair;
    }

    static string B64(byte[] raw)
    {
        return Convert.ToBase64String(raw).TrimEnd('=').Replace('+', '-').Replace('/', '_');
    }

    // ------------------------------------------------------------ 业务动作

    sealed class Activation
    {
        public string ActivationId;
        public string EffectiveStatus;
        public string ExpiresAt;
        public Dictionary<string, object> Entitlements;
        public string RefreshToken;
    }

    sealed class Heartbeat
    {
        public string EffectiveStatus;
        public int EntitlementsVersion;
        public int NextHeartbeatSeconds;
    }

    Activation Activate(string productId, string licenseKey, string deviceId,
                        AsymmetricCipherKeyPair keyPair, string publicKeyB64)
    {
        var device = new Dictionary<string, object>
        {
            ["device_instance_id"] = deviceId,
            ["platform"] = "linux",
            ["device_name"] = "Example Host",
            ["public_key"] = publicKeyB64,
        };

        var challengeBody = new Dictionary<string, object>
        {
            ["product_id"] = productId,
            ["device"] = device,
        };
        var challenge = Post("/activation-challenges", Json.Write(challengeBody),
            new Dictionary<string, string>());

        // 直接对 canonical_message 的原始字节签名，不要自己拼字符串。
        var canonicalMessage = AsString(challenge, "canonical_message");
        var signer = new Ed25519Signer();
        signer.Init(true, keyPair.Private);
        var messageBytes = Encoding.UTF8.GetBytes(canonicalMessage);
        signer.BlockUpdate(messageBytes, 0, messageBytes.Length);
        var signature = B64(signer.GenerateSignature());

        var signedDevice = new Dictionary<string, object>(device) { ["signature"] = signature };

        var client = new Dictionary<string, object>
        {
            ["app_version"] = "1.5.0",
            ["sdk_version"] = "csharp-example",
        };

        var activationBody = new Dictionary<string, object>
        {
            ["product_id"] = productId,
            ["license_key"] = licenseKey,
            ["challenge_id"] = AsString(challenge, "challenge_id"),
            ["device"] = signedDevice,
            ["client"] = client,
        };

        var data = Post("/activations", Json.Write(activationBody), new Dictionary<string, string>
        {
            ["Idempotency-Key"] = "activate-" + deviceId + "-" + Last4(licenseKey),
        });

        return new Activation
        {
            ActivationId = AsString(data, "activation_id"),
            EffectiveStatus = AsString(data, "effective_status"),
            ExpiresAt = AsString(data, "expires_at"),
            Entitlements = data != null && data.TryGetValue("entitlements", out var ent)
                ? ent as Dictionary<string, object>
                : null,
            RefreshToken = AsString(data, "refresh_token"),
        };
    }

    static string Last4(string s)
    {
        return s.Length <= 4 ? s : s.Substring(s.Length - 4);
    }

    Heartbeat SendHeartbeat(Activation activation)
    {
        var body = new Dictionary<string, object>
        {
            ["activation_id"] = activation.ActivationId,
            ["refresh_token"] = activation.RefreshToken,
            ["client"] = new Dictionary<string, object>
            {
                ["app_version"] = "1.5.0",
                ["sdk_version"] = "csharp-example",
            },
        };

        var data = Post("/activations/heartbeat", Json.Write(body), new Dictionary<string, string>());
        return new Heartbeat
        {
            EffectiveStatus = AsString(data, "effective_status"),
            EntitlementsVersion = ToInt(data, "entitlements_version"),
            NextHeartbeatSeconds = ToInt(data, "next_heartbeat_seconds"),
        };
    }

    static int ToInt(Dictionary<string, object> map, string key)
    {
        if (map != null && map.TryGetValue(key, out var value) && value != null)
        {
            return Convert.ToInt32(value, CultureInfo.InvariantCulture);
        }
        return 0;
    }

    // ------------------------------------------------------------ main

    public static void Main(string[] args)
    {
        var baseUrl = Env("LICENSE_BASE_URL", DefaultBase).TrimEnd('/');
        var clientId = Env("LICENSE_CLIENT_ID", DefaultClientId);
        var productId = Env("LICENSE_PRODUCT_ID", "");
        var licenseKey = Env("LICENSE_KEY", "");
        var keyDir = Env("LICENSE_KEY_DIR", Path.GetTempPath());

        var missing = new List<string>();
        // 不再内置真实 client_id：必须由使用者从后台创建凭证后传入。
        if (clientId.Length == 0) missing.Add("LICENSE_CLIENT_ID");
        if (productId.Length == 0) missing.Add("LICENSE_PRODUCT_ID");
        if (licenseKey.Length == 0) missing.Add("LICENSE_KEY");
        if (missing.Count > 0)
        {
            Console.Error.WriteLine("缺少环境变量：" + string.Join(", ", missing));
            Environment.Exit(2);
        }

        var keyPair = LoadOrCreateDeviceKey(keyDir);
        var publicKeyB64 = B64(
            SubjectPublicKeyInfoFactory.CreateSubjectPublicKeyInfo(keyPair.Public).GetDerEncoded());

        var app = new Quickstart(baseUrl, clientId);
        var deviceId = "csharp-example-" + DateTime.UtcNow.Ticks.ToString("x");

        Console.WriteLine("== 成功路径 ==");
        var activation = app.Activate(productId, licenseKey, deviceId, keyPair, publicKeyB64);
        Console.WriteLine("activation_id   : " + activation.ActivationId);
        Console.WriteLine("effective_status: " + activation.EffectiveStatus);
        Console.WriteLine("expires_at      : " + (activation.ExpiresAt ?? "永久"));
        Console.WriteLine("entitlements    : " + Json.Write(activation.Entitlements));

        var beat = app.SendHeartbeat(activation);
        Console.WriteLine(string.Format(CultureInfo.InvariantCulture,
            "heartbeat       : {0}  version={1}  next={2}s",
            beat.EffectiveStatus, beat.EntitlementsVersion, beat.NextHeartbeatSeconds));

        Console.WriteLine();
        Console.WriteLine("== 失败路径 ==");
        try
        {
            app.Activate(productId, "ZZZZZZ-ZZZZZZ-ZZZZZZ-ZZZZZZ-ZZZZZZ", "csharp-example-bad",
                keyPair, publicKeyB64);
            Console.Error.WriteLine("期望失败，实际却成功了");
            Environment.Exit(1);
        }
        catch (LicenseRejectedException e)
        {
            Console.WriteLine(string.Format("已被拒绝（预期）: {0}  request_id={1}", e.Code, e.RequestId));
        }
    }

    static string Env(string key, string fallback)
    {
        var value = Environment.GetEnvironmentVariable(key);
        return string.IsNullOrEmpty(value) ? fallback : value;
    }

    // ------------------------------------------------------------ 极简 JSON

    /// <summary>
    /// 只为示例服务的 JSON 读写：够用即可，不追求完整实现。
    /// 真实项目请用 System.Text.Json / Newtonsoft.Json。
    /// </summary>
    public static class Json
    {
        public static string Write(object value)
        {
            var sb = new StringBuilder();
            WriteValue(sb, value);
            return sb.ToString();
        }

        static void WriteValue(StringBuilder sb, object value)
        {
            if (value == null)
            {
                sb.Append("null");
            }
            else if (value is string s)
            {
                sb.Append('"').Append(Escape(s)).Append('"');
            }
            else if (value is bool bo)
            {
                sb.Append(bo ? "true" : "false");
            }
            else if (value is int || value is long || value is double || value is float || value is decimal)
            {
                sb.Append(Convert.ToString(value, CultureInfo.InvariantCulture));
            }
            else if (value is IDictionary<string, object> map)
            {
                sb.Append('{');
                var first = true;
                foreach (var pair in map)
                {
                    if (!first) sb.Append(',');
                    first = false;
                    sb.Append('"').Append(Escape(pair.Key)).Append("\":");
                    WriteValue(sb, pair.Value);
                }
                sb.Append('}');
            }
            else if (value is System.Collections.IEnumerable items)
            {
                sb.Append('[');
                var first = true;
                foreach (var item in items)
                {
                    if (!first) sb.Append(',');
                    first = false;
                    WriteValue(sb, item);
                }
                sb.Append(']');
            }
            else
            {
                WriteValue(sb, Convert.ToString(value, CultureInfo.InvariantCulture));
            }
        }

        public static string Escape(string s)
        {
            var sb = new StringBuilder(s.Length + 8);
            foreach (var c in s)
            {
                switch (c)
                {
                    case '"': sb.Append("\\\""); break;
                    case '\\': sb.Append("\\\\"); break;
                    case '\n': sb.Append("\\n"); break;
                    case '\r': sb.Append("\\r"); break;
                    case '\t': sb.Append("\\t"); break;
                    default:
                        if (c < 0x20) sb.Append("\\u").Append(((int)c).ToString("x4"));
                        else sb.Append(c);
                        break;
                }
            }
            return sb.ToString();
        }

        static readonly Regex StringPattern =
            new Regex("\"((?:[^\"\\\\]|\\\\.)*)\"(?=\\s*[:,\\]}])", RegexOptions.Compiled);

        /// <summary>只解析「对象 / 数组 / 字符串 / 数字 / 布尔 / null」这六种值。</summary>
        public static Dictionary<string, object> ParseObject(string text)
        {
            if (text == null) return null;
            var parser = new Parser(text);
            return parser.ParseValue() as Dictionary<string, object>;
        }

        sealed class Parser
        {
            private readonly string _text;
            private int _pos;

            public Parser(string text) { _text = text; }

            public object ParseValue()
            {
                SkipWhitespace();
                if (_pos >= _text.Length) return null;
                var c = _text[_pos];
                if (c == '{') return ParseObjectValue();
                if (c == '[') return ParseArray();
                if (c == '"') return ParseString();
                if (Match("true")) return true;
                if (Match("false")) return false;
                if (Match("null")) return null;
                return ParseNumber();
            }

            bool Match(string literal)
            {
                if (_pos + literal.Length <= _text.Length && _text.Substring(_pos, literal.Length) == literal)
                {
                    _pos += literal.Length;
                    return true;
                }
                return false;
            }

            Dictionary<string, object> ParseObjectValue()
            {
                var map = new Dictionary<string, object>();
                _pos++; // {
                SkipWhitespace();
                if (_pos < _text.Length && _text[_pos] == '}') { _pos++; return map; }
                while (_pos < _text.Length)
                {
                    SkipWhitespace();
                    var key = ParseString();
                    SkipWhitespace();
                    _pos++; // :
                    map[key] = ParseValue();
                    SkipWhitespace();
                    var c = _text[_pos++];
                    if (c == '}') break;
                }
                return map;
            }

            List<object> ParseArray()
            {
                var list = new List<object>();
                _pos++; // [
                SkipWhitespace();
                if (_pos < _text.Length && _text[_pos] == ']') { _pos++; return list; }
                while (_pos < _text.Length)
                {
                    list.Add(ParseValue());
                    SkipWhitespace();
                    var c = _text[_pos++];
                    if (c == ']') break;
                }
                return list;
            }

            string ParseString()
            {
                var match = StringPattern.Match(_text, _pos);
                if (match.Success && match.Index == _pos)
                {
                    _pos = match.Index + match.Length;
                    return Unescape(match.Groups[1].Value);
                }
                // 兜底：手工扫描到下一个未转义双引号。
                _pos++; // opening quote
                var sb = new StringBuilder();
                while (_pos < _text.Length)
                {
                    var c = _text[_pos++];
                    if (c == '\\')
                    {
                        sb.Append(c).Append(_text[_pos++]);
                    }
                    else if (c == '"')
                    {
                        break;
                    }
                    else
                    {
                        sb.Append(c);
                    }
                }
                return Unescape(sb.ToString());
            }

            object ParseNumber()
            {
                var start = _pos;
                while (_pos < _text.Length && "-+.eE0123456789".IndexOf(_text[_pos]) >= 0) _pos++;
                var raw = _text.Substring(start, _pos - start);
                if (raw.IndexOf('.') >= 0 || raw.IndexOf('e') >= 0 || raw.IndexOf('E') >= 0)
                {
                    return double.Parse(raw, CultureInfo.InvariantCulture);
                }
                return long.Parse(raw, CultureInfo.InvariantCulture);
            }

            void SkipWhitespace()
            {
                while (_pos < _text.Length && char.IsWhiteSpace(_text[_pos])) _pos++;
            }

            static string Unescape(string s)
            {
                if (s.IndexOf('\\') < 0) return s;
                var sb = new StringBuilder(s.Length);
                for (var i = 0; i < s.Length; i++)
                {
                    var c = s[i];
                    if (c != '\\') { sb.Append(c); continue; }
                    var next = s[++i];
                    switch (next)
                    {
                        case 'n': sb.Append('\n'); break;
                        case 'r': sb.Append('\r'); break;
                        case 't': sb.Append('\t'); break;
                        case 'b': sb.Append('\b'); break;
                        case 'f': sb.Append('\f'); break;
                        case 'u':
                            sb.Append((char)int.Parse(s.Substring(i + 1, 4), NumberStyles.HexNumber,
                                CultureInfo.InvariantCulture));
                            i += 4;
                            break;
                        default: sb.Append(next); break;
                    }
                }
                return sb.ToString();
            }
        }
    }
}
