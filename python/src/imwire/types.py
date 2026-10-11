from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Literal, Union


@dataclass
class ChatRef:
    platform: str
    account_id: str
    chat_id: str
    kind: Literal["dm", "group"] = "dm"
    thread_id: str | None = None

    def to_rpc(self) -> dict[str, Any]:
        out: dict[str, Any] = {
            "platform": self.platform,
            "accountId": self.account_id,
            "chatId": self.chat_id,
            "kind": self.kind,
        }
        if self.thread_id:
            out["threadId"] = self.thread_id
        return out

    @classmethod
    def from_rpc(cls, data: dict[str, Any]) -> ChatRef:
        return cls(
            platform=str(data.get("platform", "")),
            account_id=str(data.get("accountId", "")),
            chat_id=str(data.get("chatId", "")),
            kind="group" if data.get("kind") == "group" else "dm",
            thread_id=data.get("threadId"),
        )


@dataclass
class UserRef:
    platform: str
    account_id: str
    user_id: str
    display_name: str | None = None

    @classmethod
    def from_rpc(cls, data: dict[str, Any]) -> UserRef:
        return cls(
            platform=str(data.get("platform", "")),
            account_id=str(data.get("accountId", "")),
            user_id=str(data.get("userId", "")),
            display_name=data.get("displayName"),
        )


@dataclass
class MsgRef:
    chat: ChatRef
    message_id: str

    def to_rpc(self) -> dict[str, Any]:
        return {"chat": self.chat.to_rpc(), "messageId": self.message_id}

    @classmethod
    def from_rpc(cls, data: dict[str, Any]) -> MsgRef:
        return cls(chat=ChatRef.from_rpc(data.get("chat") or {}), message_id=str(data.get("messageId", "")))


@dataclass
class Button:
    id: str
    label: str
    style: Literal["primary", "danger", "default"] | None = None
    value: str | None = None

    def to_rpc(self) -> dict[str, Any]:
        out: dict[str, Any] = {"id": self.id, "label": self.label}
        if self.style:
            out["style"] = self.style
        if self.value is not None:
            out["value"] = self.value
        return out


@dataclass
class OutMessage:
    markdown: str
    buttons: list[Button] = field(default_factory=list)
    status: str | None = None

    def to_rpc(self) -> dict[str, Any]:
        blocks: list[dict[str, Any]] = [{"kind": "markdown", "text": self.markdown}]
        if self.status:
            blocks.append({"kind": "status", "text": self.status})
        if self.buttons:
            blocks.append({"kind": "buttons", "buttons": [b.to_rpc() for b in self.buttons]})
        return {"blocks": blocks}


@dataclass
class MessageEvent:
    type: Literal["message"]
    id: str
    ts: int
    chat: ChatRef
    from_: UserRef
    message_id: str
    text: str
    mentions_bot: bool
    reply_to: MsgRef | None = None


@dataclass
class CommandEvent:
    type: Literal["command"]
    id: str
    ts: int
    chat: ChatRef
    from_: UserRef
    name: str
    args: str
    message_id: str | None = None


@dataclass
class EditEvent:
    type: Literal["edit"]
    id: str
    ts: int
    target: MsgRef
    from_: UserRef
    text: str


@dataclass
class ActionEvent:
    type: Literal["action"]
    id: str
    ts: int
    target: MsgRef
    from_: UserRef
    action_id: str
    value: str | None = None


@dataclass
class ReactionEvent:
    type: Literal["reaction"]
    id: str
    ts: int
    target: MsgRef
    from_: UserRef
    emoji: str
    added: bool


InboundEvent = Union[MessageEvent, CommandEvent, EditEvent, ActionEvent, ReactionEvent]


def inbound_from_rpc(data: dict[str, Any]) -> InboundEvent:
    kind = data.get("type")
    chat = ChatRef.from_rpc(data.get("chat") or (data.get("target") or {}).get("chat") or {})
    user = UserRef.from_rpc(data.get("from") or {})
    if kind == "message":
        reply = data.get("replyTo")
        return MessageEvent(
            type="message",
            id=str(data.get("id", "")),
            ts=int(data.get("ts") or 0),
            chat=chat,
            from_=user,
            message_id=str(data.get("messageId", "")),
            text=str(data.get("text", "")),
            mentions_bot=bool(data.get("mentionsBot")),
            reply_to=MsgRef.from_rpc(reply) if reply else None,
        )
    if kind == "command":
        return CommandEvent(
            type="command",
            id=str(data.get("id", "")),
            ts=int(data.get("ts") or 0),
            chat=chat,
            from_=user,
            name=str(data.get("name", "")),
            args=str(data.get("args", "")),
            message_id=data.get("messageId"),
        )
    target = MsgRef.from_rpc(data.get("target") or {})
    if kind == "edit":
        return EditEvent(
            type="edit",
            id=str(data.get("id", "")),
            ts=int(data.get("ts") or 0),
            target=target,
            from_=user,
            text=str(data.get("text", "")),
        )
    if kind == "action":
        return ActionEvent(
            type="action",
            id=str(data.get("id", "")),
            ts=int(data.get("ts") or 0),
            target=target,
            from_=user,
            action_id=str(data.get("actionId", "")),
            value=data.get("value"),
        )
    if kind == "reaction":
        return ReactionEvent(
            type="reaction",
            id=str(data.get("id", "")),
            ts=int(data.get("ts") or 0),
            target=target,
            from_=user,
            emoji=str(data.get("emoji", "")),
            added=bool(data.get("added")),
        )
    raise ValueError(f"unknown inbound type {kind}")


def refs_from_rpc(data: Any) -> list[MsgRef]:
    refs = (data or {}).get("refs") if isinstance(data, dict) else None
    if not refs:
        return []
    return [MsgRef.from_rpc(r) for r in refs]
