import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { loadContacts, resolveRecipient, resolveSender } from "./contacts.js";

const DB_PATH = join(homedir(), "Library", "Messages", "chat.db");
const APPLE_EPOCH_OFFSET = 978307200;

function appleTimestampToISO(ts: number | null): string {
	if (!ts || ts === 0) return "";
	const unixTs = ts / 1_000_000_000 + APPLE_EPOCH_OFFSET;
	return new Date(unixTs * 1000).toISOString();
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
		const rows = db
			.prepare(
				`SELECT m.text, m.is_from_me, m.date AS msg_date,
					h.id AS sender_id, c.display_name AS chat_name, c.chat_identifier
				FROM message m
				LEFT JOIN handle h ON m.handle_id = h.ROWID
				LEFT JOIN chat_message_join cmj ON m.ROWID = cmj.message_id
				LEFT JOIN chat c ON cmj.chat_id = c.ROWID
				WHERE m.text IS NOT NULL AND m.text != ''
				ORDER BY m.date DESC LIMIT ?`,
			)
			.all(limit) as Array<{
			text: string;
			is_from_me: number;
			msg_date: number;
			sender_id: string | null;
			chat_name: string | null;
			chat_identifier: string | null;
		}>;

		return rows.map((row) => ({
			sender: row.is_from_me ? "me" : resolveSender(row.sender_id),
			text: row.text,
			date: appleTimestampToISO(row.msg_date),
			chat: row.chat_name || resolveSender(row.chat_identifier) || "",
		}));
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
			text: string;
			is_from_me: number;
			msg_date: number;
			sender_id: string | null;
		}>;

		if (handleMatches.length > 0) {
			const placeholders = handleMatches.map(() => "?").join(",");
			const likeParam = `%${contact}%`;
			rows = db
				.prepare(
					`SELECT m.text, m.is_from_me, m.date AS msg_date, h.id AS sender_id
					FROM message m
					LEFT JOIN handle h ON m.handle_id = h.ROWID
					LEFT JOIN chat_message_join cmj ON m.ROWID = cmj.message_id
					LEFT JOIN chat c ON cmj.chat_id = c.ROWID
					WHERE m.text IS NOT NULL AND m.text != ''
						AND (h.id IN (${placeholders})
							OR c.chat_identifier LIKE ?
							OR c.display_name LIKE ?)
					ORDER BY m.date DESC LIMIT ?`,
				)
				.all(...handleMatches, likeParam, likeParam, limit) as typeof rows;
		} else {
			const likeParam = `%${contact}%`;
			rows = db
				.prepare(
					`SELECT m.text, m.is_from_me, m.date AS msg_date, h.id AS sender_id
					FROM message m
					LEFT JOIN handle h ON m.handle_id = h.ROWID
					LEFT JOIN chat_message_join cmj ON m.ROWID = cmj.message_id
					LEFT JOIN chat c ON cmj.chat_id = c.ROWID
					WHERE m.text IS NOT NULL AND m.text != ''
						AND (h.id LIKE ? OR c.chat_identifier LIKE ? OR c.display_name LIKE ?)
					ORDER BY m.date DESC LIMIT ?`,
				)
				.all(likeParam, likeParam, likeParam, limit) as typeof rows;
		}

		return rows.map((row) => ({
			sender: row.is_from_me ? "me" : resolveSender(row.sender_id),
			text: row.text,
			date: appleTimestampToISO(row.msg_date),
		}));
	} finally {
		db.close();
	}
}

export function listConversations(limit: number): Conversation[] {
	const db = getDb();
	try {
		const rows = db
			.prepare(
				`SELECT c.chat_identifier, c.display_name,
					(SELECT m2.text FROM message m2
					 JOIN chat_message_join cmj2 ON m2.ROWID = cmj2.message_id
					 WHERE cmj2.chat_id = c.ROWID AND m2.text IS NOT NULL AND m2.text != ''
					 ORDER BY m2.date DESC LIMIT 1) AS last_message,
					(SELECT m3.date FROM message m3
					 JOIN chat_message_join cmj3 ON m3.ROWID = cmj3.message_id
					 WHERE cmj3.chat_id = c.ROWID
					 ORDER BY m3.date DESC LIMIT 1) AS last_date
				FROM chat c WHERE last_message IS NOT NULL
				ORDER BY last_date DESC LIMIT ?`,
			)
			.all(limit) as Array<{
			chat_identifier: string;
			display_name: string | null;
			last_message: string;
			last_date: number;
		}>;

		return rows.map((row) => ({
			chat_identifier: row.chat_identifier,
			display_name: row.display_name || resolveSender(row.chat_identifier) || "",
			last_message: (row.last_message || "").slice(0, 100),
			last_date: appleTimestampToISO(row.last_date),
		}));
	} finally {
		db.close();
	}
}

export function searchMessages(query: string, limit: number): Message[] {
	const db = getDb();
	try {
		const rows = db
			.prepare(
				`SELECT m.text, m.is_from_me, m.date AS msg_date,
					h.id AS sender_id, c.display_name AS chat_name, c.chat_identifier
				FROM message m
				LEFT JOIN handle h ON m.handle_id = h.ROWID
				LEFT JOIN chat_message_join cmj ON m.ROWID = cmj.message_id
				LEFT JOIN chat c ON cmj.chat_id = c.ROWID
				WHERE m.text LIKE ?
				ORDER BY m.date DESC LIMIT ?`,
			)
			.all(`%${query}%`, limit) as Array<{
			text: string;
			is_from_me: number;
			msg_date: number;
			sender_id: string | null;
			chat_name: string | null;
			chat_identifier: string | null;
		}>;

		return rows.map((row) => ({
			sender: row.is_from_me ? "me" : resolveSender(row.sender_id),
			text: row.text,
			date: appleTimestampToISO(row.msg_date),
			chat: row.chat_name || resolveSender(row.chat_identifier) || "",
		}));
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
