/**
 * Stop hook — the fakechat driver. Two responsibilities:
 *
 *   1. CLOSE: if state/<cwd-hash>/inflight/<msg_id>.json exists, scrape the
 *      latest assistant text from transcript_path and POST it back to the hub
 *      as /v1/messages/<msg_id>/response.
 *
 *   2. DELIVER: if inbox has pending entries (and we're not deferring per
 *      stop_hook_active), claim the oldest by renaming into inflight/, then
 *      emit {"decision":"block","reason":"[from …] <prompt>"} so CC fires
 *      another turn with that as the user input.
 *
 * stdin shape (from CC):
 *   { session_id, transcript_path, cwd, hook_event_name, stop_hook_active }
 */

import * as fs from "node:fs";
import * as path from "node:path";

import {
	stateDirFor,
	readIdentity,
	listInflight,
	claimNextInbound,
	clearInflight,
	pulse,
	appendErrorLog,
	readJson,
	type InboxEntry,
} from "../server/state-store.ts";

interface StopHookInput {
	session_id?: string;
	transcript_path?: string;
	cwd?: string;
	hook_event_name?: string;
	stop_hook_active?: boolean;
}

interface InflightEntry extends InboxEntry {
	claimed_at?: string;
}

interface Identity {
	session_id: string;
	name: string;
	project: string;
	hub_url: string;
	auth_token: string;
	state_dir: string;
}

async function readStdin(): Promise<string> {
	const chunks: Buffer[] = [];
	for await (const chunk of process.stdin) {
		chunks.push(chunk as Buffer);
	}
	return Buffer.concat(chunks).toString("utf-8");
}

function extractLastAssistantText(transcriptPath: string): string {
	let raw: string;
	try {
		raw = fs.readFileSync(transcriptPath, "utf-8");
	} catch {
		return "";
	}
	const lines = raw.split("\n").filter(Boolean);
	for (let i = lines.length - 1; i >= 0; i--) {
		let entry: any;
		try { entry = JSON.parse(lines[i]); } catch { continue; }
		const m = entry?.message;
		if (!m || m.role !== "assistant") continue;
		if (Array.isArray(m.content)) {
			const text = m.content
				.filter((b: any) => b?.type === "text" && typeof b.text === "string")
				.map((b: any) => b.text)
				.join("\n");
			if (text.length > 0) return text;
		} else if (typeof m.content === "string") {
			return m.content;
		}
	}
	return "";
}

async function postResponse(
	identity: Identity,
	msg_id: string,
	response: any,
	error: string | null,
): Promise<{ ok: boolean; status: number; detail?: string }> {
	const url = identity.hub_url.replace(/\/+$/, "") +
		`/v1/messages/${encodeURIComponent(msg_id)}/response`;
	try {
		const resp = await fetch(url, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${identity.auth_token}`,
				"Content-Type": "application/json",
				Accept: "application/json",
			},
			body: JSON.stringify({
				project: identity.project,
				responder_session: identity.session_id,
				response,
				error,
			}),
		});
		const text = await resp.text();
		if (!resp.ok) return { ok: false, status: resp.status, detail: text };
		return { ok: true, status: resp.status };
	} catch (err: any) {
		return { ok: false, status: 0, detail: err?.message ?? String(err) };
	}
}

async function main(): Promise<void> {
	const stdin = await readStdin();
	let input: StopHookInput;
	try { input = JSON.parse(stdin); } catch { process.exit(0); }
	const cwd = input.cwd || process.cwd();
	const stateDir = stateDirFor(cwd);
	const identity = readIdentity<Identity>(stateDir);
	if (!identity || !identity.hub_url || !identity.auth_token) {
		// Plugin inactive for this cwd. Let CC stop normally.
		process.exit(0);
	}

	pulse(stateDir);

	// ── 1. CLOSE in-flight inbounds. Runs regardless of stop_hook_active.
	const transcriptPath = input.transcript_path;
	if (transcriptPath && fs.existsSync(transcriptPath)) {
		const lastText = extractLastAssistantText(transcriptPath);
		for (const filePath of listInflight(stateDir)) {
			const entry = readJson<InflightEntry>(filePath);
			if (!entry) {
				clearInflight(filePath);
				continue;
			}
			const result = await postResponse(identity, entry.msg_id, lastText, null);
			if (!result.ok) {
				appendErrorLog(
					stateDir,
					`response POST failed for ${entry.msg_id}: HTTP ${result.status} ${result.detail ?? ""}`,
				);
			}
			clearInflight(filePath);
		}
	}

	// ── 2. DELIVER next inbound — unless deferring.
	if (input.stop_hook_active === true) {
		// Defer: drain on the next natural Stop instead of chaining.
		process.exit(0);
	}

	const claim = claimNextInbound(stateDir);
	if (!claim) {
		// Inbox empty — let CC stop normally.
		process.exit(0);
	}

	const { entry } = claim;
	const reason =
		`[from ${entry.sender_name} @ ${entry.sender_cwd}]\n\n${entry.prompt}`;
	const output = {
		decision: "block",
		reason,
		systemMessage:
			`coms-net inbound from ${entry.sender_name}. Reply with a normal assistant ` +
			`message — your final text is auto-submitted back to the caller. Do NOT use ` +
			`coms_net_send to reply.`,
	};
	process.stdout.write(JSON.stringify(output));
	process.exit(0);
}

main().catch((err) => {
	try {
		const stateDir = stateDirFor(process.cwd());
		appendErrorLog(stateDir, `stop.ts crashed: ${err?.stack ?? String(err)}`);
	} catch { /* ignore */ }
	process.exit(0);
});
