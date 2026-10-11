export const inboundSchema = {
  $id: "https://imwire.dev/schema/inbound.json",
  $schema: "https://json-schema.org/draft/2020-12/schema",
  title: "Inbound",
  oneOf: [
    { $ref: "#/$defs/message" },
    { $ref: "#/$defs/edit" },
    { $ref: "#/$defs/reaction" },
    { $ref: "#/$defs/action" },
    { $ref: "#/$defs/command" },
    { $ref: "#/$defs/typing" },
    { $ref: "#/$defs/draft" },
  ],
  $defs: {
    platform: { type: "string", minLength: 1 },
    chatRef: {
      type: "object",
      additionalProperties: false,
      required: ["platform", "accountId", "chatId", "kind"],
      properties: {
        platform: { $ref: "#/$defs/platform" },
        accountId: { type: "string" },
        chatId: { type: "string" },
        kind: { enum: ["dm", "group"] },
        threadId: { type: "string" },
      },
    },
    userRef: {
      type: "object",
      additionalProperties: false,
      required: ["platform", "accountId", "userId"],
      properties: {
        platform: { $ref: "#/$defs/platform" },
        accountId: { type: "string" },
        userId: { type: "string" },
        displayName: { type: "string" },
      },
    },
    msgRef: {
      type: "object",
      additionalProperties: false,
      required: ["chat", "messageId"],
      properties: {
        chat: { $ref: "#/$defs/chatRef" },
        messageId: { type: "string" },
      },
    },
    mediaRef: {
      type: "object",
      additionalProperties: false,
      required: ["id", "kind"],
      properties: {
        id: { type: "string" },
        kind: { enum: ["image", "file", "audio", "video", "sticker", "other"] },
        mime: { type: "string" },
        name: { type: "string" },
        size: { type: "integer" },
      },
    },
    inboundBase: {
      type: "object",
      required: ["id", "ts"],
      properties: {
        id: { type: "string" },
        ts: { type: "number" },
        raw: true,
      },
    },
    message: {
      allOf: [
        { $ref: "#/$defs/inboundBase" },
        {
          type: "object",
          required: ["type", "chat", "from", "messageId", "text", "mentionsBot"],
          properties: {
            type: { const: "message" },
            chat: { $ref: "#/$defs/chatRef" },
            from: { $ref: "#/$defs/userRef" },
            messageId: { type: "string" },
            text: { type: "string" },
            mentionsBot: { type: "boolean" },
            replyTo: { $ref: "#/$defs/msgRef" },
            media: { type: "array", items: { $ref: "#/$defs/mediaRef" } },
          },
        },
      ],
    },
    edit: {
      allOf: [
        { $ref: "#/$defs/inboundBase" },
        {
          type: "object",
          required: ["type", "target", "from", "text"],
          properties: {
            type: { const: "edit" },
            target: { $ref: "#/$defs/msgRef" },
            from: { $ref: "#/$defs/userRef" },
            text: { type: "string" },
          },
        },
      ],
    },
    reaction: {
      allOf: [
        { $ref: "#/$defs/inboundBase" },
        {
          type: "object",
          required: ["type", "target", "from", "emoji", "added"],
          properties: {
            type: { const: "reaction" },
            target: { $ref: "#/$defs/msgRef" },
            from: { $ref: "#/$defs/userRef" },
            emoji: { type: "string" },
            added: { type: "boolean" },
          },
        },
      ],
    },
    action: {
      allOf: [
        { $ref: "#/$defs/inboundBase" },
        {
          type: "object",
          required: ["type", "target", "from", "actionId"],
          properties: {
            type: { const: "action" },
            target: { $ref: "#/$defs/msgRef" },
            from: { $ref: "#/$defs/userRef" },
            actionId: { type: "string" },
            value: { type: "string" },
          },
        },
      ],
    },
    command: {
      allOf: [
        { $ref: "#/$defs/inboundBase" },
        {
          type: "object",
          required: ["type", "chat", "from", "name", "args"],
          properties: {
            type: { const: "command" },
            chat: { $ref: "#/$defs/chatRef" },
            from: { $ref: "#/$defs/userRef" },
            messageId: { type: "string" },
            name: { type: "string" },
            args: { type: "string" },
          },
        },
      ],
    },
    typing: {
      allOf: [
        { $ref: "#/$defs/inboundBase" },
        {
          type: "object",
          required: ["type", "chat", "from"],
          properties: {
            type: { const: "typing" },
            chat: { $ref: "#/$defs/chatRef" },
            from: { $ref: "#/$defs/userRef" },
          },
        },
      ],
    },
    draft: {
      allOf: [
        { $ref: "#/$defs/inboundBase" },
        {
          type: "object",
          required: ["type", "chat", "text"],
          properties: {
            type: { const: "draft" },
            chat: { $ref: "#/$defs/chatRef" },
            text: { type: "string" },
            status: { type: "string" },
          },
        },
      ],
    },
  },
} as const;

export const outboundSchema = {
  $id: "https://imwire.dev/schema/outbound.json",
  $schema: "https://json-schema.org/draft/2020-12/schema",
  title: "OutMessage",
  type: "object",
  additionalProperties: false,
  required: ["blocks"],
  properties: {
    blocks: {
      type: "array",
      items: {
        oneOf: [
          {
            type: "object",
            additionalProperties: false,
            required: ["kind", "text"],
            properties: { kind: { const: "markdown" }, text: { type: "string" } },
          },
          {
            type: "object",
            additionalProperties: false,
            required: ["kind", "buttons"],
            properties: {
              kind: { const: "buttons" },
              buttons: {
                type: "array",
                items: {
                  type: "object",
                  additionalProperties: false,
                  required: ["id", "label"],
                  properties: {
                    id: { type: "string" },
                    label: { type: "string" },
                    style: { enum: ["primary", "danger", "default"] },
                  },
                },
              },
            },
          },
          {
            type: "object",
            additionalProperties: false,
            required: ["kind", "text"],
            properties: { kind: { const: "status" }, text: { type: "string" } },
          },
        ],
      },
    },
    replyTo: { $ref: "https://imwire.dev/schema/inbound.json#/$defs/msgRef" },
    media: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["kind", "bytes"],
        properties: {
          kind: { enum: ["image", "file"] },
          name: { type: "string" },
          mime: { type: "string" },
          bytes: { type: "object" },
        },
      },
    },
  },
} as const;
