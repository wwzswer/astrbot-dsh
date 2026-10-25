"""AstrBot 插件：把 AstrBot 变成 DeepSeek Harness 的 QQ 前端。

分工：
    AstrBot  ：负责接入 QQ/多平台、收消息、发消息、指令、权限
    DSH      ：负责「大脑」——带工具、能读写文件、能跑命令的 agent
    dsh-shim ：两者之间的翻译层（把 AstrBot 的会话映射成 DSH 会话）

这个插件只做三件事：判要不要接管、把消息转给 shim、把回复发回去。
所有 DSH 相关逻辑都在 shim 里——所以 shim 挂了，插件只会说"大脑暂时连不上"，
不会把 AstrBot 本身带崩。
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
from typing import Any

from astrbot.api.event import AstrMessageEvent, filter
from astrbot.api.star import Context, Star, register

try:
    from .dsh_client import DshShimClient, ShimError
except ImportError:
    from dsh_client import DshShimClient, ShimError

logger = logging.getLogger("astrbot")

DEFAULT_CONFIG = {
    "shim_url": "http://127.0.0.1:7824",
    "token": "",
    "reply_timeout_seconds": 180,
    "trigger": {
        # all = 全部消息都交给 DSH；at = 只有 @ 机器人时；whitelist = 只在白名单会话里
        "mode": "all",
        "groups": [],
        "require_at": False,
        # 以这些前缀开头的消息不接管（留给 AstrBot 自己的指令系统）
        "ignore_prefix": ["/"],
    },
    "fallback_on_error": True,
    "debug": False,
}


def _attr(obj: Any, name: str, default: Any = None) -> Any:
    value = getattr(obj, name, None)
    if value is None:
        return default
    if callable(value):
        try:
            return value()
        except Exception:  # noqa: BLE001 - 版本差异不能炸
            return default
    return value


@register(
    "dsh_bridge",
    "dsh-bridge",
    "把 QQ 消息转给 DeepSeek Harness 处理：AstrBot 当前端，DSH 当大脑",
    "0.1.0",
)
class DshBridgePlugin(Star):
    def __init__(self, context: Context):
        super().__init__(context)
        self.config = self._load_config()
        self.client = DshShimClient(
            base_url=self.config["shim_url"],
            token=self.config.get("token", ""),
            timeout=float(self.config.get("reply_timeout_seconds", 180)),
        )
        self._warned = False
        logger.info("[dsh] shim=%s 触发模式=%s", self.config["shim_url"], self.config["trigger"].get("mode"))

    # ── 配置 ────────────────────────────────────────────────
    def _load_config(self) -> dict:
        config = json.loads(json.dumps(DEFAULT_CONFIG))  # 深拷贝
        path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "config.json")
        if os.path.exists(path):
            try:
                with open(path, "r", encoding="utf-8") as handle:
                    patch = json.load(handle) or {}
                for key, value in patch.items():
                    if isinstance(value, dict) and isinstance(config.get(key), dict):
                        config[key].update(value)
                    else:
                        config[key] = value
            except Exception as error:  # noqa: BLE001
                logger.warning("[dsh] config.json 读取失败，用默认值：%s", error)
        if os.environ.get("DSH_SHIM_URL"):
            config["shim_url"] = os.environ["DSH_SHIM_URL"]
        if os.environ.get("DSH_SHIM_TOKEN"):
            config["token"] = os.environ["DSH_SHIM_TOKEN"]
        return config

    # ── 会话 key ────────────────────────────────────────────
    def _session_key(self, event: Any) -> str:
        umo = _attr(event, "unified_msg_origin", "") or ""
        if umo:
            return umo
        platform = _attr(event, "get_platform_name", "unknown") or "unknown"
        session = _attr(event, "get_session_id", "unknown") or "unknown"
        sender = _attr(event, "get_sender_id", "unknown") or "unknown"
        return f"{platform}:{session}:{sender}"

    # ── 是否接管这条消息 ────────────────────────────────────
    def _should_handle(self, event: Any, text: str) -> bool:
        trigger = self.config.get("trigger") or {}
        for prefix in trigger.get("ignore_prefix") or []:
            if text.startswith(prefix):
                return False

        mode = trigger.get("mode", "all")
        group_id = _attr(event, "get_group_id", "") or ""
        whitelist = [str(item) for item in trigger.get("groups") or []]

        if mode == "whitelist" and (not group_id or str(group_id) not in whitelist):
            return False
        if trigger.get("require_at") and not self._is_at_me(event):
            return False
        return True

    @staticmethod
    def _is_at_me(event: Any) -> bool:
        # AstrBot 的 is_at_or_wake_command 在不同版本里叫法不同，都试一遍
        for name in ("is_at_or_wake_command", "is_at_me", "is_wake_command"):
            value = getattr(event, name, None)
            if value is None:
                continue
            try:
                return bool(value() if callable(value) else value)
            except Exception:  # noqa: BLE001
                continue
        message = str(_attr(event, "message_str", "") or "")
        return "@" in message

    # ── 主入口 ──────────────────────────────────────────────
    @filter.event_message_type(filter.EventMessageType.ALL)
    async def handle_message(self, event: AstrMessageEvent):
        text = _attr(event, "message_str", "") or ""
        text = text.strip()
        if not text or not self._should_handle(event, text):
            return

        session_key = self._session_key(event)

        try:
            result = await asyncio.to_thread(self.client.chat, session_key, text)
        except ShimError as error:
            if not self.config.get("fallback_on_error", True):
                raise
            self._degrade(error)
            # 交还给 AstrBot 自己的 LLM 流程
            return

        reply = (result.get("reply") or "").strip()
        if not reply:
            return

        # 接管成功：阻止 AstrBot 再调自己的模型
        event.stop_event()
        yield event.plain_result(reply)

    # ── 指令 ────────────────────────────────────────────────
    @filter.command("dsh")
    async def dsh_command(self, event: AstrMessageEvent, action: str = "stats"):
        """DSH 桥接管理。用法：/dsh [stats|reset|health]"""
        event.stop_event()
        key = self._session_key(event)
        try:
            if action == "reset":
                result = await asyncio.to_thread(self.client.reset, key)
                yield event.plain_result("已重置这个会话的 DSH 上下文。" if result.get("reset") else "本来就没有会话。")
            elif action == "health":
                result = await asyncio.to_thread(self.client.health)
                yield event.plain_result(
                    f"shim {'正常' if result.get('ok') else '异常'}；"
                    f"DSH {'可达' if result.get('dsh', {}).get('reachable') else '不可达'}；"
                    f"活动会话 {result.get('sessions', 0)} 个"
                )
            else:
                result = await asyncio.to_thread(self.client.stats)
                yield event.plain_result(
                    f"活动会话 {result.get('keys', 0)} 个，累计新建 {result.get('created', 0)} 个。"
                )
        except ShimError as error:
            yield event.plain_result(f"连不上 DSH：{error}")

    # ── 降级 ────────────────────────────────────────────────
    def _degrade(self, error: Exception) -> None:
        if self._warned:
            return
        self._warned = True
        logger.warning("[dsh] shim 不可用，消息交回 AstrBot 自己的模型：%s", error)
