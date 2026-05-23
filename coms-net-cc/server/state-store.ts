/**
 * state-store — atomic per-file I/O for the coms-net-cc plugin.
 *
 * State directory is keyed by sha1(cwd) so the MCP server (which sees
 * process.cwd()) and the Stop/SessionEnd hooks (which receive `cwd` from CC's
 * stdin) can both derive the same path independently.
 *
 * Layout under ~/.claude/plugins/coms-net-cc/state/<cwd-hash>/:
 *   identity.json
 *   inbox/<msg_id>.json     — written by MCP server on SSE prompt event
 *   inflight/<msg_id>.json  — Stop hook claims via fs.renameSync from inbox/
 *   pulse.json              — Stop hook bumps this on each fire (liveness)
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as crypto from "node:crypto";

const STATE_ROOT = path.join(os.homedir(), ".claude", "plugins", "coms-net-cc", "state");

export function stateDirFor(cwd: string): string {
	const hash = crypto.createHash("sha1").update(cwd).digest("hex").slice(0, 12);
	return path.join(STATE_ROOT, hash);
}

export function ensureStateDir(cwd: string): string {
	const dir = stateDirFor(cwd);
	fs.mkdirSync(path.join(dir, "inbox"), { recursive: true });
	fs.mkdirSync(path.join(dir, "inflight"), { recursive: true });
	return dir;
}

export function atomicWrite(filePath: string, content: string): void {
	const dir = path.dirname(filePath);
	fs.mkdirSync(dir, { recursive: true });
	const tmp = `${filePath}.tmp.${process.pid}.${Date.now()}`;
	fs.writeFileSync(tmp, content);
	fs.renameSync(tmp, filePath);
}

export function atomicWriteJson(filePath: string, obj: unknown): void {
	atomicWrite(filePath, JSON.stringify(obj, null, 2));
}

export function readJson<T = unknown>(filePath: string): T | null {
	try {
		if (!fs.existsSync(filePath)) return null;
		return JSON.parse(fs.readFileSync(filePath, "utf-8")) as T;
	} catch {
		return null;
	}
}

export function writeIdentity(stateDir: string, identity: object): void {
	atomicWriteJson(path.join(stateDir, "identity.json"), identity);
}

export function readIdentity<T = unknown>(stateDir: string): T | null {
	return readJson<T>(path.join(stateDir, "identity.json"));
}

export interface InboxEntry {
	msg_id: string;
	sender_session: string;
	sender_name: string;
	sender_cwd: string;
	prompt: string;
	/** Sender-supplied summary (≤200 chars) or null. */
	summary: string | null;
	/** Sender peer-state snapshot from the hub at send time. */
	sender_context_pct?: number;
	sender_status?: "online" | "stale" | "offline";
	sender_observed_age_ms?: number;
	hops: number;
	response_schema: object | null;
	received_at: string;
}

export function writeInbox(stateDir: string, entry: InboxEntry): string {
	const filePath = path.join(stateDir, "inbox", `${entry.msg_id}.json`);
	atomicWriteJson(filePath, entry);
	return filePath;
}

export function listInbox(stateDir: string): string[] {
	const dir = path.join(stateDir, "inbox");
	try {
		return fs.readdirSync(dir)
			.filter((f) => f.endsWith(".json"))
			.map((f) => path.join(dir, f));
	} catch {
		return [];
	}
}

export function listInflight(stateDir: string): string[] {
	const dir = path.join(stateDir, "inflight");
	try {
		return fs.readdirSync(dir)
			.filter((f) => f.endsWith(".json"))
			.map((f) => path.join(dir, f));
	} catch {
		return [];
	}
}

/**
 * Atomically move the oldest inbox file into inflight/. Returns the new path
 * and the entry contents, or null if the inbox is empty.
 *
 * `fs.renameSync` across the same filesystem is atomic in POSIX, so two
 * concurrent claimers race-safely: one wins, the other gets ENOENT.
 */
export function claimNextInbound(stateDir: string): { entry: InboxEntry; inflightPath: string } | null {
	const files = listInbox(stateDir);
	if (files.length === 0) return null;
	// Oldest by mtime.
	const sorted = files
		.map((f) => ({ f, mtime: fs.statSync(f).mtimeMs }))
		.sort((a, b) => a.mtime - b.mtime);
	for (const { f } of sorted) {
		const msgId = path.basename(f, ".json");
		const target = path.join(stateDir, "inflight", `${msgId}.json`);
		try {
			fs.renameSync(f, target);
		} catch (e: any) {
			// ENOENT means someone else claimed it; try the next file.
			if (e?.code === "ENOENT") continue;
			throw e;
		}
		const entry = readJson<InboxEntry>(target);
		if (!entry) {
			// Corrupt file — drop it and try the next.
			try { fs.unlinkSync(target); } catch { /* ignore */ }
			continue;
		}
		return { entry, inflightPath: target };
	}
	return null;
}

export function clearInflight(inflightPath: string): void {
	try { fs.unlinkSync(inflightPath); } catch { /* idempotent */ }
}

export function pulse(stateDir: string): void {
	atomicWriteJson(path.join(stateDir, "pulse.json"), { last_stop_at: new Date().toISOString() });
}

export function readPulse(stateDir: string): { last_stop_at: string } | null {
	return readJson<{ last_stop_at: string }>(path.join(stateDir, "pulse.json"));
}

export function appendErrorLog(stateDir: string, msg: string): void {
	const logPath = path.join(stateDir, "errors.log");
	try {
		fs.appendFileSync(logPath, `${new Date().toISOString()} ${msg}\n`);
	} catch {
		// best-effort
	}
}
