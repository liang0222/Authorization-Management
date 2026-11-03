#!/usr/bin/env python3
"""
子铭软件授权 API · Python 示例

成功路径：挑战 → 签名 → 激活 → 心跳
失败路径：无效授权码 → 422 LICENSE_INVALID → LicenseRejectedError

依赖：pip install cryptography
"""
import base64
import json
import os
import sys
import tempfile
import urllib.error
import urllib.request

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

BASE = os.environ.get("LICENSE_BASE_URL", "https://<LICENSE_SANDBOX_DOMAIN>/api/v1").rstrip("/")
CLIENT_ID = os.environ.get("LICENSE_CLIENT_ID", "")
PRODUCT_ID = os.environ.get("LICENSE_PRODUCT_ID", "")
LICENSE_KEY = os.environ.get("LICENSE_KEY", "")
KEY_DIR = os.environ.get("LICENSE_KEY_DIR", tempfile.gettempdir())


class LicenseError(Exception):
    def __init__(self, code, message, request_id=None, status=None):
        super().__init__(f"{code}: {message}")
        self.code = code
        self.message = message
        self.request_id = request_id
        self.status = status


class AuthenticationError(LicenseError):
    pass


class LicenseRejectedError(LicenseError):
    pass


class LicenseExpiredError(LicenseError):
    pass


class LicenseSuspendedError(LicenseError):
    pass


class DeviceLimitError(LicenseError):
    pass


class ActivationLimitError(LicenseError):
    pass


class RateLimitError(LicenseError):
    pass


class ServiceDownError(LicenseError):
    pass


ERROR_MAP = {
    "CLIENT_AUTH_FAILED": AuthenticationError,
    # 公开 API 里 FORBIDDEN 只来自凭证缺少某个 scope，属接入配置问题。
    "FORBIDDEN": AuthenticationError,
    "LICENSE_INVALID": LicenseRejectedError,
    "PRODUCT_MISMATCH": LicenseRejectedError,
    "LICENSE_EXPIRED": LicenseExpiredError,
    "ACTIVATION_WINDOW_EXPIRED": LicenseExpiredError,
    "LICENSE_SUSPENDED": LicenseSuspendedError,
    "DEVICE_BLOCKED": LicenseSuspendedError,
    "DEVICE_LIMIT_EXCEEDED": DeviceLimitError,
    "ACTIVATION_LIMIT_REACHED": ActivationLimitError,
    "RATE_LIMITED": RateLimitError,
    "LICENSE_SERVICE_UNAVAILABLE": ServiceDownError,
}


def b64(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).decode().rstrip("=")


def call(path: str, payload: dict, headers: dict | None = None) -> dict:
    body = json.dumps(payload).encode()
    request = urllib.request.Request(
        BASE + path,
        data=body,
        headers={
            "Content-Type": "application/json",
            "Accept": "application/json",
            "X-Client-ID": CLIENT_ID,
            "X-SDK-Version": "python-example/1.5.0",
            **(headers or {}),
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=10) as response:
            return json.loads(response.read())
    except urllib.error.HTTPError as error:
        raw = error.read()
        try:
            parsed = json.loads(raw)
        except ValueError:
            raise LicenseError("UNEXPECTED_RESPONSE", raw.decode("utf-8", "replace")[:200], status=error.code) from None
        raise ERROR_MAP.get(parsed.get("code"), LicenseError)(
            parsed.get("code"),
            parsed.get("message"),
            request_id=parsed.get("request_id"),
            status=error.code,
        ) from None


def load_device_key():
    """首次生成并持久化；生产环境请改用系统凭据库。"""
    # 自定义目录可能还不存在：open(path, "wb") 不会替你建目录，直接抛 FileNotFoundError。
    os.makedirs(KEY_DIR, mode=0o700, exist_ok=True)
    path = os.path.join(KEY_DIR, "ziming-example-device.key")
    if os.path.exists(path):
        with open(path, "rb") as handle:
            return serialization.load_der_private_key(handle.read(), None)
    key = Ed25519PrivateKey.generate()
    with open(path, "wb") as handle:
        handle.write(
            key.private_bytes(
                serialization.Encoding.DER,
                serialization.PrivateFormat.PKCS8,
                serialization.NoEncryption(),
            )
        )
    os.chmod(path, 0o600)
    return key


def public_key_b64(key) -> str:
    return b64(
        key.public_key().public_bytes(
            serialization.Encoding.DER, serialization.PublicFormat.SubjectPublicKeyInfo
        )
    )


def activate(license_key: str, device_id: str, key, *, expect_failure: bool = False):
    device = {
        "device_instance_id": device_id,
        "platform": "linux",
        "device_name": "Example Host",
        "public_key": public_key_b64(key),
    }
    challenge = call("/activation-challenges", {"product_id": PRODUCT_ID, "device": device})["data"]
    signature = b64(key.sign(challenge["canonical_message"].encode()))
    try:
        return call(
            "/activations",
            {
                "product_id": PRODUCT_ID,
                "license_key": license_key,
                "challenge_id": challenge["challenge_id"],
                "device": {**device, "signature": signature},
                "client": {"app_version": "1.5.0", "sdk_version": "python-example"},
            },
            {"Idempotency-Key": f"activate-{device_id}-{license_key[-4:]}"},
        )["data"]
    except LicenseError as error:
        if expect_failure:
            raise
        raise


def main() -> int:
    missing = [
        name
        for name, value in (
            ("LICENSE_BASE_URL", os.environ.get("LICENSE_BASE_URL", "")),
            ("LICENSE_CLIENT_ID", CLIENT_ID),
            ("LICENSE_PRODUCT_ID", PRODUCT_ID),
            ("LICENSE_KEY", LICENSE_KEY),
        )
        if not value
    ]
    if missing:
        print(f"缺少环境变量：{', '.join(missing)}", file=sys.stderr)
        return 2

    key = load_device_key()
    device_id = "py-example-" + b64(os.urandom(6)).lower()

    print("== 成功路径 ==")
    activation = activate(LICENSE_KEY, device_id, key)
    print("activation_id   :", activation["activation_id"])
    print("effective_status:", activation["effective_status"])
    print("expires_at      :", activation["expires_at"])
    print("entitlements    :", json.dumps(activation["entitlements"], ensure_ascii=False))

    heartbeat = call(
        "/activations/heartbeat",
        {
            "activation_id": activation["activation_id"],
            "refresh_token": activation["refresh_token"],
            "client": {"app_version": "1.5.0", "sdk_version": "python-example"},
        },
    )["data"]
    print(
        "heartbeat       :",
        heartbeat["effective_status"],
        f"version={heartbeat['entitlements_version']}",
        f"next={heartbeat['next_heartbeat_seconds']}s",
    )

    print()
    print("== 失败路径 ==")
    try:
        activate("AAAAA-BBBBB-CCCCC-DDDDD-EEEEE", device_id + "-bad", key, expect_failure=True)
    except LicenseRejectedError as error:
        print(f"预期失败：{error}  (HTTP {error.status})")
        print("request_id      :", error.request_id)
    else:
        print("!! 无效授权码居然激活成功，说明校验有问题", file=sys.stderr)
        return 1

    return 0


if __name__ == "__main__":
    sys.exit(main())
