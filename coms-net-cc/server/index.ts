/**
 * coms-net-cc — MCP server entrypoint.
 *
 * Lifecycle:
 *   1. Resolve identity from .claude/coms-net-cc.local.md (+ fallbacks).
 *   2. Resolve hub URL + auth token. Bail with a clear MCP error if missing.
 *   3. Register agent with the hub. Write identity.json (includes hub_url so
 *      hooks can call /v1/messages/:id/response independently).
 *   4. Start heartbeat loop (HEARTBEAT_MS).
 *   5. Open SSE stream — wired in next iteration.
 *   6. Register 5 MCP tools (4 protocol + 1 status). Connect stdio transport.
 *   7. On SIGTERM/SIGINT, DELETE the agent and exit.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import * as fs from "node:fs";
import * as path from "node:path";

import { resolveIdentity } from "./identity.ts";
import {
	ensureStateDir,
	writeIdentity,
	readIdentity,
	writeInbox,
	listInbox,
	listInflight,
	appendErrorLog,
	readPulse,
	type InboxEntry,
} from "./state-store.ts";
import {
	HEARTBEAT_MS,
	HttpError,
	HubClient,
	SseConnection,
	resolveAuthToken,
	resolveServerUrl,
} from "./hub-client.ts";

const MAX_HOPS = Number(process.env.PI_COMS_NET_MAX_HOPS) || 5;
const DEFAULT_AWAIT_TIMEOUT_MS = Number(process.env.PI_COMS_NET_MESSAGE_TTL_MS) || 1_800_000;

const identity = resolveIdentity(process.cwd());
// identity.cwd is the project root (resolved via marketplace.json walk-up)
// — use it as the state-dir key so hooks find the same dir.
const stateDir = ensureStateDir(identity.cwd);

// Best-effort log file for the MCP server. Hooks log to errors.log separately.
function log(event: string, extra: Record<string, unknown> = {}): void {
	try {
		fs.appendFileSync(
			path.join(stateDir, "server.log"),
			`${new Date().toISOString()} ${event} ${JSON.stringify(extra)}\n`,
		);
	} catch {
		// best-effort
	}
}

const serverUrl = resolveServerUrl(identity.project);
const authToken = resolveAuthToken(identity.project);

let hub: HubClient | null = null;
let sse: SseConnection | null = null;
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
let shuttingDown = false;
let bootError: string | null = null;

// In-memory map for pending outbound replies. SSE response handler (next task)
// will resolve these. Until then, coms_net_get/await fall back to server polling.
interface PendingReply {
	resolve: (v: { response?: any; error?: string | null }) => void;
	promise: Promise<{ response?: any; error?: string | null }>;
	target_name?: string;
	target_session?: string;
	created_at: string;
	/** Set true when coms_net_await consumes the reply, so the auto-deliver
	 *  channel push is suppressed (avoids the LLM seeing the same reply twice
	 *  — once as a tool result, once as an inline <channel> turn). */
	consumedByAwait?: boolean;
}
const pendingReplies = new Map<string, PendingReply>();

if (!serverUrl) {
	bootError =
		`No coms-net hub URL configured for project "${identity.project}". ` +
		`Start the hub with: bun scripts/coms-net-server.ts (in the pi-vs-claude-code repo). ` +
		`Or set PI_COMS_NET_SERVER_URL.`;
	log("boot_failed", { reason: "no_server_url" });
} else if (!authToken) {
	bootError =
		`No coms-net auth token for project "${identity.project}". ` +
		`Set PI_COMS_NET_AUTH_TOKEN, or run a local hub which auto-writes ` +
		`~/.pi/coms-net/projects/${identity.project}/server.secret.json.`;
	log("boot_failed", { reason: "no_auth_token" });
} else {
	hub = new HubClient(serverUrl, authToken);
	try {
		await hub.healthCheck();
	} catch (err) {
		bootError = `coms-net hub health-check failed at ${serverUrl}: ${hub.safeError(err)}`;
		log("boot_failed", { reason: "health_failed", error: bootError });
		hub = null;
	}
}

if (hub) {
	// Orphan recovery: any inflight/<msg_id>.json present at boot means a
	// previous MCP server died mid-response. Submit error responses using the
	// PREVIOUS session_id (read from the old identity.json) so the hub
	// authorises the close. Then delete the inflight files.
	const oldIdentity = readIdentity<{ session_id?: string }>(stateDir);
	const inflightOrphans = listInflight(stateDir);
	if (inflightOrphans.length > 0 && oldIdentity?.session_id) {
		for (const filePath of inflightOrphans) {
			const msgId = path.basename(filePath, ".json");
			try {
				await hub.submitResponse(msgId, {
					project: identity.project,
					responder_session: oldIdentity.session_id,
					response: null,
					error: "responder restarted, response lost",
				});
				log("orphan_recovered", { msg_id: msgId });
			} catch (err) {
				if (!(err instanceof HttpError && err.status === 404)) {
					appendErrorLog(
						stateDir,
						`orphan recovery failed for ${msgId}: ${hub.safeError(err)}`,
					);
				}
			}
			try { fs.unlinkSync(filePath); } catch { /* ignore */ }
		}
	} else if (inflightOrphans.length > 0) {
		// No old identity to authorize — just drop and let peer await time out.
		for (const filePath of inflightOrphans) {
			appendErrorLog(stateDir, `orphan ${path.basename(filePath)} dropped (no prior session_id)`);
			try { fs.unlinkSync(filePath); } catch { /* ignore */ }
		}
	}

	try {
		const reg = await hub.register({
			project: identity.project,
			session_id: identity.session_id,
			name: identity.name,
			purpose: identity.purpose,
			model: identity.model,
			color: identity.color,
			cwd: identity.cwd,
			explicit: identity.explicit,
		});
		if (reg.agent.name !== identity.name) {
			log("name_collision", { desired: identity.name, assigned: reg.agent.name });
			identity.name = reg.agent.name;
		}
		log("registered", { session_id: identity.session_id, name: identity.name });

		// Persist identity (hooks read this).
		writeIdentity(stateDir, {
			...identity,
			hub_url: serverUrl,
			auth_token: authToken,
			sse_url: reg.sse_url,
			state_dir: stateDir,
			started_at: new Date().toISOString(),
			pid: process.pid,
		});

		// Open SSE stream — handles inbound prompts + outbound response resolution.
		sse = new SseConnection(
			{
				url: serverUrl + reg.sse_url,
				authToken: authToken!,
				onEvent: handleSseEvent,
				onConnect: () => log("sse_connected", {}),
				onDisconnect: (reason) => log("sse_disconnected", { reason }),
				shouldReconnect: () => !shuttingDown,
				reRegister: async () => {
					const r = await hub!.register({
						project: identity.project,
						session_id: identity.session_id,
						name: identity.name,
						purpose: identity.purpose,
						model: identity.model,
						color: identity.color,
						cwd: identity.cwd,
						explicit: identity.explicit,
					});
					return serverUrl + r.sse_url;
				},
			},
			(err) => hub!.safeError(err),
		);
		void sse.open();

		// Heartbeat loop.
		heartbeatTimer = setInterval(() => {
			if (shuttingDown || !hub) return;
			const queue_depth = listInbox(stateDir).length + listInflight(stateDir).length;
			hub.heartbeat(identity.session_id, {
				project: identity.project,
				context_used_pct: 0, // CC has no exposed signal; cosmetic only.
				queue_depth,
				model: identity.model,
				status: "online",
			}).catch((err) => log("heartbeat_failed", { error: hub!.safeError(err) }));
		}, HEARTBEAT_MS);
		try { (heartbeatTimer as any).unref?.(); } catch { /* ignore */ }
	} catch (err) {
		const e = err instanceof HttpError
			? `register failed (${err.status}): ${JSON.stringify(err.body)}`
			: `register failed: ${hub.safeError(err)}`;
		bootError = e;
		log("boot_failed", { reason: "register_failed", error: e });
		hub = null;
	}
}

// ━━ SSE event dispatch ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function handleSseEvent(event: string, data: any, _id?: string): void {
	if (!data || typeof data !== "object") return;
	switch (event) {
		case "hello":
			log("sse_hello", { server_id: data.server_id });
			return;
		case "pool_snapshot":
		case "agent_joined":
		case "agent_updated":
		case "agent_stale":
		case "agent_left":
		case "message_status":
		case "server_ping":
			// No-op in v1. Pi-side widgets care about these; CC doesn't render the pool.
			return;
		case "prompt":
			handleInboundPrompt(data);
			return;
		case "response":
			handleInboundResponse(data);
			return;
		case "error":
			log("sse_error", { code: data.code, message: data.message });
			return;
	}
}

function handleInboundPrompt(data: any): void {
	const msg_id: string | undefined = data?.msg_id;
	if (!msg_id || typeof msg_id !== "string") return;
	const sender = data.sender ?? {};
	const entry: InboxEntry = {
		msg_id,
		sender_session: typeof sender.session_id === "string" ? sender.session_id : "?",
		sender_name: typeof sender.name === "string" ? sender.name : "unknown",
		sender_cwd: typeof sender.cwd === "string" ? sender.cwd : "?",
		prompt: typeof data.prompt === "string" ? data.prompt : "",
		summary:
			typeof data.summary === "string" && data.summary.length > 0
				? data.summary.slice(0, 200)
				: null,
		sender_context_pct: typeof sender.context_pct === "number" ? sender.context_pct : undefined,
		sender_status: typeof sender.status === "string" ? sender.status : undefined,
		sender_observed_age_ms: typeof sender.observed_age_ms === "number" ? sender.observed_age_ms : undefined,
		hops: typeof data.hops === "number" ? data.hops : 0,
		response_schema:
			data.response_schema && typeof data.response_schema === "object"
				? data.response_schema
				: null,
		received_at: new Date().toISOString(),
	};
	try {
		writeInbox(stateDir, entry);
		log("prompt_in", { msg_id, sender: entry.sender_name, hops: entry.hops });
	} catch (err) {
		appendErrorLog(stateDir, `writeInbox failed for ${msg_id}: ${String(err)}`);
	}
	// Also try to push as a claude/channel notification for low-latency delivery.
	// Inbox remains the source of truth — Stop hook drains it on next turn
	// regardless of whether the channel push landed.
	pushChannel(entry).then((pushed) => {
		if (pushed) log("channel_pushed", { msg_id });
	});
}

function handleInboundResponse(data: any): void {
	const msg_id: string | undefined = data?.msg_id;
	if (!msg_id) return;
	const pending = pendingReplies.get(msg_id);
	const errVal: string | null = typeof data.error === "string" ? data.error : null;
	const responseVal = data.response;
	if (pending) {
		try { pending.resolve({ response: responseVal, error: errVal }); } catch { /* ignore */ }
		log("response_in", { msg_id, error: errVal });
	} else {
		log("orphan_response", { msg_id });
	}

	// Auto-deliver the reply as a claude/channel push so the LLM sees it
	// inline without an explicit coms_net_await. Suppress when:
	//   • the response is an error (no useful body to render), OR
	//   • coms_net_await has consumed (or will consume) the reply.
	// 150ms defer gives a racing await call time to flip the flag.
	if (errVal) return;
	if (pending?.consumedByAwait) return;
	const responderName =
		(data?.responder && typeof data.responder.name === "string")
			? data.responder.name
			: (pending?.target_name ?? "peer");
	const bodyText = typeof responseVal === "string"
		? responseVal
		: (responseVal != null ? JSON.stringify(responseVal, null, 2) : "");
	if (!bodyText) return;
	const responderState = data?.responder && typeof data.responder === "object"
		? {
			context_pct: typeof data.responder.context_pct === "number" ? data.responder.context_pct : undefined,
			status: typeof data.responder.status === "string" ? data.responder.status : undefined,
			observed_age_ms: typeof data.responder.observed_age_ms === "number" ? data.responder.observed_age_ms : undefined,
		}
		: undefined;
	setTimeout(() => {
		const stillPending = pendingReplies.get(msg_id);
		if (stillPending?.consumedByAwait) return;
		pushReplyChannel(msg_id, responderName, bodyText, responderState)
			.then((ok) => { if (ok) log("reply_pushed", { msg_id }); });
	}, 150);
}

// ━━ MCP server + tools ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

const server = new McpServer(
	{ name: "coms-net", version: "0.1.0" },
	{
		instructions:
			`You are CC peer "${identity.name}" on the coms-net hub (project "${identity.project}"). ` +
			`Inbound messages from other agents arrive as <channel source="coms-net" sender="..." msg_id="..." thread="..." summary="...">body</channel> events. ` +
			`React inline — write a normal assistant message, and the Stop hook auto-submits your final text back to the sender. ` +
			`DO NOT call coms_net_send to reply to channel messages (that creates a ping-pong loop). ` +
			`Use coms_net_send / coms_net_await only to INITIATE new outbound conversations.`,
	},
);

// Declare the experimental claude/channel capability so Claude Code opens
// the push channel for this MCP. Must be registered before connect().
server.server.registerCapabilities({
	experimental: { "claude/channel": {} },
});

// Gate channel emissions on notifications/initialized — per MCP spec, the
// server must not send notifications before the client signals initialized.
// Claude Code drops anything that arrives early (see droplet's
// respawn-channel-race-2026-05-14.md).
let mcpInitialized = false;
server.server.oninitialized = () => {
	mcpInitialized = true;
	log("mcp_initialized", {});
};

/**
 * Push an inbound prompt as a claude/channel notification. Falls back
 * silently if the channel isn't ready yet — the inbox file written by the
 * SSE handler is the second-tier delivery path (Stop hook will drain it).
 */
async function pushChannel(entry: InboxEntry): Promise<boolean> {
	if (!mcpInitialized) return false;
	try {
		const meta: Record<string, any> = {
			sender: entry.sender_name,
			thread: entry.sender_session,
			msg_id: entry.msg_id,
			summary: entry.summary ?? entry.prompt.slice(0, 200),
		};
		// Stamp sender peer-state on the channel meta so CC renders
		// <channel ... sender_context_pct="..." sender_status="..." ...>.
		// Receivers read raw values; threshold decisions are end-to-end.
		if (typeof entry.sender_context_pct === "number") meta.sender_context_pct = entry.sender_context_pct;
		if (typeof entry.sender_status === "string") meta.sender_status = entry.sender_status;
		if (typeof entry.sender_observed_age_ms === "number") meta.sender_observed_age_ms = entry.sender_observed_age_ms;
		await server.server.notification({
			method: "notifications/claude/channel",
			params: { content: entry.prompt, meta },
		});
		return true;
	} catch (err) {
		log("channel_push_failed", { msg_id: entry.msg_id, error: String(err) });
		return false;
	}
}

/**
 * Push a peer's reply (to a coms_net_send WE made) as a claude/channel event
 * so it appears inline in CC without requiring an explicit coms_net_await.
 * The reply body becomes the <channel> content; meta.reply_to carries the
 * original outbound msg_id so the LLM can distinguish replies from new
 * inbound prompts.
 */
async function pushReplyChannel(
	originalMsgId: string,
	senderName: string,
	body: string,
	responder?: { context_pct?: number; status?: string; observed_age_ms?: number },
): Promise<boolean> {
	if (!mcpInitialized) return false;
	try {
		const meta: Record<string, any> = {
			sender: senderName,
			reply_to: originalMsgId,
			msg_id: originalMsgId,
			summary: body.slice(0, 200),
		};
		// Responder peer-state — flagged in design synthesis as the highest-value
		// signal (sender learns whether the answerer was healthy).
		if (responder && typeof responder.context_pct === "number") meta.responder_context_pct = responder.context_pct;
		if (responder && typeof responder.status === "string") meta.responder_status = responder.status;
		if (responder && typeof responder.observed_age_ms === "number") meta.responder_observed_age_ms = responder.observed_age_ms;
		await server.server.notification({
			method: "notifications/claude/channel",
			params: { content: body, meta },
		});
		return true;
	} catch (err) {
		log("reply_push_failed", { msg_id: originalMsgId, error: String(err) });
		return false;
	}
}

function notReady(): { content: { type: "text"; text: string }[]; isError: true } {
	return {
		content: [{
			type: "text" as const,
			text: bootError ?? "coms-net: not initialised",
		}],
		isError: true,
	};
}

server.registerTool(
	"coms_net_list",
	{
		description:
			"List peer agents on the coms-net hub for the current project. " +
			"Returns names, models, and live context usage.",
		inputSchema: {
			project: z.string().optional(),
			include_explicit: z.boolean().optional(),
		},
	},
	async ({ project, include_explicit }) => {
		if (!hub) return notReady();
		const proj = project ?? identity.project;
		const list = await hub.listAgents(proj, include_explicit === true);
		const peers = list.agents.filter((a) => a.session_id !== identity.session_id);
		const lines = peers.length === 0
			? "No peer agents found."
			: peers.map((a) => {
				const dot = a.status === "online" ? "●" : a.status === "stale" ? "~" : "✗";
				const pct = typeof a.context_used_pct === "number" ? ` ${a.context_used_pct}%` : " ?%";
				return `${dot} ${a.name} (${a.model})${pct}${a.purpose ? ` — ${a.purpose}` : ""}`;
			}).join("\n");
		return {
			content: [{ type: "text", text: `${peers.length} peer(s):\n${lines}` }],
		};
	},
);

server.registerTool(
	"coms_net_send",
	{
		description:
			"INITIATE a new outbound message to a peer agent. Returns synchronously with a msg_id " +
			"once the server queues the prompt. Use coms_net_get/await with the msg_id to retrieve the reply.\n\n" +
			"DO NOT call this to REPLY to an inbound `<channel source=\"coms-net\" sender=\"<peer>\" msg_id=\"…\">` prompt — just write your answer as a " +
			"normal assistant message; the Stop hook auto-captures it and submits back to the caller. " +
			"Calling coms_net_send to reply creates a ping-pong loop.",
		inputSchema: {
			target: z.string().describe("Peer name (preferred) or session_id."),
			prompt: z.string().describe("The prompt to send."),
			summary: z.string().max(200).optional().describe(
				"Optional ≤200-char one-line summary the receiver renders in <channel summary=…>. " +
				"When omitted, receivers auto-slice the first 200 chars of `prompt`. " +
				"Write a real summary when `prompt` is long or its first 200 chars don't capture the intent.",
			),
			conversation_id: z.string().optional(),
			response_schema: z.any().optional(),
		},
	},
	async ({ target, prompt, summary, conversation_id, response_schema }) => {
		if (!hub) return notReady();
		const hops = 0; // CC doesn't track inbound-chain hops yet; v1 keeps it simple.
		if (hops >= MAX_HOPS) {
			return {
				content: [{ type: "text", text: `hop limit reached (${hops})` }],
				isError: true,
			};
		}
		try {
			const resp = await hub.sendMessage({
				project: identity.project,
				sender_session: identity.session_id,
				target,
				target_session: null,
				prompt,
				summary: typeof summary === "string" && summary.length > 0 ? summary.slice(0, 200) : null,
				conversation_id: conversation_id ?? null,
				response_schema: (response_schema as object | undefined) ?? null,
				hops,
			});
			// Park a pending entry. SSE response (next task) will resolve it.
			// Until SSE lands, coms_net_await falls back to server long-poll.
			let resolveFn!: (v: { response?: any; error?: string | null }) => void;
			const promise = new Promise<{ response?: any; error?: string | null }>((res) => {
				resolveFn = res;
			});
			pendingReplies.set(resp.msg_id, {
				resolve: resolveFn,
				promise,
				target_name: target,
				target_session: resp.target_session,
				created_at: new Date().toISOString(),
			});
			log("prompt_out", { msg_id: resp.msg_id, target });
			return {
				content: [{
					type: "text" as const,
					text:
						`coms_net_send → ${target}\nmsg_id ${resp.msg_id}\nstatus ${resp.status}` +
						(typeof resp.target_context_pct === "number"
							? `\ntarget_state ${resp.target_status ?? "?"} ctx=${resp.target_context_pct}% age=${resp.target_observed_age_ms ?? 0}ms`
							: ""),
				}],
			};
		} catch (err) {
			if (err instanceof HttpError) {
				const detail = (err.body && err.body.error) || err.message;
				return {
					content: [{ type: "text", text: `send failed (${err.status}): ${detail}` }],
					isError: true,
				};
			}
			return {
				content: [{ type: "text", text: `send failed: ${hub.safeError(err)}` }],
				isError: true,
			};
		}
	},
);

server.registerTool(
	"coms_net_get",
	{
		description:
			"Non-blocking poll of a reply to YOUR OWN coms_net_send. Returns status pending|complete|error " +
			"and (when complete) the response. Only use msg_ids returned by coms_net_send, never msg_ids from " +
			"inbound `<channel source=\"coms-net\" sender=\"<peer>\" msg_id=\"…\">` prompts — those belong to the peer.",
		inputSchema: { msg_id: z.string() },
	},
	async ({ msg_id }) => {
		if (!hub) return notReady();
		try {
			const resp = await hub.getMessage(msg_id);
			const status = resp?.status ?? "pending";
			const text = (status === "complete" || status === "error" || status === "timeout")
				? (resp.error
					? `coms_net_get: ${status} — ${resp.error}`
					: `coms_net_get: ${status}\n${typeof resp.response === "string"
						? resp.response
						: JSON.stringify(resp.response, null, 2)}`)
				: `coms_net_get: ${status}`;
			return { content: [{ type: "text", text }] };
		} catch (err) {
			if (err instanceof HttpError && err.status === 404) {
				return {
					content: [{ type: "text", text: `coms_net_get: unknown msg_id ${msg_id}` }],
					isError: true,
				};
			}
			return {
				content: [{ type: "text", text: `coms_net_get: error — ${hub.safeError(err)}` }],
				isError: true,
			};
		}
	},
);

server.registerTool(
	"coms_net_await",
	{
		description:
			"Block until the reply to YOUR OWN coms_net_send arrives, or timeout. Default timeout 30 min. " +
			"Same caveat as coms_net_get: only msg_ids from a coms_net_send call you just made.",
		inputSchema: {
			msg_id: z.string(),
			timeout_ms: z.number().optional(),
		},
	},
	async ({ msg_id, timeout_ms }) => {
		if (!hub) return notReady();
		const timeoutMs = typeof timeout_ms === "number" && timeout_ms > 0
			? timeout_ms
			: DEFAULT_AWAIT_TIMEOUT_MS;

		// Fast path: SSE-resolved.
		const pending = pendingReplies.get(msg_id);
		if (pending) {
			// Mark consumed so handleInboundResponse's deferred channel push
			// is suppressed (avoids double-delivery to the LLM).
			pending.consumedByAwait = true;
		}
		if (pending?.promise) {
			// Race local promise against server long-poll + timeout.
			const ac = new AbortController();
			const serverPromise = hub.awaitMessage(msg_id, timeoutMs, ac.signal)
				.then((d: any) => {
					if (d?.status === "complete") return { response: d.response, error: null };
					if (d?.status === "error") return { response: null, error: d.error ?? "error" };
					if (d?.status === "timeout") return { response: null, error: "timeout" };
					return { response: d?.response, error: d?.error ?? null };
				})
				.catch((err) => {
					if (err instanceof HttpError && err.status === 404) {
						return { response: null, error: "unknown msg_id" };
					}
					return { response: null, error: hub!.safeError(err) };
				});
			const timeoutPromise = new Promise<{ error: string }>((res) => {
				const t = setTimeout(() => res({ error: "timeout" }), timeoutMs);
				try { (t as any).unref?.(); } catch { /* ignore */ }
			});
			const winner = await Promise.race([pending.promise, serverPromise, timeoutPromise]);
			try { ac.abort(); } catch { /* ignore */ }
			if ((winner as any).error) {
				return {
					content: [{ type: "text", text: `coms_net_await: error — ${(winner as any).error}` }],
					isError: true,
				};
			}
			const resp = (winner as any).response;
			return {
				content: [{
					type: "text",
					text: typeof resp === "string" ? resp : JSON.stringify(resp, null, 2),
				}],
			};
		}

		// No pending entry — straight server long-poll.
		try {
			const data = await hub.awaitMessage(msg_id, timeoutMs);
			const status = data?.status ?? "timeout";
			if (status === "complete") {
				return {
					content: [{
						type: "text",
						text: typeof data.response === "string"
							? data.response
							: JSON.stringify(data.response, null, 2),
					}],
				};
			}
			return {
				content: [{ type: "text", text: `coms_net_await: ${status} — ${data?.error ?? ""}` }],
				isError: true,
			};
		} catch (err) {
			return {
				content: [{ type: "text", text: `coms_net_await: error — ${hub.safeError(err)}` }],
				isError: true,
			};
		}
	},
);

server.registerTool(
	"coms_net_status",
	{
		description:
			"Diagnostic: dump identity, hub URL, state-dir counts, and last Stop-hook pulse.",
		inputSchema: {},
	},
	async () => {
		const inbox = listInbox(stateDir).length;
		const inflight = listInflight(stateDir).length;
		const pulse = readPulse(stateDir);
		const peers = hub ? (await hub.listAgents(identity.project).catch(() => ({ agents: [] }))).agents : [];
		const peerCount = peers.filter((a) => a.session_id !== identity.session_id).length;
		return {
			content: [{
				type: "text",
				text:
					`identity: ${identity.name}@${identity.project} (${identity.session_id})\n` +
					`hub: ${serverUrl ?? "<unconfigured>"}\n` +
					`status: ${hub ? "connected" : "OFFLINE"}\n` +
					(bootError ? `boot_error: ${bootError}\n` : "") +
					`peers: ${peerCount}\n` +
					`inbox: ${inbox} pending\n` +
					`inflight: ${inflight} pending\n` +
					`last_stop_pulse: ${pulse?.last_stop_at ?? "<never>"}\n` +
					`state_dir: ${stateDir}\n`,
			}],
		};
	},
);

// ━━ Shutdown ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

async function shutdown(): Promise<void> {
	if (shuttingDown) return;
	shuttingDown = true;
	if (heartbeatTimer) {
		try { clearInterval(heartbeatTimer); } catch { /* ignore */ }
		heartbeatTimer = null;
	}
	if (sse) {
		try { sse.close(); } catch { /* ignore */ }
		sse = null;
	}
	if (hub) {
		try {
			await hub.deleteAgent(identity.session_id, identity.project);
			log("unregistered", {});
		} catch (err) {
			appendErrorLog(stateDir, `unregister failed: ${hub.safeError(err)}`);
		}
	}
}

process.on("SIGINT", () => { void shutdown().then(() => process.exit(0)); });
process.on("SIGTERM", () => { void shutdown().then(() => process.exit(0)); });
process.on("beforeExit", () => { void shutdown(); });

// ━━ Connect transport ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

const transport = new StdioServerTransport();
await server.connect(transport);
log("started", { state_dir: stateDir, peer_count: 0 });
