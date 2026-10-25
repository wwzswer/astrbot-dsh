"""dsh-shim 客户端（纯标准库）。

和插件主体分开，是为了能脱离 AstrBot 单独冒烟：
    python dsh_client.py http://127.0.0.1:7824 <token>
"""

from __future__ import annotations

import json
import urllib.error
import urllib.parse
import urllib.request


class ShimError(RuntimeError):
    """shim 不可达或返回错误"""


class DshShimClient:
    def __init__(self, base_url: str = "http://127.0.0.1:7824", token: str = "", timeout: float = 180.0):
        self.base_url = base_url.rstrip("/")
        self.token = token or ""
        self.timeout = timeout

    def _request(self, method: str, path: str, payload: dict | None = None, timeout: float | None = None) -> dict:
        headers = {"content-type": "application/json"}
        if self.token:
            headers["x-shim-token"] = self.token
        data = None
        if payload is not None:
            # ensure_ascii=False + utf-8：中文必须原样过去，别再被转义成一堆 \\uXXXX
            data = json.dumps(payload, ensure_ascii=False).encode("utf-8")

        request = urllib.request.Request(f"{self.base_url}{path}", data=data, headers=headers, method=method)
        try:
            with urllib.request.urlopen(request, timeout=timeout or self.timeout) as response:
                body = response.read().decode("utf-8")
        except urllib.error.HTTPError as error:
            detail = error.read().decode("utf-8", "replace")
            raise ShimError(f"{method} {path} -> HTTP {error.code}: {detail[:300]}") from error
        except Exception as error:  # 连接失败 / 超时
            raise ShimError(f"{method} {path} 失败: {error}") from error

        try:
            return json.loads(body) if body else {}
        except json.JSONDecodeError as error:
            raise ShimError(f"{method} {path} 返回的不是 JSON: {body[:200]}") from error

    def health(self) -> dict:
        return self._request("GET", "/health", timeout=5.0)

    def chat(self, session_key: str, text: str) -> dict:
        return self._request(
            "POST", "/v1/chat", {"sessionKey": session_key, "text": text}, timeout=self.timeout
        )

    def reset(self, session_key: str) -> dict:
        return self._request("POST", "/v1/reset", {"sessionKey": session_key}, timeout=10.0)

    def stats(self) -> dict:
        return self._request("GET", "/v1/stats", timeout=10.0)


if __name__ == "__main__":
    import sys

    base = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:7824"
    token = sys.argv[2] if len(sys.argv) > 2 else ""
    client = DshShimClient(base, token)
    print("health:", json.dumps(client.health(), ensure_ascii=False)[:300])
    print("chat:", json.dumps(client.chat("smoke:test", "只回复两个字：在的"), ensure_ascii=False)[:300])
    print("stats:", json.dumps(client.stats(), ensure_ascii=False)[:300])
