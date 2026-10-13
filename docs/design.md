# imwire design

## Positioning

**imwire connects agents to the IMs people already use. It does not build another IM.** Its edge is one identity and one continuous conversation across every IM.

- **Existing IMs first.** Telegram, Feishu, Slack, DingTalk, WeCom and others are the primary surfaces. imwire adapts to them; it does not ask people to install a new chat app.
- **Self-built endpoints are supplementary adapters.** Voice hardware or a passkey web confirmation page plug in through the same adapter interface, filling gaps the IMs cannot cover.
- **Differentiator: one person, one conversation, any IM.** Identity is person-centric. The model is *person → topic → message*: switch from Telegram to Feishu and the same person continues the same topic.
- **Bidirectional.** People reach agents through the gateway; agents reach people through the a2h hub and MCP. Both directions share the same adapters, identity and session layer.
- **Boundaries come from permissions and data isolation, not product lines.** Personal and team use run on the same imwire.

**Non-goal:** another chat app.
