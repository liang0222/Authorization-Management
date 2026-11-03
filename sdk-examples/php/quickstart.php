<?php
/**
 * 子铭软件授权 API · PHP 示例（PHP 8.1+，需 ext-curl 与 ext-sodium）
 *
 * 成功路径：挑战 → 签名 → 激活 → 心跳
 * 失败路径：无效授权码 → 422 LICENSE_INVALID → LicenseRejectedError
 */

declare(strict_types=1);

class LicenseError extends RuntimeException
{
    public function __construct(
        public readonly string $errorCode,
        string $message,
        public readonly ?string $requestId = null,
        public readonly ?int $status = null,
    ) {
        parent::__construct("{$errorCode}: {$message}");
    }
}
class LicenseRejectedError extends LicenseError {}
class LicenseSuspendedError extends LicenseError {}
class LicenseExpiredError extends LicenseError {}
class DeviceLimitError extends LicenseError {}
class ActivationLimitError extends LicenseError {}
class RateLimitError extends LicenseError {}
class ServiceDownError extends LicenseError {}
class AuthenticationError extends LicenseError {}

const ERROR_MAP = [
    'CLIENT_AUTH_FAILED' => AuthenticationError::class,
    // 公开 API 里 FORBIDDEN 只来自凭证缺少某个 scope，属接入配置问题。
    'FORBIDDEN' => AuthenticationError::class,
    'LICENSE_INVALID' => LicenseRejectedError::class,
    'PRODUCT_MISMATCH' => LicenseRejectedError::class,
    'LICENSE_EXPIRED' => LicenseExpiredError::class,
    'ACTIVATION_WINDOW_EXPIRED' => LicenseExpiredError::class,
    'LICENSE_SUSPENDED' => LicenseSuspendedError::class,
    'DEVICE_BLOCKED' => LicenseSuspendedError::class,
    'DEVICE_LIMIT_EXCEEDED' => DeviceLimitError::class,
    'ACTIVATION_LIMIT_REACHED' => ActivationLimitError::class,
    'RATE_LIMITED' => RateLimitError::class,
    'LICENSE_SERVICE_UNAVAILABLE' => ServiceDownError::class,
];

$base = rtrim(getenv('LICENSE_BASE_URL') ?: 'https://<LICENSE_SANDBOX_DOMAIN>/api/v1', '/');
$clientId = getenv('LICENSE_CLIENT_ID') ?: '';
$productId = getenv('LICENSE_PRODUCT_ID') ?: '';
$licenseKey = getenv('LICENSE_KEY') ?: '';
$keyDir = getenv('LICENSE_KEY_DIR') ?: sys_get_temp_dir();

$b64 = static fn (string $raw): string => rtrim(strtr(base64_encode($raw), '+/', '-_'), '=');

function call(string $path, array $payload, array $headers = []): array
{
    global $base, $clientId;
    $ch = curl_init($base . $path);
    curl_setopt_array($ch, [
        CURLOPT_POST => true,
        CURLOPT_POSTFIELDS => json_encode($payload, JSON_UNESCAPED_UNICODE),
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_TIMEOUT => 10,
        CURLOPT_CONNECTTIMEOUT => 5,
        CURLOPT_HTTPHEADER => array_merge([
            'Content-Type: application/json',
            'Accept: application/json',
            'X-Client-ID: ' . $clientId,
            'X-SDK-Version: php-example/1.5.0',
        ], array_map(
            static fn ($k, $v) => "{$k}: {$v}",
            array_keys($headers),
            array_values($headers),
        )),
    ]);
    $raw = curl_exec($ch);
    $status = (int) curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
    $curlError = curl_error($ch);
    curl_close($ch);

    if ($raw === false) {
        throw new LicenseError('NETWORK_ERROR', $curlError ?: '请求失败', null, $status);
    }
    $body = json_decode($raw, true);
    if (!is_array($body)) {
        throw new LicenseError('UNEXPECTED_RESPONSE', substr((string) $raw, 0, 200), null, $status);
    }
    if ($status >= 400 || ($body['ok'] ?? false) !== true) {
        $errorClass = ERROR_MAP[$body['code'] ?? ''] ?? LicenseError::class;
        throw new $errorClass($body['code'] ?? 'UNKNOWN', $body['message'] ?? '未知错误', $body['request_id'] ?? null, $status);
    }
    return $body['data'];
}

/**
 * 首次生成并持久化设备私钥；生产环境请改用系统凭据库。
 *
 * 文件名必须带语言后缀：三种语言的密钥编码互不兼容（PHP 是 64 字节 sodium secret，
 * Python 是 DER PKCS8），共用一个文件名会读到别的语言写的文件，报
 * "must be SODIUM_CRYPTO_SIGN_SECRETKEYBYTES bytes long"。读到长度不对就重新生成。
 */
function loadDeviceKey(string $keyDir): string
{
    // 自定义目录可能还不存在：file_put_contents 不会替你建目录，
    // 缺目录时它只抛一句 Warning 然后继续，看起来像「写入成功」。
    if (!is_dir($keyDir) && !mkdir($keyDir, 0700, true) && !is_dir($keyDir)) {
        throw new LicenseError('DEVICE_KEY_ERROR', '无法创建设备私钥目录 ' . $keyDir);
    }
    $path = $keyDir . DIRECTORY_SEPARATOR . 'ziming-example-device.sodium';
    if (is_file($path)) {
        $existing = file_get_contents($path);
        if (is_string($existing) && strlen($existing) === SODIUM_CRYPTO_SIGN_SECRETKEYBYTES) {
            return $existing;
        }
    }
    $keypair = sodium_crypto_sign_keypair();
    $secret = sodium_crypto_sign_secretkey($keypair);
    if (file_put_contents($path, $secret, LOCK_EX) === false) {
        throw new LicenseError('DEVICE_KEY_ERROR', '设备私钥写入失败 ' . $path);
    }
    chmod($path, 0600);
    if (strlen($secret) !== SODIUM_CRYPTO_SIGN_SECRETKEYBYTES) {
        throw new LicenseError('DEVICE_KEY_ERROR', '生成的设备私钥长度异常');
    }
    return $secret;
}

/**
 * 服务端要的是 Ed25519 的 SPKI DER（44 字节），而 sodium 给的是 32 字节裸公钥。
 * 这个前缀是固定的：SEQUENCE(42) { SEQUENCE(5){ OID 1.3.101.112 } BITSTRING(33) { 00 | key } }。
 */
const ED25519_SPKI_PREFIX = "\x30\x2a\x30\x05\x06\x03\x2b\x65\x70\x03\x21\x00";

function publicKeyB64(string $secret, callable $b64): string
{
    $raw = sodium_crypto_sign_publickey_from_secretkey($secret);
    return $b64(ED25519_SPKI_PREFIX . $raw);
}

function activate(string $secret, string $productId, string $licenseKey, string $deviceId, callable $b64): array
{
    $device = [
        'device_instance_id' => $deviceId,
        'platform' => 'linux',
        'device_name' => 'Example Host',
        'public_key' => publicKeyB64($secret, $b64),
    ];
    $challenge = call('/activation-challenges', ['product_id' => $productId, 'device' => $device]);
    $signature = $b64(sodium_crypto_sign_detached($challenge['canonical_message'], $secret));

    return call('/activations', [
        'product_id' => $productId,
        'license_key' => $licenseKey,
        'challenge_id' => $challenge['challenge_id'],
        'device' => array_merge($device, ['signature' => $signature]),
        'client' => ['app_version' => '1.5.0', 'sdk_version' => 'php-example'],
    ], ['Idempotency-Key' => 'activate-' . $deviceId . '-' . substr($licenseKey, -4)]);
}

$missing = [];
// 不再内置真实 client_id：必须由使用者从后台创建凭证后传入。
if ($clientId === '') {
    $missing[] = 'LICENSE_CLIENT_ID';
}
if ($productId === '') {
    $missing[] = 'LICENSE_PRODUCT_ID';
}
if ($licenseKey === '') {
    $missing[] = 'LICENSE_KEY';
}
if ($missing !== []) {
    fwrite(STDERR, '缺少环境变量：' . implode(', ', $missing) . PHP_EOL);
    exit(2);
}

$secret = loadDeviceKey($keyDir);
$deviceId = 'php-example-' . strtolower($b64(random_bytes(6)));

echo "== 成功路径 ==" . PHP_EOL;
$activation = activate($secret, $productId, $licenseKey, $deviceId, $b64);
echo 'activation_id   : ' . $activation['activation_id'] . PHP_EOL;
echo 'effective_status: ' . $activation['effective_status'] . PHP_EOL;
echo 'expires_at      : ' . $activation['expires_at'] . PHP_EOL;
echo 'entitlements    : ' . json_encode($activation['entitlements'], JSON_UNESCAPED_UNICODE) . PHP_EOL;

$heartbeat = call('/activations/heartbeat', [
    'activation_id' => $activation['activation_id'],
    'refresh_token' => $activation['refresh_token'],
    'client' => ['app_version' => '1.5.0', 'sdk_version' => 'php-example'],
]);
echo 'heartbeat       : ' . $heartbeat['effective_status'] . '  version=' . $heartbeat['entitlements_version'] . '  next=' . $heartbeat['next_heartbeat_seconds'] . 's' . PHP_EOL;

echo PHP_EOL . "== 失败路径 ==" . PHP_EOL;
try {
    activate($secret, $productId, 'AAAAA-BBBBB-CCCCC-DDDDD-EEEEE', $deviceId . '-bad', $b64);
    fwrite(STDERR, '!! 无效授权码居然激活成功，说明校验有问题' . PHP_EOL);
    exit(1);
} catch (LicenseRejectedError $error) {
    echo '预期失败：' . $error->getMessage() . '  (HTTP ' . $error->status . ')' . PHP_EOL;
    echo 'request_id      : ' . ($error->requestId ?? '-') . PHP_EOL;
    exit(0);
}
