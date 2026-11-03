# SDK 示例（Python / Node / PHP / Go / Java / C#）

> **状态：Preview。** 这六个目录是可运行示例，**不是已发布的 SDK**。
> 只有真正发到 PyPI / npm / Packagist / Go module proxy / Maven Central / NuGet 之后才会标 Stable。
> 在那之前，接口形状与文件名都可能变。

每个示例都做同样三件事：

1. **成功路径**：生成设备密钥 → 申请挑战 → 签名 `canonical_message` → 激活 → 心跳，打印生效状态与权限位。
2. **失败路径**：用无效授权码再激活一次，确认错误被映射成「授权被拒」这一族异常（422 `LICENSE_INVALID`）。
3. **错误分族**：按 `code` 分派到具体异常类型，调用方 `catch` 类型而不是比对字符串。

失败路径是刻意保留的：只看成功路径的示例会把「错误处理」留给你猜。

## 六个语言

| 语言 | 文件 | 额外依赖 | 运行 |
| --- | --- | --- | --- |
| Python 3.11 | `python/quickstart.py` | `cryptography`（`pip install cryptography`） | `python3 sdk-examples/python/quickstart.py` |
| Node 20+ | `node/quickstart.mjs` | 无（`node:crypto` 内置 Ed25519） | `node sdk-examples/node/quickstart.mjs` |
| PHP 8.2 | `php/quickstart.php` | `ext-sodium`（`php-sodium`） | `php sdk-examples/php/quickstart.php` |
| Go 1.19+ | `go/quickstart.go` | 无（`crypto/ed25519` 标准库） | `cd sdk-examples/go && go run quickstart.go` |
| Java 17+ | `java/Quickstart.java` | 无（`java.net.http` + `java.security`） | `javac -d /tmp/java-example sdk-examples/java/Quickstart.java && java -cp /tmp/java-example Quickstart` |
| C# (.NET Framework / Mono) | `csharp/Quickstart.cs` | `BouncyCastle.Cryptography` 2.6.2（.NET Framework 无内置 Ed25519） | 见下方「C# 编译」 |

除 PHP 与 C# 外都不需要第三方库——Ed25519 在 Python（`cryptography`）、Node、Go、Java 17 都有原生实现。

## 共用环境变量

```bash
export LICENSE_BASE_URL=http://127.0.0.1:3000/api/v1   # 默认指向 Sandbox
export LICENSE_CLIENT_ID=<后台「API 凭证」里创建公开客户端后拿到的 client_id>
export LICENSE_PRODUCT_ID=<产品 UUID>
export LICENSE_KEY=<Sandbox 授权码>
export LICENSE_KEY_DIR=/tmp/license-keys              # 设备私钥目录，默认系统临时目录
```

`LICENSE_BASE_URL` 里的 `/api/v1` 不能省：示例把它当 API 根，不会自己补。

## 错误映射（六个示例一致）

`code` 来自响应信封，HTTP 状态码只是它的副产物——**请按 `code` 分支，不要按状态码**。
同一个 409 既可能是设备超限，也可能是幂等键冲突，处理方式完全不同。

| 异常族 | 覆盖的 `code` | HTTP | 该怎么办 |
| --- | --- | --- | --- |
| `AuthenticationError` | `CLIENT_AUTH_FAILED` | 401 | `X-Client-ID` 或激活令牌不对。令牌过期就refresh，别重试同一个。 |
| `LicenseRejectedError` | `LICENSE_INVALID`、`PRODUCT_MISMATCH` | 422 | 授权码无效，或不属于这个产品。**不要重试**，提示用户核对。 |
| `LicenseRejectedError` | `PRODUCT_DISABLED` | 403 | 整个产品被管理员停用，该产品下所有授权同时不可用。**不要重试**，联系服务方；客户端应停用全部功能。 |
| `LicenseExpiredError` | `LICENSE_EXPIRED`、`ACTIVATION_WINDOW_EXPIRED` | 410 | 已过期 / 首次激活窗口已过。引导续费，不是网络问题。 |
| `LicenseSuspendedError` | `LICENSE_SUSPENDED`、`DEVICE_BLOCKED` | 423 | 被管理员暂停或本设备被封禁。提示联系客服。 |
| `DeviceLimitError` | `DEVICE_LIMIT_EXCEEDED` | 409 | 名额用满。先解绑闲置设备，或让客户升配套餐。 |
| `ActivationLimitError` | `ACTIVATION_LIMIT_REACHED` | 409 | 累计激活次数上限。解绑不返还次数时只能续签。 |
| `RateLimitError` | `RATE_LIMITED` | 429 | 读 `Retry-After` 退避，别原地重试。 |
| `ServiceDownError` | `LICENSE_SERVICE_UNAVAILABLE` | 503 | 服务端不可用。**离线宽限期**就是为这个设计的：继续用缓存的授权。 |
| 其余落到基类 | `INVALID_REQUEST`、`FORBIDDEN`、`RESOURCE_NOT_FOUND`、`LICENSE_ALREADY_BOUND`、`IDEMPOTENCY_CONFLICT`、`INTERNAL_ERROR` | 400/403/404/409/500 | 多数是接入方代码问题，把 `request_id` 记下来报给服务端。 |

`MFA_REQUIRED`、`CSRF_FAILED`、`CONFLICT` 只出现在管理后台，SDK 不会遇到，所以不在上表。

各语言的具体类名：

| 异常族 | Python | Node | PHP | Go | Java | C# |
| --- | --- | --- | --- | --- | --- | --- |
| 基类 | `LicenseError` | `LicenseError` | `LicenseError` | `*LicenseError` | `LicenseException` | `LicenseException` |
| 认证 | `AuthenticationError` | `AuthenticationError` | `AuthenticationError` | `*AuthenticationError` | `AuthenticationException` | `AuthenticationException` |
| 授权被拒 | `LicenseRejectedError` | `LicenseRejectedError` | `LicenseRejectedError` | `*LicenseRejectedError` | `LicenseRejectedException` | `LicenseRejectedException` |
| 已过期 | `LicenseExpiredError` | `LicenseExpiredError` | `LicenseExpiredError` | `*LicenseExpiredError` | `LicenseExpiredException` | `LicenseExpiredException` |
| 已暂停 | `LicenseSuspendedError` | `LicenseSuspendedError` | `LicenseSuspendedError` | `*LicenseSuspendedError` | `LicenseSuspendedException` | `LicenseSuspendedException` |
| 设备超限 | `DeviceLimitError` | `DeviceLimitError` | `DeviceLimitError` | `*DeviceLimitError` | `DeviceLimitException` | `DeviceLimitException` |
| 激活超限 | `ActivationLimitError` | `ActivationLimitError` | `ActivationLimitError` | `*ActivationLimitError` | `ActivationLimitException` | `ActivationLimitException` |
| 限流 | `RateLimitError` | `RateLimitError` | `RateLimitError` | `*RateLimitError` | `RateLimitException` | `RateLimitException` |
| 服务不可用 | `ServiceDownError` | `ServiceDownError` | `ServiceDownError` | `*ServiceDownError` | `ServiceUnavailableException` | `ServiceUnavailableException` |

Go 用 `errors.As` 判类型，Java/C# 用 `catch`，Python/Node/PHP 用 `instanceof`。

## 平台坑（都是实测踩出来的）

这些坑与授权协议无关，但会让你以为协议错了。每个都写进了对应示例的注释里。

### 设备公钥：32 字节裸钥 vs 44 字节 SPKI DER

服务端要的是 **base64url 编码的 Ed25519 SubjectPublicKeyInfo（SPKI）DER**，通常 44 字节。
不同语言的原生 API 给的格式不一样：

| 语言 | 原生给什么 | 要不要补前缀 |
| --- | --- | --- |
| Go | `ed25519.PublicKey` = 32 字节裸钥 | **要**，补 `302a300506032b6570032100` |
| PHP | sodium 返回 32 字节裸钥 | **要**，补同一个 12 字节前缀 |
| Java | `EdECPublicKey.getEncoded()` 已是 X.509/SPKI | 不要 |
| Node | `KeyObject.export({type:"spki",format:"der"})` 已是 SPKI | 不要 |
| Python | `public_bytes(Encoding.DER, PublicFormat.SubjectPublicKeyInfo)` 已是 SPKI | 不要 |
| C# | BouncyCastle `SubjectPublicKeyInfoFactory` 已输出 SPKI DER | 不要 |

漏了前缀的报错长这样：

```
400 INVALID_REQUEST  public_key 必须是 base64url 编码的 Ed25519 SPKI 公钥
```

### Java：`HttpClient` 默认 HTTP/2，对明文 `http://` 会挂

JDK 的 `HttpClient` 默认 `HTTP_2`。对 `http://` 端点它会先发 **h2c 升级请求**
（`Connection: Upgrade, HTTP2-Settings`），不认升级的服务端直接关连接，
客户端拿到的是 `java.io.IOException: HTTP/1.1 header parser received no bytes`——
**不是任何 HTTP 状态码**，看起来像服务端崩了，其实只是协议协商失败。JDK 不会自动回退。

```java
HttpClient.newBuilder().version(HttpClient.Version.HTTP_1_1).build()
```

生产环境是 HTTPS，ALPN 能正常协商到 HTTP/2，这个坑只在本地明文调试时出现。

### C# 编译（Mono / .NET Framework）

.NET Framework 没有内置 Ed25519，用 BouncyCastle：

```bash
nuget install BouncyCastle.Cryptography -Version 2.6.2 -OutputDirectory packages
mkdir -p /tmp/csharp-example
cp packages/BouncyCastle.Cryptography.2.6.2/lib/net461/BouncyCastle.Cryptography.dll /tmp/csharp-example/
mcs -out:/tmp/csharp-example/Quickstart.exe \
    -r:/tmp/csharp-example/BouncyCastle.Cryptography.dll \
    -r:System.Net.Http.dll \
    sdk-examples/csharp/Quickstart.cs
mono /tmp/csharp-example/Quickstart.exe
```

两个必须注意的点：

- **`-r:System.Net.Http.dll`**：不加就报 `CS0246: HttpClient could not be found`。
- **dll 必须和 exe 同目录**：否则运行时 `FileNotFoundException: Could not load file or assembly 'BouncyCastle.Cryptography'`。
  编译时 `-r:` 能找到不等于运行时能找到。

`mcs` 只支持 C# 6，所以示例里没有 switch expression、record、模式匹配。
换成 `dotnet build` + .NET 6+ 可以用现代语法，那时也建议直接用 `System.Text.Json`。

### PHP：key 文件后缀别和别的语言共用

PHP 的 sodium 读 32 字节裸钥，Python 写 48 字节 DER。两者若共用同一个文件名，
PHP 会读到自己长度的两倍并抛：

```
SodiumException: ... must be SODIUM_CRYPTO_SIGN_SECRETKEYBYTES bytes long
```

示例里 Python 写 `.der`、PHP 写 `.sodium`，就是为了让这个错误不会静默发生。

## 一次跑完六个语言

`verify.mjs` 是这六个示例的最小测试：跑完每个语言，断言**成功路径打印 `effective_status: active`**
且**失败路径确实被拒**，任何一条不满足就退出码非 0。

```bash
export LICENSE_KEY=<授权码>
export LICENSE_PRODUCT_ID=<产品 UUID>
export LICENSE_ID=<该授权的 UUID>          # 可选：给了会把限额抬到 50 台 / 500 次，便于反复跑
export JAVA_CLASSES=/tmp/java-example
export CSHARP_EXE=/tmp/csharp-example/Quickstart.exe
export CSHARP_BCL=/tmp/csharp-example/BouncyCastle.Cryptography.dll

node sdk-examples/verify.mjs
```

实测输出：

```
已把授权限额抬到 maxDevices=50 / maxActivationCount=500（便于反复运行）
PASS python 0.6s
… 等待 12s（避开 /activations 的 10 次/60 秒限流）
PASS node   0.4s
…
PASS csharp 0.7s

6/6 全部通过
```

**为什么要等 12 秒**：每个示例打两次 `/activations`（成功 + 失败路径），六个语言共 12 次，
而公开限流是 `/activations` 每产品 **10 次 / 60 秒**。不留间隔地连跑，第 6 个语言必然拿到
`429 RATE_LIMITED`——那是限流在正常工作，不是示例有问题。脚本默认每个语言之间等 12 秒，
并额外做一次「撞到限流就按 `retry-after` 等一轮再重试」。把 `LICENSE_VERIFY_GAP_MS` 设成 0
可以关掉间隔（然后你会亲眼看到 429）。

## 关于密钥

- 设备私钥由脚本首次运行时生成，保存在 `$LICENSE_KEY_DIR`（默认系统临时目录）。
  生产环境请换成平台凭据存储（DPAPI / Keychain / libsecret / Android Keystore）。
- `X-Client-ID` 是公开标识，写死在脚本里没问题；它**不是**密钥。
- 激活响应里的 `refresh_token` 是**一次性**的：每次心跳都会签发新的，旧值重放会触发整族撤销。
  示例只心跳一次，所以没体现这一点；**真实客户端必须在每次心跳成功后把新的 `refresh_token`
  覆盖落盘**，否则第二次心跳就会被判重放。这条在 `tests/integration/api.test.ts` 里有对应用例
  （「旧 refresh token 重放 → 401 且整族失效」）。
- 授权码（`LICENSE_KEY`）只在首次激活时用一次，之后靠令牌。别把它打进日志。