import { Client, collectPaginatedAPI } from "@notionhq/client";

let client: Client | null = null;

export function getClient(): Client {
	if (client) return client;
	const token = process.env.NOTION_TOKEN || "";
	if (!token) throw new Error("NOTION_TOKEN not set in environment");
	client = new Client({ auth: token });
	return client;
}

// --- Helpers ---

function richTextToStr(rtList: Array<{ plain_text?: string }>): string {
	return rtList.map((item) => item.plain_text || "").join("");
}

function extractTitle(props: Record<string, any>): string {
	for (const prop of Object.values(props)) {
		if (prop?.type === "title") {
			return richTextToStr(prop.title || []);
		}
	}
	return "";
}

function extractPropertyValue(prop: Record<string, any>): any {
	const ptype = prop.type;
	switch (ptype) {
		case "title":
			return richTextToStr(prop.title || []);
		case "rich_text":
			return richTextToStr(prop.rich_text || []);
		case "number":
			return prop.number;
		case "select":
			return prop.select?.name ?? null;
		case "multi_select":
			return (prop.multi_select || []).map((o: any) => o.name);
		case "status":
			return prop.status?.name ?? null;
		case "date": {
			const d = prop.date;
			if (!d) return null;
			return d.end ? `${d.start} → ${d.end}` : d.start;
		}
		case "checkbox":
			return prop.checkbox;
		case "url":
			return prop.url;
		case "email":
			return prop.email;
		case "phone_number":
			return prop.phone_number;
		case "people":
			return (prop.people || []).map((p: any) => p.name || p.id || "");
		case "relation":
			return (prop.relation || []).map((r: any) => r.id);
		case "formula": {
			const f = prop.formula || {};
			return f[f.type] ?? null;
		}
		case "rollup": {
			const r = prop.rollup || {};
			return r[r.type] ?? null;
		}
		case "created_time":
			return prop.created_time;
		case "last_edited_time":
			return prop.last_edited_time;
		case "created_by":
			return prop.created_by?.name || prop.created_by?.id || "";
		case "last_edited_by":
			return prop.last_edited_by?.name || prop.last_edited_by?.id || "";
		case "files":
			return (prop.files || []).map((f: any) => f.name || f.external?.url || "");
		default:
			return null;
	}
}

export interface PageSummary {
	id: string;
	title: string;
	url: string;
	created_time: string;
	last_edited_time: string;
	archived: boolean;
	properties?: Record<string, any>;
	markdown?: string;
}

export interface DbSummary {
	id: string;
	title: string;
	url: string;
	properties: string[];
	properties_detail?: Record<string, any>;
}

function formatPage(page: any, includeProperties = false): PageSummary {
	const props = page.properties || {};
	const summary: PageSummary = {
		id: page.id,
		title: extractTitle(props),
		url: page.url || "",
		created_time: page.created_time || "",
		last_edited_time: page.last_edited_time || "",
		archived: page.archived || false,
	};
	if (includeProperties && props) {
		const extracted: Record<string, any> = {};
		for (const [name, prop] of Object.entries(props) as Array<[string, any]>) {
			if (prop.type === "title") continue;
			const val = extractPropertyValue(prop);
			if (val !== null && val !== undefined && !(Array.isArray(val) && val.length === 0) && val !== "") {
				extracted[name] = val;
			}
		}
		if (Object.keys(extracted).length > 0) {
			summary.properties = extracted;
		}
	}
	return summary;
}

function formatDb(db: any): DbSummary {
	return {
		id: db.id,
		title: richTextToStr(db.title || []),
		url: db.url || "",
		properties: Object.keys(db.properties || {}),
	};
}

// --- API Functions ---

export async function search(query: string, type: string): Promise<any[]> {
	const notion = getClient();
	const params: any = {};
	if (query) params.query = query;
	if (type === "page") params.filter = { value: "page", property: "object" };
	else if (type === "database") params.filter = { value: "data_source", property: "object" };

	const resp = await notion.search(params);
	return resp.results.map((item: any) => {
		if (item.object === "page") return formatPage(item);
		if (item.object === "database" || item.object === "data_source") return formatDb(item);
		return item;
	});
}

export async function readPage(pageId: string): Promise<PageSummary> {
	const notion = getClient();
	const page = await notion.pages.retrieve({ page_id: pageId });
	const md: any = await (notion as any).request({
		path: `pages/${pageId}/markdown`,
		method: "get",
	});
	const summary = formatPage(page);
	summary.markdown = md.markdown || "";
	return summary;
}

export async function readBlocks(blockId: string): Promise<any[]> {
	const notion = getClient();
	const blocks = await collectPaginatedAPI(notion.blocks.children.list, { block_id: blockId });
	return blocks.map((block: any) => {
		const entry: any = {
			id: block.id,
			type: block.type,
			has_children: block.has_children || false,
		};
		const content = block[block.type] || {};
		if (content.rich_text) entry.text = richTextToStr(content.rich_text);
		if (content.url) entry.url = content.url;
		if (content.caption) entry.caption = richTextToStr(content.caption);
		if ("checked" in content) entry.checked = content.checked;
		return entry;
	});
}

export async function queryDb(databaseId: string, filter?: any, sorts?: any, limit = 50): Promise<PageSummary[]> {
	const notion = getClient();
	const body: any = { page_size: Math.min(limit, 100) };
	if (filter) body.filter = filter;
	if (sorts) body.sorts = sorts;

	let resp: any;
	try {
		resp = await (notion as any).request({
			path: `databases/${databaseId}/query`,
			method: "post",
			body,
		});
	} catch {
		resp = await (notion as any).request({
			path: `data_sources/${databaseId}/query`,
			method: "post",
			body,
		});
	}
	return (resp.results || []).map((p: any) => formatPage(p, true));
}

export async function getDb(databaseId: string): Promise<DbSummary> {
	const notion = getClient();
	let db: any;
	try {
		db = await notion.databases.retrieve({ database_id: databaseId });
	} catch {
		db = await (notion as any).request({
			path: `data_sources/${databaseId}`,
			method: "get",
		});
	}
	const summary = formatDb(db);
	const propsDetail: Record<string, any> = {};
	for (const [name, prop] of Object.entries(db.properties || {}) as Array<[string, any]>) {
		const info: any = { type: prop.type };
		if (prop.type === "select") info.options = (prop.select?.options || []).map((o: any) => o.name);
		else if (prop.type === "multi_select") info.options = (prop.multi_select?.options || []).map((o: any) => o.name);
		else if (prop.type === "status") info.options = (prop.status?.options || []).map((o: any) => o.name);
		propsDetail[name] = info;
	}
	summary.properties_detail = propsDetail;
	return summary;
}

export async function createPage(
	parentId: string,
	parentType: string,
	title?: string,
	properties?: any,
	markdown?: string,
): Promise<PageSummary> {
	const notion = getClient();
	const params: any = {};

	if (parentType === "database" || parentType === "data_source") {
		params.parent = { database_id: parentId };
		params.properties = properties || {};
	} else {
		params.parent = { page_id: parentId };
		if (title) params.properties = { title: [{ text: { content: title } }] };
	}
	if (markdown) params.markdown = markdown;

	let page: any;
	try {
		page = await notion.pages.create(params);
	} catch {
		if (parentType === "database" || parentType === "data_source") {
			params.parent = { data_source_id: parentId };
			page = await (notion as any).request({ path: "pages", method: "post", body: params });
		} else {
			throw new Error("Failed to create page");
		}
	}
	return formatPage(page);
}

export async function updatePage(
	pageId: string,
	properties?: any,
	markdown?: string,
	archive?: boolean,
): Promise<PageSummary> {
	const notion = getClient();

	if (markdown !== undefined) {
		await (notion as any).request({
			path: `pages/${pageId}/markdown`,
			method: "patch",
			body: { markdown },
		});
	}

	const params: any = { page_id: pageId };
	if (properties) params.properties = properties;
	if (archive) params.archived = true;

	const page = await notion.pages.update(params);
	return formatPage(page);
}

export async function appendMarkdown(pageId: string, markdown: string): Promise<{ status: string; page_id: string }> {
	const notion = getClient();
	const current: any = await (notion as any).request({
		path: `pages/${pageId}/markdown`,
		method: "get",
	});
	const existing = current.markdown || "";
	const combined = existing ? `${existing}\n${markdown}` : markdown;
	await (notion as any).request({
		path: `pages/${pageId}/markdown`,
		method: "patch",
		body: { markdown: combined },
	});
	return { status: "ok", page_id: pageId };
}

export async function deleteBlock(blockId: string): Promise<{ status: string; block_id: string }> {
	const notion = getClient();
	await notion.blocks.delete({ block_id: blockId });
	return { status: "deleted", block_id: blockId };
}
