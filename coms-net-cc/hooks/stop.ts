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
	listInbox,
	listInflight,
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

function extractAssistantText(message: any): string {
	if (!message || message.role !== "assistant") return "";
	if (Array.isArray(message.content)) {
		return message.content
			.filter((b: any) => b?.type === "text" && typeof b.text === "string")
			.map((b: any) => b.text)
			.join("\n");
	}
	if (typeof message.content === "string") return message.content;
	return "";
}

function loadTranscript(transcriptPath: string): any[] {
	let raw: string;
	try { raw = fs.readFileSync(transcriptPath, "utf-8"); }
	catch { return []; }
	return raw.split("\n").filter(Boolean).map((line) => {
		try { return JSON.parse(line); } catch { return null; }
	}).filter(Boolean);
}

function extractLastAssistantText(transcript: any[]): string {
	for (let i = transcript.length - 1; i >= 0; i--) {
		const text = extractAssistantText(transcript[i]?.message);
		if (text) return text;
	}
	return "";
}

/**
 * Scan transcript for user-role messages that contain channel events the MCP
 * server pushed via notifications/claude/channel. For each one, find the
 * assistant text that follows (the inline reply). Returns map: msg_id → reply.
 *
 * Channel events appear in the JSONL as user messages whose text content
 * matches `<channel ... msg_id="X" ...>body</channel>` (per the team-bus
 * pattern documented at /root/agent-view-teams).
 */
function findChannelReplies(transcript: any[]): {
	replies: Map<string, string>;
	seenMsgIds: Set<string>;
} {
	const replies = new Map<string, string>();
	const seenMsgIds = new Set<string>();
	const channelMsgIdRe = /<channel\b[^>]*\bmsg_id="([^"]+)"[^>]*>/;
	for (let i = 0; i < transcript.length; i++) {
		const entry = transcript[i];
		const m = entry?.message;
		if (!m || m.role !== "user") continue;
		const userText = Array.isArray(m.content)
			? m.content.map((b: any) => (typeof b?.text === "string" ? b.text : "")).join("\n")
			: (typeof m.content === "string" ? m.content : "");
		const match = userText.match(channelMsgIdRe);
		if (!match) continue;
		const msgId = match[1];
		seenMsgIds.add(msgId);
		for (let j = i + 1; j < transcript.length; j++) {
			const next = transcript[j]?.message;
			if (next?.role !== "assistant") continue;
			const text = extractAssistantText(next);
			if (text) {
				replies.set(msgId, text);
				break;
			}
		}
	}
	return { replies, seenMsgIds };
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

	const transcriptPath = input.transcript_path;

	// Race tolerance: CC fires Stop very close to (sometimes ~100ms after) the
	// assistant message hitting disk. If we have inbox entries from channel
	// pushes, briefly re-poll the transcript until either (a) every channel'd
	// msg_id has a following assistant text, or (b) we've waited ~750ms.
	const inboxMsgIds = new Set(
		listInbox(stateDir).map((f) => path.basename(f, ".json")),
	);
	const RETRY_MS = 200;
	const MAX_WAIT_MS = 750;
	let transcript = transcriptPath && fs.existsSync(transcriptPath)
		? loadTranscript(transcriptPath)
		: [];
	let waited = 0;
	while (waited < MAX_WAIT_MS && inboxMsgIds.size > 0) {
		const { replies, seenMsgIds } = findChannelReplies(transcript);
		const channeledInboxes = [...inboxMsgIds].filter((m) => seenMsgIds.has(m));
		if (channeledInboxes.length === 0) break; // no channel-pushed entries to wait on
		const allHaveReplies = channeledInboxes.every((m) => replies.has(m));
		if (allHaveReplies) break;
		await new Promise((r) => setTimeout(r, RETRY_MS));
		waited += RETRY_MS;
		transcript = transcriptPath && fs.existsSync(transcriptPath)
			? loadTranscript(transcriptPath)
			: [];
	}

	// ── 1a. CLOSE old-style inflight (fakechat decision:block path):
	// the response is whatever the LAST assistant message says.
	if (transcript.length > 0) {
		const lastText = extractLastAssistantText(transcript);
		for (const filePath of listInflight(stateDir)) {
			const entry = readJson<InflightEntry>(filePath);
			if (!entry) { clearInflight(filePath); continue; }
			const result = await postResponse(identity, entry.msg_id, lastText, null);
			if (!result.ok) {
				appendErrorLog(
					stateDir,
					`response POST (inflight) failed for ${entry.msg_id}: HTTP ${result.status} ${result.detail ?? ""}`,
				);
			}
			clearInflight(filePath);
		}
	}

	// ── 1b. CLOSE channel-pushed inbox entries: walk the transcript for
	// <channel msg_id="X"> events and submit the assistant text following each
	// one. Then delete the corresponding inbox file.
	const channelInfo = transcript.length > 0
		? findChannelReplies(transcript)
		: { replies: new Map<string, string>(), seenMsgIds: new Set<string>() };
	if (channelInfo.replies.size > 0) {
		for (const inboxPath of listInbox(stateDir)) {
			const msgId = path.basename(inboxPath, ".json");
			const reply = channelInfo.replies.get(msgId);
			if (!reply) continue;
			const result = await postResponse(identity, msgId, reply, null);
			if (!result.ok) {
				appendErrorLog(
					stateDir,
					`response POST (channel) failed for ${msgId}: HTTP ${result.status} ${result.detail ?? ""}`,
				);
			}
			try { fs.unlinkSync(inboxPath); } catch { /* idempotent */ }
		}
	}

	// ── 2. FAKECHAT FALLBACK: inbox entries the channel push did NOT reach
	// at all (Claude has never seen them) get the decision:block treatment.
	// Skip any inbox file whose msg_id appears as a channel event in the
	// transcript — Claude has already seen it; just wait for the reply.
	if (input.stop_hook_active === true) {
		process.exit(0);
	}

	// Pick the oldest inbox file whose msg_id has NOT yet been delivered via
	// channel push (otherwise we'd double-deliver — Claude already saw it).
	const candidateFiles = listInbox(stateDir)
		.map((f) => ({ f, mtime: fs.statSync(f).mtimeMs }))
		.sort((a, b) => a.mtime - b.mtime)
		.map(({ f }) => f);
	let claim: { entry: InboxEntry; inflightPath: string } | null = null;
	for (const f of candidateFiles) {
		const msgId = path.basename(f, ".json");
		if (channelInfo.seenMsgIds.has(msgId)) continue;
		const target = path.join(stateDir, "inflight", `${msgId}.json`);
		try { fs.renameSync(f, target); } catch { continue; }
		const entry = readJson<InboxEntry>(target);
		if (!entry) { try { fs.unlinkSync(target); } catch { /* ignore */ } continue; }
		claim = { entry, inflightPath: target };
		break;
	}
	if (!claim) {
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
