import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";

const CONTACTS_DIR = join(homedir(), "Library", "Application Support", "AddressBook");

let contactsCache: Map<string, string> | null = null;

export function normalizePhone(raw: string): string {
	const digits = raw.replace(/[^\d+]/g, "");
	if (digits.startsWith("+")) return digits;
	if (digits.replace(/^\+/, "").length === 10) return `+1${digits}`;
	return digits ? `+${digits}` : raw;
}

export function loadContacts(): Map<string, string> {
	if (contactsCache) return contactsCache;

	const lookup = new Map<string, string>();
	const dbPaths: string[] = [];

	// Scan Sources directories
	const sourcesDir = join(CONTACTS_DIR, "Sources");
	if (existsSync(sourcesDir)) {
		for (const entry of readdirSync(sourcesDir, { withFileTypes: true })) {
			if (entry.isDirectory()) {
				const dbPath = join(sourcesDir, entry.name, "AddressBook-v22.abcddb");
				if (existsSync(dbPath)) dbPaths.push(dbPath);
			}
		}
	}

	// Also check the root AddressBook database
	const rootDb = join(CONTACTS_DIR, "AddressBook-v22.abcddb");
	if (existsSync(rootDb)) dbPaths.push(rootDb);

	for (const dbPath of dbPaths) {
		try {
			const db = new Database(dbPath, { readonly: true, fileMustExist: true });

			// Phone numbers
			const phoneRows = db
				.prepare(
					`SELECT r.ZFIRSTNAME, r.ZLASTNAME, r.ZORGANIZATION, p.ZFULLNUMBER
					FROM ZABCDRECORD r
					JOIN ZABCDPHONENUMBER p ON p.ZOWNER = r.Z_PK
					WHERE p.ZFULLNUMBER IS NOT NULL`,
				)
				.all() as Array<{
				ZFIRSTNAME: string | null;
				ZLASTNAME: string | null;
				ZORGANIZATION: string | null;
				ZFULLNUMBER: string;
			}>;

			for (const row of phoneRows) {
				const name = [row.ZFIRSTNAME, row.ZLASTNAME].filter(Boolean).join(" ") || row.ZORGANIZATION || "";
				if (name && row.ZFULLNUMBER) {
					lookup.set(normalizePhone(row.ZFULLNUMBER), name);
				}
			}

			// Email addresses
			const emailRows = db
				.prepare(
					`SELECT r.ZFIRSTNAME, r.ZLASTNAME, r.ZORGANIZATION, e.ZADDRESS
					FROM ZABCDRECORD r
					JOIN ZABCDEMAILADDRESS e ON e.ZOWNER = r.Z_PK
					WHERE e.ZADDRESS IS NOT NULL`,
				)
				.all() as Array<{
				ZFIRSTNAME: string | null;
				ZLASTNAME: string | null;
				ZORGANIZATION: string | null;
				ZADDRESS: string;
			}>;

			for (const row of emailRows) {
				const name = [row.ZFIRSTNAME, row.ZLASTNAME].filter(Boolean).join(" ") || row.ZORGANIZATION || "";
				if (name && row.ZADDRESS) {
					lookup.set(row.ZADDRESS.toLowerCase(), name);
				}
			}

			db.close();
		} catch {}
	}

	contactsCache = lookup;
	return lookup;
}

export function resolveSender(handleId: string | null): string {
	if (!handleId) return "unknown";
	const contacts = loadContacts();
	const normalized = normalizePhone(handleId);
	if (contacts.has(normalized)) return contacts.get(normalized)!;
	if (contacts.has(handleId.toLowerCase())) return contacts.get(handleId.toLowerCase())!;
	return handleId;
}

/**
 * Resolve a contact name to a phone number or email for sending.
 * Throws if ambiguous or not found.
 */
export function resolveRecipient(contact: string): string {
	// Already a phone number or email
	if (contact.includes("@") || /^\+?\d[\d\s\-()]+$/.test(contact)) {
		return contact;
	}

	const contacts = loadContacts();
	const query = contact.toLowerCase();

	// Exact name match
	const exact = new Map<string, string>();
	for (const [handle, name] of contacts) {
		if (name.toLowerCase() === query) {
			exact.set(handle, name);
		}
	}
	if (exact.size > 0) {
		const uniqueNames = new Set(exact.values());
		if (uniqueNames.size > 1) {
			throw new Error(`Ambiguous: matched ${[...uniqueNames].sort().join(", ")}`);
		}
		// Prefer phone numbers
		for (const handle of exact.keys()) {
			if (handle.startsWith("+")) return handle;
		}
		return exact.keys().next().value!;
	}

	// Substring match
	const sub = new Map<string, string>();
	for (const [handle, name] of contacts) {
		if (name.toLowerCase().includes(query)) {
			sub.set(handle, name);
		}
	}
	if (sub.size > 0) {
		const uniqueNames = new Set(sub.values());
		if (uniqueNames.size > 1) {
			throw new Error(`Ambiguous: matched ${[...uniqueNames].sort().join(", ")}`);
		}
		for (const handle of sub.keys()) {
			if (handle.startsWith("+")) return handle;
		}
		return sub.keys().next().value!;
	}

	throw new Error(`Contact not found: '${contact}'`);
}
