import { StringEnum } from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import * as api from "./notion-api.js";

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "notion",
		label: "Notion",
		description: `Read and write Notion pages, databases, and blocks. Actions:
- search: Search pages and databases (optional query, optional type filter)
- read-page: Read a page as markdown (requires id)
- read-blocks: Read child blocks of a page/block (requires id)
- query-db: Query a database with optional filter/sorts (requires id)
- get-db: Get database schema (requires id)
- create-page: Create a page (requires parentId, parentType)
- update-page: Update a page (requires id)
- append: Append markdown to a page (requires id and markdown)
- delete-block: Delete a block (requires id)`,
		parameters: Type.Object({
			action: StringEnum(
				[
					"search",
					"read-page",
					"read-blocks",
					"query-db",
					"get-db",
					"create-page",
					"update-page",
					"append",
					"delete-block",
				] as const,
				{ description: "The action to perform" },
			),
			id: Type.Optional(Type.String({ description: "Page, block, or database ID" })),
			query: Type.Optional(Type.String({ description: "Search query (for search)" })),
			type: Type.Optional(StringEnum(["page", "database"] as const, { description: "Filter type (for search)" })),
			parentId: Type.Optional(Type.String({ description: "Parent page or database ID (for create-page)" })),
			parentType: Type.Optional(
				StringEnum(["page", "database", "data_source"] as const, {
					description: "Parent type (for create-page, default: page)",
				}),
			),
			title: Type.Optional(Type.String({ description: "Page title (for create-page under a page)" })),
			properties: Type.Optional(
				Type.String({ description: "JSON string of properties (for create-page in database, update-page)" }),
			),
			markdown: Type.Optional(
				Type.String({ description: "Markdown content (for create-page, update-page, append)" }),
			),
			filter: Type.Optional(Type.String({ description: "JSON string of filter (for query-db)" })),
			sorts: Type.Optional(Type.String({ description: "JSON string of sorts (for query-db)" })),
			limit: Type.Optional(Type.Number({ description: "Max results (for query-db, default: 50)" })),
			archive: Type.Optional(Type.Boolean({ description: "Archive the page (for update-page)" })),
		}),

		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			try {
				switch (params.action) {
					case "search": {
						const results = await api.search(params.query || "", params.type || "");
						return { content: [{ type: "text", text: JSON.stringify(results, null, 2) }], details: {} };
					}

					case "read-page": {
						if (!params.id) return err("id is required for read-page");
						const page = await api.readPage(params.id);
						return { content: [{ type: "text", text: JSON.stringify(page, null, 2) }], details: {} };
					}

					case "read-blocks": {
						if (!params.id) return err("id is required for read-blocks");
						const blocks = await api.readBlocks(params.id);
						return { content: [{ type: "text", text: JSON.stringify(blocks, null, 2) }], details: {} };
					}

					case "query-db": {
						if (!params.id) return err("id is required for query-db");
						const filter = params.filter ? JSON.parse(params.filter) : undefined;
						const sorts = params.sorts ? JSON.parse(params.sorts) : undefined;
						const results = await api.queryDb(params.id, filter, sorts, params.limit ?? 50);
						return { content: [{ type: "text", text: JSON.stringify(results, null, 2) }], details: {} };
					}

					case "get-db": {
						if (!params.id) return err("id is required for get-db");
						const db = await api.getDb(params.id);
						return { content: [{ type: "text", text: JSON.stringify(db, null, 2) }], details: {} };
					}

					case "create-page": {
						if (!params.parentId) return err("parentId is required for create-page");
						const props = params.properties ? JSON.parse(params.properties) : undefined;
						const page = await api.createPage(
							params.parentId,
							params.parentType || "page",
							params.title,
							props,
							params.markdown,
						);
						return { content: [{ type: "text", text: JSON.stringify(page, null, 2) }], details: {} };
					}

					case "update-page": {
						if (!params.id) return err("id is required for update-page");
						const props = params.properties ? JSON.parse(params.properties) : undefined;
						const page = await api.updatePage(params.id, props, params.markdown, params.archive);
						return { content: [{ type: "text", text: JSON.stringify(page, null, 2) }], details: {} };
					}

					case "append": {
						if (!params.id) return err("id is required for append");
						if (!params.markdown) return err("markdown is required for append");
						const result = await api.appendMarkdown(params.id, params.markdown);
						return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], details: {} };
					}

					case "delete-block": {
						if (!params.id) return err("id is required for delete-block");
						const result = await api.deleteBlock(params.id);
						return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], details: {} };
					}

					default:
						return err(`Unknown action: ${params.action}`);
				}
			} catch (e: any) {
				return err(e.message || String(e));
			}
		},
	});
}

function err(message: string) {
	return { content: [{ type: "text" as const, text: `Error: ${message}` }], details: {} };
}

export { api as notionApi };
