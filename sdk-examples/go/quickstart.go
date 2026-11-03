// 子铭软件授权 API · Go 示例（Preview）
//
// 成功路径：挑战 → 签名 → 激活 → 心跳
// 失败路径：无效授权码 → 422 LICENSE_INVALID → LicenseRejectedError
//
// 只依赖标准库（crypto/ed25519、encoding/json、net/http），无需 go get。
//
//	go run sdk-examples/go/quickstart.go
//
// 标 Preview 而不是 Stable：这是示例代码，不是已发布的 SDK。
package main

import (
	"bytes"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// 默认指向 Sandbox 占位符：生产域名属于部署信息，不进示例。
const defaultBase = "https://<LICENSE_SANDBOX_DOMAIN>/api/v1"

const defaultClientID = ""

// ---------------------------------------------------------------- 错误映射

// LicenseError 是所有授权错误的基类，字段与 API 信封一一对应。
type LicenseError struct {
	Code      string
	Message   string
	RequestID string
	Status    int
}

func (e *LicenseError) Error() string {
	return fmt.Sprintf("%s: %s", e.Code, e.Message)
}

// 每类错误单独一个类型，调用方才能用 errors.As 精确分支，而不是比对字符串。
type (
	AuthenticationError   struct{ *LicenseError }
	LicenseRejectedError  struct{ *LicenseError }
	LicenseExpiredError   struct{ *LicenseError }
	LicenseSuspendedError struct{ *LicenseError }
	DeviceLimitError      struct{ *LicenseError }
	ActivationLimitError  struct{ *LicenseError }
	RateLimitError        struct{ *LicenseError }
	ServiceDownError      struct{ *LicenseError }
)

func newLicenseError(code, message, requestID string, status int) error {
	base := &LicenseError{Code: code, Message: message, RequestID: requestID, Status: status}
	switch code {
	case "CLIENT_AUTH_FAILED", "FORBIDDEN":
		return &AuthenticationError{base}
	case "LICENSE_INVALID", "PRODUCT_MISMATCH", "PRODUCT_DISABLED":
		return &LicenseRejectedError{base}
	case "LICENSE_EXPIRED", "ACTIVATION_WINDOW_EXPIRED":
		return &LicenseExpiredError{base}
	case "LICENSE_SUSPENDED", "DEVICE_BLOCKED":
		return &LicenseSuspendedError{base}
	case "DEVICE_LIMIT_EXCEEDED":
		return &DeviceLimitError{base}
	case "ACTIVATION_LIMIT_REACHED":
		return &ActivationLimitError{base}
	case "RATE_LIMITED":
		return &RateLimitError{base}
	case "LICENSE_SERVICE_UNAVAILABLE":
		return &ServiceDownError{base}
	default:
		return base
	}
}

// ---------------------------------------------------------------- HTTP 客户端

type client struct {
	baseURL  string
	clientID string
	http     *http.Client
}

// envelope 是统一响应信封；成功也检查 ok，不靠 HTTP 状态码猜。
type envelope struct {
	OK        bool            `json:"ok"`
	Code      string          `json:"code"`
	Message   string          `json:"message"`
	RequestID string          `json:"request_id"`
	Data      json.RawMessage `json:"data"`
}

func (c *client) call(path string, payload map[string]any, headers map[string]string) (json.RawMessage, error) {
	body, err := json.Marshal(payload)
	if err != nil {
		return nil, err
	}

	req, err := http.NewRequest(http.MethodPost, c.baseURL+path, bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json")
	req.Header.Set("X-Client-ID", c.clientID)
	req.Header.Set("X-SDK-Version", "go-example/1.5.0")
	for key, value := range headers {
		req.Header.Set(key, value)
	}

	res, err := c.http.Do(req)
	if err != nil {
		// 网络层失败没有 code 可用，单独给一个本地码，避免调用方去解析英文报错。
		return nil, &LicenseError{Code: "NETWORK_ERROR", Message: err.Error()}
	}
	defer res.Body.Close()

	raw, err := io.ReadAll(res.Body)
	if err != nil {
		return nil, &LicenseError{Code: "NETWORK_ERROR", Message: err.Error()}
	}

	var env envelope
	if err := json.Unmarshal(raw, &env); err != nil {
		return nil, &LicenseError{
			Code:    "UNEXPECTED_RESPONSE",
			Message: truncate(string(raw), 200),
			Status:  res.StatusCode,
		}
	}

	if !env.OK {
		return nil, newLicenseError(env.Code, env.Message, env.RequestID, res.StatusCode)
	}
	return env.Data, nil
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n]
}

// ---------------------------------------------------------------- 设备密钥

// 生产环境请把私钥交给系统凭据库（DPAPI / Keychain / libsecret）。
func loadOrCreateDeviceKey(dir string) (ed25519.PrivateKey, error) {
	// 自定义目录可能还不存在：os.WriteFile 不会替你建目录，会直接报 no such file or directory。
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, err
	}
	path := filepath.Join(dir, "ziming-example-device.key")
	if raw, err := os.ReadFile(path); err == nil && len(raw) == ed25519.PrivateKeySize {
		return ed25519.PrivateKey(raw), nil
	}

	_, privateKey, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		return nil, err
	}
	if err := os.WriteFile(path, privateKey, 0o600); err != nil {
		return nil, err
	}
	return privateKey, nil
}

func b64(raw []byte) string {
	return base64.RawURLEncoding.EncodeToString(raw)
}

// Go 的 ed25519.PublicKey 是 32 字节裸公钥，而服务端要的是 SPKI DER（44 字节）。
// 少了这 12 字节前缀，服务端会报「public_key 必须是 base64url 编码的 Ed25519 SPKI 公钥」。
// 前缀是固定结构：SEQUENCE(42) + SEQUENCE(5) + OID 1.3.101.112 + BIT STRING(33) + 0x00 + 32 字节密钥。
var spkiPrefix = []byte{0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00}

// rawToSpkiDer 把裸 Ed25519 公钥包装成 SPKI DER。
func rawToSpkiDer(raw []byte) []byte {
	out := make([]byte, 0, len(spkiPrefix)+len(raw))
	out = append(out, spkiPrefix...)
	out = append(out, raw...)
	return out
}

// ---------------------------------------------------------------- 业务动作

type challengeData struct {
	ChallengeID      string `json:"challenge_id"`
	CanonicalMessage string `json:"canonical_message"`
	CanonicalVersion string `json:"canonical_version"`
}

type activationData struct {
	ActivationID    string         `json:"activation_id"`
	EffectiveStatus string         `json:"effective_status"`
	ExpiresAt       *string        `json:"expires_at"`
	Entitlements    map[string]any `json:"entitlements"`
	RefreshToken    string         `json:"refresh_token"`
}

type heartbeatData struct {
	EffectiveStatus      string         `json:"effective_status"`
	EntitlementsVersion  int            `json:"entitlements_version"`
	Entitlements         map[string]any `json:"entitlements"`
	NextHeartbeatSeconds int            `json:"next_heartbeat_seconds"`
}

func activate(c *client, productID, licenseKey, deviceID string, key ed25519.PrivateKey) (*activationData, error) {
	publicKey := b64(rawToSpkiDer(key.Public().(ed25519.PublicKey)))
	device := map[string]any{
		"device_instance_id": deviceID,
		"platform":           "linux",
		"device_name":        "Example Host",
		"public_key":         publicKey,
	}

	rawChallenge, err := c.call("/activation-challenges", map[string]any{
		"product_id": productID,
		"device":     device,
	}, nil)
	if err != nil {
		return nil, err
	}
	var challenge challengeData
	if err := json.Unmarshal(rawChallenge, &challenge); err != nil {
		return nil, err
	}

	// 直接对 canonical_message 的原始字节签名，不要自己拼字符串。
	signature := b64(ed25519.Sign(key, []byte(challenge.CanonicalMessage)))

	rawActivation, err := c.call("/activations", map[string]any{
		"product_id":   productID,
		"license_key":  licenseKey,
		"challenge_id": challenge.ChallengeID,
		"device":       mergeDevice(device, signature),
		"client":       map[string]any{"app_version": "1.5.0", "sdk_version": "go-example"},
	}, map[string]string{
		"Idempotency-Key": fmt.Sprintf("activate-%s-%s", deviceID, last4(licenseKey)),
	})
	if err != nil {
		return nil, err
	}

	var activation activationData
	if err := json.Unmarshal(rawActivation, &activation); err != nil {
		return nil, err
	}
	return &activation, nil
}

func mergeDevice(device map[string]any, signature string) map[string]any {
	merged := make(map[string]any, len(device)+1)
	for key, value := range device {
		merged[key] = value
	}
	merged["signature"] = signature
	return merged
}

func last4(s string) string {
	if len(s) <= 4 {
		return s
	}
	return s[len(s)-4:]
}

func heartbeat(c *client, activation *activationData) (*heartbeatData, error) {
	raw, err := c.call("/activations/heartbeat", map[string]any{
		"activation_id": activation.ActivationID,
		"refresh_token": activation.RefreshToken,
		"client":        map[string]any{"app_version": "1.5.0", "sdk_version": "go-example"},
	}, nil)
	if err != nil {
		return nil, err
	}
	var beat heartbeatData
	if err := json.Unmarshal(raw, &beat); err != nil {
		return nil, err
	}
	return &beat, nil
}

// ---------------------------------------------------------------- main

func main() {
	baseURL := strings.TrimRight(env("LICENSE_BASE_URL", defaultBase), "/")
	clientID := env("LICENSE_CLIENT_ID", defaultClientID)
	productID := os.Getenv("LICENSE_PRODUCT_ID")
	licenseKey := os.Getenv("LICENSE_KEY")
	keyDir := env("LICENSE_KEY_DIR", os.TempDir())

	var missing []string
	if clientID == "" {
		missing = append(missing, "LICENSE_CLIENT_ID")
	}
	if productID == "" {
		missing = append(missing, "LICENSE_PRODUCT_ID")
	}
	if licenseKey == "" {
		missing = append(missing, "LICENSE_KEY")
	}
	if len(missing) > 0 {
		fmt.Fprintf(os.Stderr, "缺少环境变量：%s\n", strings.Join(missing, ", "))
		os.Exit(2)
	}

	key, err := loadOrCreateDeviceKey(keyDir)
	if err != nil {
		fmt.Fprintln(os.Stderr, "设备密钥读写失败：", err)
		os.Exit(1)
	}

	c := &client{
		baseURL:  baseURL,
		clientID: clientID,
		// 超时必须设：不设超时的客户端在服务端卡住时会永远挂住。
		http: &http.Client{Timeout: 15 * time.Second},
	}

	deviceID := "go-example-" + b64(randomBytes(6))
	if err := run(c, productID, licenseKey, deviceID, key); err != nil {
		fmt.Fprintln(os.Stderr, "执行失败：", err)
		os.Exit(1)
	}
}

func run(c *client, productID, licenseKey, deviceID string, key ed25519.PrivateKey) error {
	fmt.Println("== 成功路径 ==")
	activation, err := activate(c, productID, licenseKey, deviceID, key)
	if err != nil {
		return err
	}
	expires := "永久"
	if activation.ExpiresAt != nil {
		expires = *activation.ExpiresAt
	}
	fmt.Println("activation_id   :", activation.ActivationID)
	fmt.Println("effective_status:", activation.EffectiveStatus)
	fmt.Println("expires_at      :", expires)
	entitlements, _ := json.Marshal(activation.Entitlements)
	fmt.Println("entitlements    :", string(entitlements))

	beat, err := heartbeat(c, activation)
	if err != nil {
		return err
	}
	fmt.Printf("heartbeat       : %s  version=%d  next=%ds\n",
		beat.EffectiveStatus, beat.EntitlementsVersion, beat.NextHeartbeatSeconds)

	fmt.Println()
	fmt.Println("== 失败路径 ==")
	_, err = activate(c, productID, "ZZZZZZ-ZZZZZZ-ZZZZZZ-ZZZZZZ-ZZZZZZ", "go-example-bad", key)
	var rejected *LicenseRejectedError
	if errors.As(err, &rejected) {
		fmt.Printf("已被拒绝（预期）: %s  request_id=%s\n", rejected.Code, rejected.RequestID)
		return nil
	}
	if err != nil {
		// 走到了这里说明服务端没按契约返回 422 LICENSE_INVALID，是真实的契约偏差。
		return fmt.Errorf("期望 LicenseRejectedError，实际得到 %v", err)
	}
	return errors.New("期望失败，实际却成功了")
}

func env(key, fallback string) string {
	if value := os.Getenv(key); value != "" {
		return value
	}
	return fallback
}

func randomBytes(n int) []byte {
	buf := make([]byte, n)
	if _, err := rand.Read(buf); err != nil {
		panic(err)
	}
	return buf
}
