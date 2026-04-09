import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { loadContacts, resolveRecipient, resolveSender } from "./contacts.js";

const DB_PATH = join(homedir(), "Library", "Messages", "chat.db");
const APPLE_EPOCH_OFFSET = 978307200;

/**
 * For unnamed group chats, resolve participant names as a comma-separated list.
 * Returns null if not a group chat or no participants found.
 */
function resolveGroupChatName(db: Database.Database, chatIdentifier: string): string | null {
	const chat = db.prepare("SELECT ROWID, style FROM chat WHERE chat_identifier = ?").get(chatIdentifier) as
		| { ROWID: number; style: number }
		| undefined;
	if (!chat || chat.style !== 43) return null; // style 43 = group chat

	const handles = db
		.prepare(
			`SELECT h.id FROM handle h
			JOIN chat_handle_join chj ON h.ROWID = chj.handle_id
			WHERE chj.chat_id = ?`,
		)
		.all(chat.ROWID) as Array<{ id: string }>;

	if (handles.length === 0) return null;
	const names = handles.map((h) => resolveSender(h.id));
	return names.join(", ");
}

function appleTimestampToISO(ts: number | null): string {
	if (!ts || ts === 0) return "";
	const unixTs = ts / 1_000_000_000 + APPLE_EPOCH_OFFSET;
	return new Date(unixTs * 1000).toISOString();
}

/**
 * Extract text from NSAttributedString's attributedBody blob.
 * macOS Ventura+ stores message text in attributedBody (NSKeyedArchiver/typedstream)
 * instead of the `text` column.
 */
function extractTextFromAttributedBody(attributedBody: Buffer | null): string | null {
	if (!attributedBody) return null;
	const buf = Buffer.from(attributedBody);

	const nsStringMarker = Buffer.from("NSString");
	const nsIdx = buf.indexOf(nsStringMarker);
	if (nsIdx < 0) return null;

	// Layout after "NSString": 0x01 + 3 metadata bytes + 0x2b + length + text
	let pos = nsIdx + 13; // 8 (marker) + 1 + 3 + 1 (0x2b)
	if (pos >= buf.length) return null;

	// Decode variable-length encoding
	let textLen: number;
	const lenByte = buf[pos];
	if (lenByte < 0x80) {
		textLen = lenByte;
		pos += 1;
	} else if (lenByte === 0x81) {
		if (pos + 2 >= buf.length) return null;
		textLen = buf[pos + 1] | (buf[pos + 2] << 8);
		pos += 3;
	} else if (lenByte === 0x82) {
		if (pos + 3 >= buf.length) return null;
		textLen = buf[pos + 1] | (buf[pos + 2] << 8) | (buf[pos + 3] << 16);
		pos += 4;
	} else {
		return null;
	}

	if (pos + textLen > buf.length) return null;
	const text = buf.slice(pos, pos + textLen).toString("utf-8");
	// Remove object replacement characters (used for inline attachments)
	return text.replace(/\ufffc/g, "").trim() || null;
}

/**
 * Get the text of a message, falling back to attributedBody extraction
 * when the text column is NULL (macOS Ventura+).
 */
function getMessageText(text: string | null, attributedBody: Buffer | null): string | null {
	if (text) return text;
	return extractTextFromAttributedBody(attributedBody);
}

/**
 * Resolve a chat display name, falling back to contact lookup then group participant names.
 */
function resolveChatName(db: Database.Database, chatName: string | null, chatIdentifier: string | null): string {
	if (chatName) return chatName;
	if (!chatIdentifier) return "";
	const contactName = resolveSender(chatIdentifier);
	if (contactName === chatIdentifier) {
		return resolveGroupChatName(db, chatIdentifier) || chatIdentifier;
	}
	return contactName;
}

function getDb(): Database.Database {
	if (!existsSync(DB_PATH)) {
		throw new Error(`Messages database not found at ${DB_PATH}`);
	}
	return new Database(DB_PATH, { readonly: true, fileMustExist: true });
}

export interface Message {
	sender: string;
	text: string;
	date: string;
	chat?: string;
}

export interface Conversation {
	chat_identifier: string;
	display_name: string;
	last_message: string;
	last_date: string;
}

export function getRecent(limit: number): Message[] {
	const db = getDb();
	try {
		// Fetch more than requested since some may have no extractable text
		const rows = db
			.prepare(
				`SELECT m.text, m.attributedBody, m.is_from_me, m.date AS msg_date,
					h.id AS sender_id, c.display_name AS chat_name, c.chat_identifier
				FROM message m
				LEFT JOIN handle h ON m.handle_id = h.ROWID
				LEFT JOIN chat_message_join cmj ON m.ROWID = cmj.message_id
				LEFT JOIN chat c ON cmj.chat_id = c.ROWID
				WHERE m.text IS NOT NULL OR m.attributedBody IS NOT NULL
				ORDER BY m.date DESC LIMIT ?`,
			)
			.all(limit * 2) as Array<{
			text: string | null;
			attributedBody: Buffer | null;
			is_from_me: number;
			msg_date: number;
			sender_id: string | null;
			chat_name: string | null;
			chat_identifier: string | null;
		}>;

		const results: Message[] = [];
		for (const row of rows) {
			if (results.length >= limit) break;
			const text = getMessageText(row.text, row.attributedBody);
			if (!text) continue;
			results.push({
				sender: row.is_from_me ? "me" : resolveSender(row.sender_id),
				text,
				date: appleTimestampToISO(row.msg_date),
				chat: resolveChatName(db, row.chat_name, row.chat_identifier),
			});
		}
		return results;
	} finally {
		db.close();
	}
}

export function getConversation(contact: string, limit: number): Message[] {
	const contacts = loadContacts();

	// Find handle IDs matching the contact name
	const handleMatches: string[] = [];
	for (const [handle, name] of contacts) {
		if (name.toLowerCase().includes(contact.toLowerCase())) {
			handleMatches.push(handle);
		}
	}

	const db = getDb();
	try {
		let rows: Array<{
			text: string | null;
			attributedBody: Buffer | null;
			is_from_me: number;
			msg_date: number;
			sender_id: string | null;
		}>;

		if (handleMatches.length > 0) {
			const placeholders = handleMatches.map(() => "?").join(",");
			const likeParam = `%${contact}%`;
			rows = db
				.prepare(
					`SELECT m.text, m.attributedBody, m.is_from_me, m.date AS msg_date, h.id AS sender_id
					FROM message m
					LEFT JOIN handle h ON m.handle_id = h.ROWID
					LEFT JOIN chat_message_join cmj ON m.ROWID = cmj.message_id
					LEFT JOIN chat c ON cmj.chat_id = c.ROWID
					WHERE (m.text IS NOT NULL OR m.attributedBody IS NOT NULL)
						AND (h.id IN (${placeholders})
							OR c.chat_identifier LIKE ?
							OR c.display_name LIKE ?)
					ORDER BY m.date DESC LIMIT ?`,
				)
				.all(...handleMatches, likeParam, likeParam, limit * 2) as typeof rows;
		} else {
			const likeParam = `%${contact}%`;
			rows = db
				.prepare(
					`SELECT m.text, m.attributedBody, m.is_from_me, m.date AS msg_date, h.id AS sender_id
					FROM message m
					LEFT JOIN handle h ON m.handle_id = h.ROWID
					LEFT JOIN chat_message_join cmj ON m.ROWID = cmj.message_id
					LEFT JOIN chat c ON cmj.chat_id = c.ROWID
					WHERE (m.text IS NOT NULL OR m.attributedBody IS NOT NULL)
						AND (h.id LIKE ? OR c.chat_identifier LIKE ? OR c.display_name LIKE ?)
					ORDER BY m.date DESC LIMIT ?`,
				)
				.all(likeParam, likeParam, likeParam, limit * 2) as typeof rows;
		}

		const results: Message[] = [];
		for (const row of rows) {
			if (results.length >= limit) break;
			const text = getMessageText(row.text, row.attributedBody);
			if (!text) continue;
			results.push({
				sender: row.is_from_me ? "me" : resolveSender(row.sender_id),
				text,
				date: appleTimestampToISO(row.msg_date),
			});
		}
		return results;
	} finally {
		db.close();
	}
}

export function listConversations(limit: number): Conversation[] {
	const db = getDb();
	try {
		// Get conversations with the most recent message date, then extract text in JS
		const rows = db
			.prepare(
				`SELECT c.ROWID AS chat_rowid, c.chat_identifier, c.display_name,
					(SELECT m3.date FROM message m3
					 JOIN chat_message_join cmj3 ON m3.ROWID = cmj3.message_id
					 WHERE cmj3.chat_id = c.ROWID
					 ORDER BY m3.date DESC LIMIT 1) AS last_date
				FROM chat c WHERE last_date IS NOT NULL
				ORDER BY last_date DESC LIMIT ?`,
			)
			.all(limit) as Array<{
			chat_rowid: number;
			chat_identifier: string;
			display_name: string | null;
			last_date: number;
		}>;

		// For each conversation, get the most recent message with text
		const getLastMsg = db.prepare(
			`SELECT m.text, m.attributedBody FROM message m
			 JOIN chat_message_join cmj ON m.ROWID = cmj.message_id
			 WHERE cmj.chat_id = ?
			 ORDER BY m.date DESC LIMIT 5`,
		);

		return rows.map((row) => {
			let lastMessage = "";
			const msgs = getLastMsg.all(row.chat_rowid) as Array<{
				text: string | null;
				attributedBody: Buffer | null;
			}>;
			for (const msg of msgs) {
				const text = getMessageText(msg.text, msg.attributedBody);
				if (text) {
					lastMessage = text.slice(0, 100);
					break;
				}
			}

			return {
				chat_identifier: row.chat_identifier,
				display_name: row.display_name || resolveChatName(db, null, row.chat_identifier),
				last_message: lastMessage,
				last_date: appleTimestampToISO(row.last_date),
			};
		});
	} finally {
		db.close();
	}
}

export function searchMessages(query: string, limit: number): Message[] {
	const db = getDb();
	try {
		// Search in both text column and by extracting from attributedBody
		// For text column matches:
		const textRows = db
			.prepare(
				`SELECT m.text, m.attributedBody, m.is_from_me, m.date AS msg_date,
					h.id AS sender_id, c.display_name AS chat_name, c.chat_identifier
				FROM message m
				LEFT JOIN handle h ON m.handle_id = h.ROWID
				LEFT JOIN chat_message_join cmj ON m.ROWID = cmj.message_id
				LEFT JOIN chat c ON cmj.chat_id = c.ROWID
				WHERE m.text LIKE ?
				ORDER BY m.date DESC LIMIT ?`,
			)
			.all(`%${query}%`, limit) as Array<{
			text: string | null;
			attributedBody: Buffer | null;
			is_from_me: number;
			msg_date: number;
			sender_id: string | null;
			chat_name: string | null;
			chat_identifier: string | null;
		}>;

		// Also search in attributedBody - we need to scan messages and extract text
		// This is slower but necessary for Ventura+ where text column is NULL
		const abRows = db
			.prepare(
				`SELECT m.text, m.attributedBody, m.is_from_me, m.date AS msg_date,
					h.id AS sender_id, c.display_name AS chat_name, c.chat_identifier
				FROM message m
				LEFT JOIN handle h ON m.handle_id = h.ROWID
				LEFT JOIN chat_message_join cmj ON m.ROWID = cmj.message_id
				LEFT JOIN chat c ON cmj.chat_id = c.ROWID
				WHERE m.text IS NULL AND m.attributedBody IS NOT NULL
				ORDER BY m.date DESC LIMIT ?`,
			)
			.all(limit * 20) as typeof textRows;

		const seen = new Set<string>();
		const results: Message[] = [];

		// Add text column matches first
		for (const row of textRows) {
			if (results.length >= limit) break;
			const text = getMessageText(row.text, row.attributedBody);
			if (!text) continue;
			const key = `${row.msg_date}-${row.sender_id}`;
			if (seen.has(key)) continue;
			seen.add(key);
			results.push({
				sender: row.is_from_me ? "me" : resolveSender(row.sender_id),
				text,
				date: appleTimestampToISO(row.msg_date),
				chat: resolveChatName(db, row.chat_name, row.chat_identifier),
			});
		}

		// Then search attributedBody extractions
		const queryLower = query.toLowerCase();
		for (const row of abRows) {
			if (results.length >= limit) break;
			const text = extractTextFromAttributedBody(row.attributedBody);
			if (!text || !text.toLowerCase().includes(queryLower)) continue;
			const key = `${row.msg_date}-${row.sender_id}`;
			if (seen.has(key)) continue;
			seen.add(key);
			results.push({
				sender: row.is_from_me ? "me" : resolveSender(row.sender_id),
				text,
				date: appleTimestampToISO(row.msg_date),
				chat: resolveChatName(db, row.chat_name, row.chat_identifier),
			});
		}

		return results;
	} finally {
		db.close();
	}
}

export function sendMessage(
	recipient: string,
	text: string,
): { success: boolean; recipient: string; resolvedFrom?: string; message?: string; error?: string } {
	let address: string;
	try {
		address = resolveRecipient(recipient);
	} catch (e: any) {
		return { success: false, recipient, error: e.message };
	}

	const escapedText = text.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
	const escapedAddr = address.replace(/\\/g, "\\\\").replace(/"/g, '\\"');

	const script = `
		tell application "Messages"
			set targetService to 1st account whose service type = iMessage
			set targetBuddy to participant "${escapedAddr}" of targetService
			send "${escapedText}" to targetBuddy
		end tell
	`;

	try {
		execSync(`osascript -e '${script.replace(/'/g, "'\\''")}'`, {
			timeout: 30000,
			stdio: ["pipe", "pipe", "pipe"],
		});
		return {
			success: true,
			recipient: address,
			resolvedFrom: recipient !== address ? recipient : undefined,
			message: text,
		};
	} catch (e: any) {
		return { success: false, recipient: address, error: e.stderr?.toString().trim() || e.message };
	}
}
