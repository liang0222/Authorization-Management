// 子铭软件授权 API · Java 示例（Preview）
//
// 成功路径：挑战 → 签名 → 激活 → 心跳
// 失败路径：无效授权码 → 422 LICENSE_INVALID → LicenseRejectedException
//
// 只依赖 JDK 17+ 标准库（java.net.http、java.security 的 Ed25519）。
// JDK 15 起内置 Ed25519，不需要 BouncyCastle。
//
//   javac -d /tmp/java-example sdk-examples/java/Quickstart.java
//   java -cp /tmp/java-example Quickstart
//
// 标 Preview 而不是 Stable：这是示例代码，不是已发布的 SDK。

import java.io.IOException;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.GeneralSecurityException;
import java.security.KeyFactory;
import java.security.KeyPair;
import java.security.KeyPairGenerator;
import java.security.PrivateKey;
import java.security.PublicKey;
import java.security.Signature;
import java.security.spec.PKCS8EncodedKeySpec;
import java.security.spec.X509EncodedKeySpec;
import java.time.Duration;
import java.util.Base64;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

public final class Quickstart {

    /** 默认指向 Sandbox 占位符：生产域名属于部署信息，不进示例。 */
    private static final String DEFAULT_BASE = "https://<LICENSE_SANDBOX_DOMAIN>/api/v1";
    private static final String DEFAULT_CLIENT_ID = "";

    // ------------------------------------------------------------ 异常

    /** 所有授权错误的基类，字段与 API 信封一一对应。 */
    public static class LicenseException extends RuntimeException {
        final String code;
        final String requestId;
        final int status;

        LicenseException(String code, String message, String requestId, int status) {
            super(code + ": " + message);
            this.code = code;
            this.requestId = requestId;
            this.status = status;
        }
    }

    // 每类错误单独一个类型，调用方才能 catch 到具体类别，而不是比对字符串。
    public static final class AuthenticationException extends LicenseException {
        AuthenticationException(String c, String m, String r, int s) { super(c, m, r, s); }
    }
    public static final class LicenseRejectedException extends LicenseException {
        LicenseRejectedException(String c, String m, String r, int s) { super(c, m, r, s); }
    }
    public static final class LicenseExpiredException extends LicenseException {
        LicenseExpiredException(String c, String m, String r, int s) { super(c, m, r, s); }
    }
    public static final class LicenseSuspendedException extends LicenseException {
        LicenseSuspendedException(String c, String m, String r, int s) { super(c, m, r, s); }
    }
    public static final class DeviceLimitException extends LicenseException {
        DeviceLimitException(String c, String m, String r, int s) { super(c, m, r, s); }
    }
    public static final class ActivationLimitException extends LicenseException {
        ActivationLimitException(String c, String m, String r, int s) { super(c, m, r, s); }
    }
    public static final class RateLimitException extends LicenseException {
        RateLimitException(String c, String m, String r, int s) { super(c, m, r, s); }
    }
    public static final class ServiceDownException extends LicenseException {
        ServiceDownException(String c, String m, String r, int s) { super(c, m, r, s); }
    }

    static LicenseException mapError(String code, String message, String requestId, int status) {
        return switch (code) {
            case "CLIENT_AUTH_FAILED", "FORBIDDEN" -> new AuthenticationException(code, message, requestId, status);
            case "LICENSE_INVALID", "PRODUCT_MISMATCH" ->
                new LicenseRejectedException(code, message, requestId, status);
            case "LICENSE_EXPIRED", "ACTIVATION_WINDOW_EXPIRED" ->
                new LicenseExpiredException(code, message, requestId, status);
            case "LICENSE_SUSPENDED", "DEVICE_BLOCKED" ->
                new LicenseSuspendedException(code, message, requestId, status);
            case "DEVICE_LIMIT_EXCEEDED" -> new DeviceLimitException(code, message, requestId, status);
            case "ACTIVATION_LIMIT_REACHED" -> new ActivationLimitException(code, message, requestId, status);
            case "RATE_LIMITED" -> new RateLimitException(code, message, requestId, status);
            case "LICENSE_SERVICE_UNAVAILABLE" ->
                new ServiceDownException(code, message, requestId, status);
            default -> new LicenseException(code, message, requestId, status);
        };
    }

    // ------------------------------------------------------------ HTTP 客户端

    private final HttpClient http = HttpClient.newBuilder()
            // 必须显式固定 HTTP/1.1。JDK 的 HttpClient 默认 HTTP/2，对明文 http://
            // 会先发 h2c 升级请求（Connection: Upgrade, HTTP2-Settings）；不认这个
            // 升级的服务端会直接关连接，客户端拿到的是
            //   IOException: HTTP/1.1 header parser received no bytes
            // 而不是任何 HTTP 状态码。JDK 不会自动回退到 HTTP/1.1。
            .version(HttpClient.Version.HTTP_1_1)
            // 超时必须设：不设超时的客户端在服务端卡住时会永远挂住。
            .connectTimeout(Duration.ofSeconds(5))
            .build();
    private final String baseUrl;
    private final String clientId;

    Quickstart(String baseUrl, String clientId) {
        this.baseUrl = baseUrl;
        this.clientId = clientId;
    }

    /** 极简 JSON 信封解析：示例只依赖 JDK，不引第三方 JSON 库。 */
    Map<String, Object> post(String path, String jsonBody, Map<String, String> headers) {
        HttpRequest.Builder builder = HttpRequest.newBuilder()
                .uri(URI.create(baseUrl + path))
                .timeout(Duration.ofSeconds(15))
                .header("Content-Type", "application/json")
                .header("Accept", "application/json")
                .header("X-Client-ID", clientId)
                .header("X-SDK-Version", "java-example/1.5.0")
                .POST(HttpRequest.BodyPublishers.ofString(jsonBody, StandardCharsets.UTF_8));
        headers.forEach(builder::header);

        HttpResponse<String> response;
        try {
            response = http.send(builder.build(), HttpResponse.BodyHandlers.ofString(StandardCharsets.UTF_8));
        } catch (IOException e) {
            // 网络层失败没有 code 可用，单独给一个本地码，避免调用方去解析英文报错。
            throw new LicenseException("NETWORK_ERROR", e.getMessage(), null, 0);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new LicenseException("NETWORK_ERROR", "interrupted", null, 0);
        }

        Map<String, Object> envelope = Json.parseObject(response.body());
        if (envelope == null) {
            throw new LicenseException("UNEXPECTED_RESPONSE", truncate(response.body(), 200), null,
                    response.statusCode());
        }
        // 成功也检查 ok，不靠 HTTP 状态码猜。
        if (!Boolean.TRUE.equals(envelope.get("ok"))) {
            throw mapError(
                    String.valueOf(envelope.get("code")),
                    String.valueOf(envelope.get("message")),
                    envelope.get("request_id") == null ? null : String.valueOf(envelope.get("request_id")),
                    response.statusCode());
        }
        @SuppressWarnings("unchecked")
        Map<String, Object> data = (Map<String, Object>) envelope.get("data");
        return data;
    }

    static String truncate(String s, int n) {
        return s.length() <= n ? s : s.substring(0, n);
    }

    // ------------------------------------------------------------ 设备密钥

    /**
     * 首次生成并持久化；生产环境请把私钥交给系统凭据库
     * （Windows DPAPI / macOS Keychain / Linux libsecret）。
     */
    static KeyPair loadOrCreateDeviceKey(Path dir) throws IOException, GeneralSecurityException {
        Files.createDirectories(dir);
        Path privatePath = dir.resolve("ziming-example-device.pk8");
        Path publicPath = dir.resolve("ziming-example-device.spki");

        if (Files.exists(privatePath) && Files.exists(publicPath)) {
            KeyFactory factory = KeyFactory.getInstance("Ed25519");
            PrivateKey privateKey = factory.generatePrivate(
                    new PKCS8EncodedKeySpec(Files.readAllBytes(privatePath)));
            PublicKey publicKey = factory.generatePublic(
                    new X509EncodedKeySpec(Files.readAllBytes(publicPath)));
            return new KeyPair(publicKey, privateKey);
        }

        KeyPair pair = KeyPairGenerator.getInstance("Ed25519").generateKeyPair();
        Files.write(privatePath, pair.getPrivate().getEncoded());
        Files.write(publicPath, pair.getPublic().getEncoded());
        return pair;
    }

    static String b64(byte[] raw) {
        return Base64.getUrlEncoder().withoutPadding().encodeToString(raw);
    }

    // ------------------------------------------------------------ 业务动作

    record Activation(String activationId, String effectiveStatus, String expiresAt,
                      Map<String, Object> entitlements, String refreshToken) {}

    record Heartbeat(String effectiveStatus, int entitlementsVersion, int nextHeartbeatSeconds) {}

    Activation activate(String productId, String licenseKey, String deviceId, PrivateKey privateKey,
                        String publicKeyB64) throws GeneralSecurityException {
        Map<String, Object> device = new LinkedHashMap<>();
        device.put("device_instance_id", deviceId);
        device.put("platform", "linux");
        device.put("device_name", "Example Host");
        device.put("public_key", publicKeyB64);

        Map<String, Object> challengeBody = new LinkedHashMap<>();
        challengeBody.put("product_id", productId);
        challengeBody.put("device", device);
        Map<String, Object> challenge = post("/activation-challenges", Json.write(challengeBody), Map.of());

        // 直接对 canonical_message 的原始字节签名，不要自己拼字符串。
        String canonicalMessage = String.valueOf(challenge.get("canonical_message"));
        Signature signer = Signature.getInstance("Ed25519");
        signer.initSign(privateKey);
        signer.update(canonicalMessage.getBytes(StandardCharsets.UTF_8));
        String signature = b64(signer.sign());

        Map<String, Object> signedDevice = new LinkedHashMap<>(device);
        signedDevice.put("signature", signature);

        Map<String, Object> client = new LinkedHashMap<>();
        client.put("app_version", "1.5.0");
        client.put("sdk_version", "java-example");

        Map<String, Object> activationBody = new LinkedHashMap<>();
        activationBody.put("product_id", productId);
        activationBody.put("license_key", licenseKey);
        activationBody.put("challenge_id", challenge.get("challenge_id"));
        activationBody.put("device", signedDevice);
        activationBody.put("client", client);

        Map<String, Object> data = post("/activations", Json.write(activationBody),
                Map.of("Idempotency-Key", "activate-" + deviceId + "-" + last4(licenseKey)));

        @SuppressWarnings("unchecked")
        Map<String, Object> entitlements = (Map<String, Object>) data.get("entitlements");
        return new Activation(
                String.valueOf(data.get("activation_id")),
                String.valueOf(data.get("effective_status")),
                data.get("expires_at") == null ? null : String.valueOf(data.get("expires_at")),
                entitlements,
                String.valueOf(data.get("refresh_token")));
    }

    static String last4(String s) {
        return s.length() <= 4 ? s : s.substring(s.length() - 4);
    }

    Heartbeat heartbeat(Activation activation) {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("activation_id", activation.activationId());
        body.put("refresh_token", activation.refreshToken());
        Map<String, Object> client = new LinkedHashMap<>();
        client.put("app_version", "1.5.0");
        client.put("sdk_version", "java-example");
        body.put("client", client);

        Map<String, Object> data = post("/activations/heartbeat", Json.write(body), Map.of());
        return new Heartbeat(
                String.valueOf(data.get("effective_status")),
                ((Number) data.get("entitlements_version")).intValue(),
                ((Number) data.get("next_heartbeat_seconds")).intValue());
    }

    // ------------------------------------------------------------ main

    public static void main(String[] args) throws Exception {
        String baseUrl = env("LICENSE_BASE_URL", DEFAULT_BASE).replaceAll("/+$", "");
        String clientId = env("LICENSE_CLIENT_ID", DEFAULT_CLIENT_ID);
        String productId = env("LICENSE_PRODUCT_ID", "");
        String licenseKey = env("LICENSE_KEY", "");
        Path keyDir = Path.of(env("LICENSE_KEY_DIR", System.getProperty("java.io.tmpdir")));

        List<String> missing = new java.util.ArrayList<>();
        // 不再内置真实 client_id：必须由使用者从后台创建凭证后传入。
        if (clientId.isEmpty()) missing.add("LICENSE_CLIENT_ID");
        if (productId.isEmpty()) missing.add("LICENSE_PRODUCT_ID");
        if (licenseKey.isEmpty()) missing.add("LICENSE_KEY");
        if (!missing.isEmpty()) {
            System.err.println("缺少环境变量：" + String.join(", ", missing));
            System.exit(2);
        }

        KeyPair pair = loadOrCreateDeviceKey(keyDir);
        // JDK 的 Ed25519 公钥本身就是 X.509/SPKI 编码，无需手工补前缀。
        String publicKeyB64 = Base64.getUrlEncoder().withoutPadding()
                .encodeToString(pair.getPublic().getEncoded());

        Quickstart app = new Quickstart(baseUrl, clientId);
        String deviceId = "java-example-" + Long.toHexString(System.nanoTime());

        System.out.println("== 成功路径 ==");
        Activation activation = app.activate(productId, licenseKey, deviceId, pair.getPrivate(), publicKeyB64);
        System.out.println("activation_id   : " + activation.activationId());
        System.out.println("effective_status: " + activation.effectiveStatus());
        System.out.println("expires_at      : " + (activation.expiresAt() == null ? "永久" : activation.expiresAt()));
        System.out.println("entitlements    : " + Json.write(activation.entitlements()));

        Heartbeat beat = app.heartbeat(activation);
        System.out.printf("heartbeat       : %s  version=%d  next=%ds%n",
                beat.effectiveStatus(), beat.entitlementsVersion(), beat.nextHeartbeatSeconds());

        System.out.println();
        System.out.println("== 失败路径 ==");
        try {
            app.activate(productId, "ZZZZZZ-ZZZZZZ-ZZZZZZ-ZZZZZZ-ZZZZZZ", "java-example-bad",
                    pair.getPrivate(), publicKeyB64);
            System.err.println("期望失败，实际却成功了");
            System.exit(1);
        } catch (LicenseRejectedException e) {
            System.out.printf("已被拒绝（预期）: %s  request_id=%s%n", e.code, e.requestId);
        }
    }

    static String env(String key, String fallback) {
        String value = System.getenv(key);
        return value == null || value.isEmpty() ? fallback : value;
    }

    // ------------------------------------------------------------ 极简 JSON

    /**
     * 只为示例服务的 JSON 读写：够用即可，不追求完整实现。
     * 真实项目请用 Jackson / Gson。
     */
    static final class Json {
        private static final Pattern STRING =
                Pattern.compile("\"((?:[^\"\\\\]|\\\\.)*)\"(?=\\s*[:,\\]}])");
        private static final Pattern FIELD =
                Pattern.compile("\"((?:[^\"\\\\]|\\\\.)*)\"\\s*:\\s*");

        static String write(Object value) {
            StringBuilder sb = new StringBuilder();
            writeValue(sb, value);
            return sb.toString();
        }

        private static void writeValue(StringBuilder sb, Object value) {
            if (value == null) {
                sb.append("null");
            } else if (value instanceof String s) {
                sb.append('"').append(escape(s)).append('"');
            } else if (value instanceof Number || value instanceof Boolean) {
                sb.append(value);
            } else if (value instanceof Map<?, ?> map) {
                sb.append('{');
                boolean first = true;
                for (Map.Entry<?, ?> entry : map.entrySet()) {
                    if (!first) sb.append(',');
                    first = false;
                    sb.append('"').append(escape(String.valueOf(entry.getKey()))).append("\":");
                    writeValue(sb, entry.getValue());
                }
                sb.append('}');
            } else if (value instanceof Iterable<?> items) {
                sb.append('[');
                boolean first = true;
                for (Object item : items) {
                    if (!first) sb.append(',');
                    first = false;
                    writeValue(sb, item);
                }
                sb.append(']');
            } else {
                writeValue(sb, String.valueOf(value));
            }
        }

        static String escape(String s) {
            StringBuilder sb = new StringBuilder(s.length() + 8);
            for (char c : s.toCharArray()) {
                switch (c) {
                    case '"' -> sb.append("\\\"");
                    case '\\' -> sb.append("\\\\");
                    case '\n' -> sb.append("\\n");
                    case '\r' -> sb.append("\\r");
                    case '\t' -> sb.append("\\t");
                    default -> {
                        if (c < 0x20) {
                            sb.append(String.format("\\u%04x", (int) c));
                        } else {
                            sb.append(c);
                        }
                    }
                }
            }
            return sb.toString();
        }

        /** 只解析「对象 / 数组 / 字符串 / 数字 / 布尔 / null」这六种值。 */
        static Map<String, Object> parseObject(String text) {
            if (text == null) return null;
            Object parsed = new Parser(text).parseValue();
            if (parsed instanceof Map<?, ?> map) {
                @SuppressWarnings("unchecked")
                Map<String, Object> typed = (Map<String, Object>) map;
                return typed;
            }
            return null;
        }

        private static final class Parser {
            private final String text;
            private int pos;

            Parser(String text) { this.text = text; }

            Object parseValue() {
                skipWhitespace();
                if (pos >= text.length()) return null;
                char c = text.charAt(pos);
                if (c == '{') return parseObjectValue();
                if (c == '[') return parseArray();
                if (c == '"') return parseString();
                if (text.startsWith("true", pos)) { pos += 4; return Boolean.TRUE; }
                if (text.startsWith("false", pos)) { pos += 5; return Boolean.FALSE; }
                if (text.startsWith("null", pos)) { pos += 4; return null; }
                return parseNumber();
            }

            Map<String, Object> parseObjectValue() {
                Map<String, Object> map = new LinkedHashMap<>();
                pos++; // {
                skipWhitespace();
                if (pos < text.length() && text.charAt(pos) == '}') { pos++; return map; }
                while (pos < text.length()) {
                    skipWhitespace();
                    String key = parseString();
                    skipWhitespace();
                    pos++; // :
                    map.put(key, parseValue());
                    skipWhitespace();
                    char c = text.charAt(pos++);
                    if (c == '}') break;
                }
                return map;
            }

            List<Object> parseArray() {
                List<Object> list = new java.util.ArrayList<>();
                pos++; // [
                skipWhitespace();
                if (pos < text.length() && text.charAt(pos) == ']') { pos++; return list; }
                while (pos < text.length()) {
                    list.add(parseValue());
                    skipWhitespace();
                    char c = text.charAt(pos++);
                    if (c == ']') break;
                }
                return list;
            }

            String parseString() {
                Matcher matcher = STRING.matcher(text);
                if (matcher.find(pos) && matcher.start() == pos) {
                    pos = matcher.end();
                    return unescape(matcher.group(1));
                }
                // 兜底：手工扫描到下一个未转义双引号。
                pos++; // opening quote
                StringBuilder sb = new StringBuilder();
                while (pos < text.length()) {
                    char c = text.charAt(pos++);
                    if (c == '\\') {
                        sb.append(c).append(text.charAt(pos++));
                    } else if (c == '"') {
                        break;
                    } else {
                        sb.append(c);
                    }
                }
                return unescape(sb.toString());
            }

            Number parseNumber() {
                int start = pos;
                while (pos < text.length() && "-+.eE0123456789".indexOf(text.charAt(pos)) >= 0) pos++;
                String raw = text.substring(start, pos);
                if (raw.contains(".") || raw.contains("e") || raw.contains("E")) {
                    return Double.parseDouble(raw);
                }
                return Long.parseLong(raw);
            }

            void skipWhitespace() {
                while (pos < text.length() && Character.isWhitespace(text.charAt(pos))) pos++;
            }

            static String unescape(String s) {
                if (s.indexOf('\\') < 0) return s;
                StringBuilder sb = new StringBuilder(s.length());
                for (int i = 0; i < s.length(); i++) {
                    char c = s.charAt(i);
                    if (c != '\\') { sb.append(c); continue; }
                    char next = s.charAt(++i);
                    switch (next) {
                        case 'n' -> sb.append('\n');
                        case 'r' -> sb.append('\r');
                        case 't' -> sb.append('\t');
                        case 'b' -> sb.append('\b');
                        case 'f' -> sb.append('\f');
                        case 'u' -> {
                            sb.append((char) Integer.parseInt(s.substring(i + 1, i + 5), 16));
                            i += 4;
                        }
                        default -> sb.append(next);
                    }
                }
                return sb.toString();
            }
        }
    }
}
