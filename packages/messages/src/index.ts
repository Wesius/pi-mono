import { StringEnum } from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import * as db from "./messages-db.js";

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "messages",
		label: "Messages",
		description:
			"Read and send iMessages/SMS on macOS. Actions: recent (get recent messages), conversation (get messages with a contact), list (list conversations), search (search message text), send (send a message).",
		parameters: Type.Object({
			action: StringEnum(["recent", "conversation", "list", "search", "send"] as const, {
				description: "The action to perform",
			}),
			contact: Type.Optional(
				Type.String({ description: "Contact name, phone number, or email (for conversation/send)" }),
			),
			query: Type.Optional(Type.String({ description: "Search query (for search)" })),
			text: Type.Optional(Type.String({ description: "Message text (for send)" })),
			limit: Type.Optional(Type.Number({ description: "Max results (default: 30)", default: 30 })),
		}),

		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			try {
				const limit = params.limit ?? 30;

				switch (params.action) {
					case "recent": {
						const messages = db.getRecent(limit);
						return {
							content: [{ type: "text", text: JSON.stringify(messages, null, 2) }],
							details: {},
						};
					}

					case "conversation": {
						if (!params.contact) {
							return {
								content: [{ type: "text", text: "Error: contact is required for conversation" }],
								details: {},
							};
						}
						const messages = db.getConversation(params.contact, limit);
						return {
							content: [{ type: "text", text: JSON.stringify(messages, null, 2) }],
							details: {},
						};
					}

					case "list": {
						const conversations = db.listConversations(params.limit ?? 20);
						return {
							content: [{ type: "text", text: JSON.stringify(conversations, null, 2) }],
							details: {},
						};
					}

					case "search": {
						if (!params.query) {
							return {
								content: [{ type: "text", text: "Error: query is required for search" }],
								details: {},
							};
						}
						const messages = db.searchMessages(params.query, params.limit ?? 20);
						return {
							content: [{ type: "text", text: JSON.stringify(messages, null, 2) }],
							details: {},
						};
					}

					case "send": {
						if (!params.contact) {
							return {
								content: [{ type: "text", text: "Error: contact is required for send" }],
								details: {},
							};
						}
						if (!params.text) {
							return {
								content: [{ type: "text", text: "Error: text is required for send" }],
								details: {},
							};
						}
						const result = db.sendMessage(params.contact, params.text);
						return {
							content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
							details: {},
						};
					}

					default:
						return {
							content: [{ type: "text", text: `Unknown action: ${params.action}` }],
							details: {},
						};
				}
			} catch (e: any) {
				return {
					content: [{ type: "text", text: `Error: ${e.message}` }],
					details: {},
				};
			}
		},
	});
}

export { db as messagesDb };
