#!/usr/bin/env python3
"""可信服务端调用示例：private_key_jwt（规格 4.12 / 27.4）。

与同目录的 quickstart.py 的区别：

  quickstart.py   公开客户端（EXE / 桌面程序）—— 带 X-Client-ID + 设备私钥签名
  server-check.py 可信服务端（网站后端 / 小程序后端）—— 带 client_assertion（EdDSA JWT）

服务端凭证是 confidential_server 类型，服务端只存公钥，私钥必须留在自己的服务器上。
**不要**把这份私钥打进客户端、插件或小程序。

依赖：
    pip install cryptography

环境变量：
    LICENSE_BASE         默认 https://licensing.example.com
    LICENSE_CLIENT_ID    机密服务端凭证的 client_id（cs_ 开头）
    LICENSE_CREDENTIAL_ID 凭证 ID，作为 JWT header 的 kid
    LICENSE_ASSERTION_KEY 私钥文件路径（PKCS#8 DER 或 PEM，Ed25519）
    LICENSE_ASSERTION_AUD 断言受众，默认 license-api

用法：
    python3 server-check.py wechat_mini_program openid-abc123 basic_export
"""

from __future__ import annotations

import base64
import json
import os
import sys
import time
import urllib.error
import urllib.request
import uuid

from cryptography.hazmat.primitives import serialization

BASE = os.environ.get("LICENSE_BASE", "https://licensing.example.com").rstrip("/")
CLIENT_ID = os.environ.get("LICENSE_CLIENT_ID", "")
CREDENTIAL_ID = os.environ.get("LICENSE_CREDENTIAL_ID", "")
KEY_PATH = os.environ.get("LICENSE_ASSERTION_KEY", "")
AUDIENCE = os.environ.get("LICENSE_ASSERTION_AUD", "license-api")

ASSERTION_TYPE = "urn:ietf:params:oauth:client-assertion-type:jwt-bearer"

# 断言有效期：服务端上限 300 秒，这里取 120 秒留余量。
ASSERTION_TTL_SECONDS = 120


class AssertionError_(Exception):
    """断言被服务端拒绝（401）。"""


class CheckError(Exception):
    """授权检查失败（非 401）。"""


def b64url(raw: bytes) -> str:
    """JWT 段要求 base64url 且不带 padding。"""
    return base64.urlsafe_b64encode(raw).decode().rstrip("=")


def load_private_key():
    if not KEY_PATH:
        raise SystemExit("请设置 LICENSE_ASSERTION_KEY 指向 Ed25519 私钥文件")
    with open(KEY_PATH, "rb") as handle:
        blob = handle.read()
    if blob.lstrip().startswith(b"-----BEGIN"):
        return serialization.load_pem_private_key(blob, None)
    return serialization.load_der_private_key(blob, None)


def build_assertion(private_key) -> str:
    """手工拼紧凑 JWT：header.payload.signature。

    这里不用 pyjwt，是因为 private_key_jwt 的坑几乎都在细节上
    （base64url 去 padding、EdDSA 不传摘要、exp 上限、jti 一次性），
    展开写一遍比调库更容易对照服务端实现排错。
    """
    now = int(time.time())
    header = {"alg": "EdDSA", "kid": CREDENTIAL_ID}
    payload = {
        "iss": CLIENT_ID,
        "sub": CLIENT_ID,
        "aud": AUDIENCE,
        "iat": now,
        "exp": now + ASSERTION_TTL_SECONDS,
        # jti 一次性：重复提交会被服务端判重放（server_assertion_jtis 唯一键）。
        "jti": str(uuid.uuid4()),
    }
    signing_input = (
        b64url(json.dumps(header, separators=(",", ":")).encode())
        + "."
        + b64url(json.dumps(payload, separators=(",", ":")).encode())
    )
    # Ed25519 是纯签名算法：第一个参数必须是 None，传 hashes.SHA256() 会直接抛错。
    signature = private_key.sign(signing_input.encode())
    return signing_input + "." + b64url(signature)


def call(path: str, payload: dict, assertion: str) -> dict:
    request = urllib.request.Request(
        BASE + path,
        data=json.dumps(payload).encode(),
        headers={
            "Content-Type": "application/json",
            "Accept": "application/json",
            # 断言也可以放 Authorization: Bearer <jwt>；这里放请求体，便于和业务字段一起看。
            "X-SDK-Version": "python-server-example/1.5.0",
        },
        method="POST",
    )
    body = dict(payload)
    body["client_assertion"] = assertion
    body["client_assertion_type"] = ASSERTION_TYPE
    request.data = json.dumps(body).encode()

    try:
        with urllib.request.urlopen(request, timeout=10) as response:
            return json.loads(response.read())
    except urllib.error.HTTPError as error:
        raw = error.read()
        try:
            parsed = json.loads(raw)
        except ValueError:
            raise CheckError(f"HTTP {error.code}: {raw[:200]!r}") from None
        code = parsed.get("code")
        message = parsed.get("message")
        if error.code == 401:
            raise AssertionError_(f"{code}: {message}") from None
        raise CheckError(f"{code}: {message} (HTTP {error.code})") from None


def check_license(provider: str, subject_token: str, features: list[str]) -> dict:
    """查某个最终用户是否有覆盖所需功能的授权。

    subject_token 是**调用方后端已经验证过**的用户标识（openid / unionid / 内部 user id）。
    服务端只存它的 sha256，不保存明文，所以这里传什么由调用方决定，保持一致即可。
    """
    assertion = build_assertion(load_private_key())
    envelope = call(
        "/api/v1/server/licenses/check",
        {
            "identity": {"provider": provider, "subject_token": subject_token},
            "required_features": features,
        },
        assertion,
    )
    if not envelope.get("ok"):
        raise CheckError(f"响应异常：{envelope}")
    return envelope["data"]


def main() -> int:
    if not (CLIENT_ID and CREDENTIAL_ID):
        print("请设置 LICENSE_CLIENT_ID 与 LICENSE_CREDENTIAL_ID", file=sys.stderr)
        return 2

    provider = sys.argv[1] if len(sys.argv) > 1 else "wechat_mini_program"
    subject = sys.argv[2] if len(sys.argv) > 2 else "openid-demo"
    features = sys.argv[3:] or ["basic_export"]

    try:
        data = check_license(provider, subject, features)
    except AssertionError_ as error:
        # 401 都是接入配置问题：client_id / kid / aud / 私钥不匹配 / 断言过期 / jti 重放。
        print(f"断言被拒：{error}", file=sys.stderr)
        return 1
    except CheckError as error:
        print(f"检查失败：{error}", file=sys.stderr)
        return 1

    print(json.dumps(data, ensure_ascii=False, indent=2))
    if not data["authorized"]:
        # missing_features 是给调用方做降级用的，不要直接弹给终端用户看。
        print(f"未授权，缺少功能：{', '.join(data['missing_features'])}", file=sys.stderr)
        return 3
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
