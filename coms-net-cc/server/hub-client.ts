/**
 * hub-client — HTTP + SSE client for the coms-net hub.
 *
 * Ported (with light edits) from extensions/coms-net.ts. The wire protocol is
 * identical, so any Pi peer sees this CC peer as just another agent.
 *
 * Responsibilities:
 *   - Resolve server URL + auth token from CLI flags > env > server.json /
 *     server.secret.json.
 *   - HTTP fetch wrapper with bearer auth, timeouts, and token-redacted errors.
 *   - Register the agent, heartbeat every HEARTBEAT_MS, DELETE on shutdown.
 *   - Open SSE stream with reconnect+backoff. Caller supplies an event handler.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

const COMS_NET_DIR = path.join(os.homedir(), ".pi", "coms-net");
export const HEARTBEAT_MS = Number(process.env.PI_COMS_NET_HEARTBEAT_MS) || 10_000;
const HTTP_TIMEOUT_MS = 10_000;
const RECONNECT_BASE_MS = 500;
const RECONNECT_MAX_MS = 10_000;

export class HttpError extends Error {
	status: number;
	body: any;
	constructor(status: number, body: any, message?: string) {
		super(message ?? `HTTP ${status}`);
		this.status = status;
		this.body = body;
	}
}

interface ServerJson {
	version: number;
	project: string;
	local_url: string;
	public_url?: string;
}

interface ServerSecretJson {
	token: string;
}

function readServerJson(project: string): ServerJson | null {
	const p = path.join(COMS_NET_DIR, "projects", project, "server.json");
	try {
		if (!fs.existsSync(p)) return null;
		const raw = fs.readFileSync(p, "utf-8");
		const parsed = JSON.parse(raw) as ServerJson;
		if (!parsed || typeof parsed.local_url !== "string") return null;
		return parsed;
	} catch {
		return null;
	}
}

function readServerSecret(project: string): ServerSecretJson | null {
	const p = path.join(COMS_NET_DIR, "projects", project, "server.secret.json");
	try {
		if (!fs.existsSync(p)) return null;
		const st = fs.statSync(p);
		const mode = st.mode & 0o777;
		if (mode !== 0o600) return null;
		const raw = fs.readFileSync(p, "utf-8");
		const parsed = JSON.parse(raw) as ServerSecretJson;
		if (!parsed || typeof parsed.token !== "string" || parsed.token.length === 0) return null;
		return parsed;
	} catch {
		return null;
	}
}

export function resolveServerUrl(project: string): string | null {
	const env = process.env.PI_COMS_NET_SERVER_URL;
	if (env && env.length > 0) return env.replace(/\/+$/, "");
	const sj = readServerJson(project);
	if (sj && sj.local_url) return sj.local_url.replace(/\/+$/, "");
	return null;
}

export function resolveAuthToken(project: string): string | null {
	const env = process.env.PI_COMS_NET_AUTH_TOKEN;
	if (env && env.length > 0) return env;
	const sec = readServerSecret(project);
	if (sec) return sec.token;
	return null;
}

export interface RegisterRequest {
	project: string;
	session_id: string;
	name: string;
	purpose: string;
	model: string;
	color: string;
	cwd: string;
	explicit: boolean;
}

export interface AgentCard {
	session_id: string;
	name: string;
	purpose: string;
	model: string;
	color: string;
	cwd: string;
	project: string;
	explicit: boolean;
	started_at: string;
	context_used_pct: number;
	queue_depth: number;
	status: "online" | "stale" | "offline";
}

export interface RegisterResponse {
	ok: true;
	agent: AgentCard;
	heartbeat_interval_ms: number;
	sse_url: string;
}

export interface HeartbeatRequest {
	project: string;
	context_used_pct: number;
	queue_depth: number;
	model?: string;
	status?: "online" | "stale" | "offline";
}

export interface SendRequest {
	project: string;
	sender_session: string;
	target: string;
	target_session: string | null;
	prompt: string;
	summary?: string | null;
	conversation_id: string | null;
	response_schema: object | null;
	hops: number;
}

export interface SendResponse {
	ok: true;
	msg_id: string;
	status: "queued" | "delivered" | "complete" | "error" | "timeout";
	target_session: string;
	target_context_pct?: number;
	target_status?: "online" | "stale" | "offline";
	target_observed_age_ms?: number;
}

export interface ResponseSubmitRequest {
	project: string;
	responder_session: string;
	response: any;
	error: string | null;
}

export class HubClient {
	readonly serverUrl: string;
	readonly authToken: string;

	constructor(serverUrl: string, authToken: string) {
		this.serverUrl = serverUrl.replace(/\/+$/, "");
		this.authToken = authToken;
	}

	safeError(err: unknown): string {
		const msg = err instanceof Error ? err.message : String(err);
		if (!this.authToken) return msg;
		return msg.split(this.authToken).join("<redacted>");
	}

	async fetch(
		method: string,
		urlPath: string,
		body?: unknown,
		opts?: { timeoutMs?: number; signal?: AbortSignal },
	): Promise<any> {
		const url = this.serverUrl + urlPath;
		const headers: Record<string, string> = {
			Authorization: `Bearer ${this.authToken}`,
			Accept: "application/json",
		};
		const init: RequestInit = { method, headers };
		if (body !== undefined) {
			headers["Content-Type"] = "application/json";
			(init as any).body = JSON.stringify(body);
		}
		let timer: ReturnType<typeof setTimeout> | null = null;
		const ac = new AbortController();
		const timeoutMs = opts?.timeoutMs ?? HTTP_TIMEOUT_MS;
		if (opts?.signal) {
			init.signal = opts.signal;
		} else {
			init.signal = ac.signal;
			timer = setTimeout(() => { try { ac.abort(); } catch { /* ignore */ } }, timeoutMs);
			try { (timer as any).unref?.(); } catch { /* ignore */ }
		}
		let resp: Response;
		try {
			resp = await fetch(url, init);
		} catch (err: any) {
			if (timer) try { clearTimeout(timer); } catch { /* ignore */ }
			throw new Error(`coms-net: fetch failed: ${this.safeError(err)}`);
		}
		if (timer) try { clearTimeout(timer); } catch { /* ignore */ }
		const text = await resp.text();
		let parsed: any = null;
		if (text.length > 0) {
			try { parsed = JSON.parse(text); } catch { parsed = text; }
		}
		if (!resp.ok) {
			throw new HttpError(resp.status, parsed, `HTTP ${resp.status} ${method} ${urlPath}`);
		}
		return parsed;
	}

	register(req: RegisterRequest): Promise<RegisterResponse> {
		return this.fetch("POST", "/v1/agents/register", req) as Promise<RegisterResponse>;
	}

	heartbeat(session_id: string, req: HeartbeatRequest): Promise<any> {
		return this.fetch(
			"POST",
			`/v1/agents/${encodeURIComponent(session_id)}/heartbeat`,
			req,
			{ timeoutMs: 5_000 },
		);
	}

	deleteAgent(session_id: string, project: string): Promise<any> {
		return this.fetch(
			"DELETE",
			`/v1/agents/${encodeURIComponent(session_id)}?project=${encodeURIComponent(project)}`,
			undefined,
			{ timeoutMs: 2_000 },
		);
	}

	listAgents(project: string, includeExplicit = false): Promise<{ agents: AgentCard[] }> {
		const qs = `?project=${encodeURIComponent(project)}&include_explicit=${includeExplicit ? "true" : "false"}`;
		return this.fetch("GET", `/v1/agents${qs}`) as Promise<{ agents: AgentCard[] }>;
	}

	sendMessage(req: SendRequest): Promise<SendResponse> {
		return this.fetch("POST", "/v1/messages", req) as Promise<SendResponse>;
	}

	submitResponse(msg_id: string, req: ResponseSubmitRequest): Promise<any> {
		return this.fetch(
			"POST",
			`/v1/messages/${encodeURIComponent(msg_id)}/response`,
			req,
		);
	}

	getMessage(msg_id: string): Promise<any> {
		return this.fetch("GET", `/v1/messages/${encodeURIComponent(msg_id)}`);
	}

	awaitMessage(msg_id: string, timeoutMs: number, signal?: AbortSignal): Promise<any> {
		return this.fetch(
			"GET",
			`/v1/messages/${encodeURIComponent(msg_id)}/await?timeout_ms=${timeoutMs}`,
			undefined,
			{ timeoutMs: timeoutMs + 5_000, signal },
		);
	}

	healthCheck(): Promise<any> {
		return this.fetch("GET", "/health");
	}
}

// ━━ SSE parser (hand-rolled, no dep) ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

export type SseEventHandler = (event: string, data: any, id?: string) => void;

export function makeSseParser(onEvent: SseEventHandler) {
	const decoder = new TextDecoder("utf-8");
	let buf = "";
	return {
		feed(chunk: Uint8Array): void {
			buf += decoder.decode(chunk, { stream: true });
			let idx;
			while ((idx = buf.indexOf("\n\n")) >= 0) {
				const frame = buf.slice(0, idx);
				buf = buf.slice(idx + 2);
				let event = "message";
				const dataLines: string[] = [];
				let id: string | undefined;
				for (const line of frame.split("\n")) {
					if (line.length === 0) continue;
					if (line.startsWith(":")) continue;
					if (line.startsWith("event:")) {
						event = line.slice(6).trimStart();
					} else if (line.startsWith("data:")) {
						let v = line.slice(5);
						if (v.startsWith(" ")) v = v.slice(1);
						dataLines.push(v);
					} else if (line.startsWith("id:")) {
						id = line.slice(3).trimStart();
					}
				}
				if (dataLines.length > 0) {
					const joined = dataLines.join("\n");
					let data: any = joined;
					try { data = JSON.parse(joined); } catch { /* keep as string */ }
					try { onEvent(event, data, id); } catch { /* ignore handler errors */ }
				}
			}
		},
	};
}

// ━━ SSE connection with reconnect/backoff ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

export interface SseConnectOptions {
	url: string;
	authToken: string;
	onEvent: SseEventHandler;
	onConnect?: () => void;
	onDisconnect?: (reason: string) => void;
	shouldReconnect: () => boolean;
	reRegister: () => Promise<string>;
}

export class SseConnection {
	private abort: AbortController | null = null;
	private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
	private reconnectAttempts = 0;
	private opts: SseConnectOptions;
	private currentUrl: string;
	private safeError: (e: unknown) => string;

	constructor(opts: SseConnectOptions, safeError: (e: unknown) => string) {
		this.opts = opts;
		this.currentUrl = opts.url;
		this.safeError = safeError;
	}

	updateUrl(url: string): void {
		this.currentUrl = url;
	}

	async open(): Promise<void> {
		if (this.abort) {
			try { this.abort.abort(); } catch { /* ignore */ }
		}
		const ac = new AbortController();
		this.abort = ac;
		const headers: Record<string, string> = {
			Authorization: `Bearer ${this.opts.authToken}`,
			Accept: "text/event-stream",
		};
		let resp: Response;
		try {
			resp = await fetch(this.currentUrl, { method: "GET", headers, signal: ac.signal });
		} catch (err: any) {
			this.opts.onDisconnect?.(`connect_failed: ${this.safeError(err)}`);
			this.scheduleReconnect();
			return;
		}
		if (!resp.ok || !resp.body) {
			this.opts.onDisconnect?.(`http_${resp.status}`);
			this.scheduleReconnect();
			return;
		}
		this.reconnectAttempts = 0;
		this.opts.onConnect?.();

		const parser = makeSseParser(this.opts.onEvent);
		const reader = resp.body.getReader();
		try {
			while (true) {
				const { done, value } = await reader.read();
				if (done) break;
				if (value) parser.feed(value);
			}
			this.opts.onDisconnect?.("stream_end");
		} catch (err: any) {
			if (ac.signal.aborted) {
				this.opts.onDisconnect?.("aborted");
				return;
			}
			this.opts.onDisconnect?.(this.safeError(err));
		} finally {
			try { reader.releaseLock(); } catch { /* ignore */ }
		}
		if (this.opts.shouldReconnect()) this.scheduleReconnect();
	}

	private scheduleReconnect(): void {
		if (!this.opts.shouldReconnect()) return;
		if (this.reconnectTimer) return;
		const backoff = Math.min(
			RECONNECT_BASE_MS * Math.pow(2, this.reconnectAttempts),
			RECONNECT_MAX_MS,
		);
		this.reconnectAttempts++;
		this.reconnectTimer = setTimeout(async () => {
			this.reconnectTimer = null;
			if (!this.opts.shouldReconnect()) return;
			try {
				const newUrl = await this.opts.reRegister();
				this.currentUrl = newUrl;
				void this.open();
			} catch (err) {
				this.opts.onDisconnect?.(`reregister_failed: ${this.safeError(err)}`);
				this.scheduleReconnect();
			}
		}, backoff);
		try { (this.reconnectTimer as any).unref?.(); } catch { /* ignore */ }
	}

	close(): void {
		if (this.reconnectTimer) {
			try { clearTimeout(this.reconnectTimer); } catch { /* ignore */ }
			this.reconnectTimer = null;
		}
		if (this.abort) {
			try { this.abort.abort(); } catch { /* ignore */ }
			this.abort = null;
		}
	}
}
