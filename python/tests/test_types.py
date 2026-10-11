import unittest

from imwire.types import ChatRef, inbound_from_rpc


class TypesTest(unittest.TestCase):
    def test_chat_roundtrip(self) -> None:
        chat = ChatRef(platform="slack", account_id="slack", chat_id="D111", kind="dm")
        rpc = chat.to_rpc()
        self.assertEqual(rpc["accountId"], "slack")
        self.assertEqual(ChatRef.from_rpc(rpc).chat_id, "D111")

    def test_message_event(self) -> None:
        event = inbound_from_rpc(
            {
                "type": "message",
                "id": "m1",
                "ts": 1,
                "chat": {"platform": "wecom", "accountId": "bot", "chatId": "c1", "kind": "dm"},
                "from": {"platform": "wecom", "accountId": "bot", "userId": "u1"},
                "messageId": "mid",
                "text": "hello",
                "mentionsBot": True,
            }
        )
        self.assertEqual(event.type, "message")
        assert event.type == "message"
        self.assertEqual(event.text, "hello")
        self.assertEqual(event.from_.user_id, "u1")

    def test_action_event(self) -> None:
        event = inbound_from_rpc(
            {
                "type": "action",
                "id": "a1",
                "ts": 1,
                "target": {
                    "chat": {"platform": "dingtalk", "accountId": "app", "chatId": "cid", "kind": "dm"},
                    "messageId": "card-1",
                },
                "from": {"platform": "dingtalk", "accountId": "app", "userId": "staff"},
                "actionId": "approve",
                "value": "ok",
            }
        )
        self.assertEqual(event.type, "action")
        assert event.type == "action"
        self.assertEqual(event.action_id, "approve")


if __name__ == "__main__":
    unittest.main()
