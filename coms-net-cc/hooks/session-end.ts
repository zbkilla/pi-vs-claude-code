/**
 * SessionEnd hook — safety net to DELETE this CC session's agent from the
 * coms-net hub if the MCP server didn't get a clean shutdown.
 *
 * Idempotent with the MCP server's own SIGTERM handler: whichever fires first
 * wins; the other gets HTTP 404 from the hub and exits 0.
 */

import {
	stateDirFor,
	readIdentity,
	appendErrorLog,
} from "../server/state-store.ts";

interface StopHookInput {
	session_id?: string;
	cwd?: string;
}

interface Identity {
	session_id: string;
	name: string;
	project: string;
	hub_url: string;
	auth_token: string;
}

async function readStdin(): Promise<string> {
	const chunks: Buffer[] = [];
	for await (const chunk of process.stdin) {
		chunks.push(chunk as Buffer);
	}
	return Buffer.concat(chunks).toString("utf-8");
}

async function main(): Promise<void> {
	const stdin = await readStdin();
	let input: StopHookInput;
	try { input = JSON.parse(stdin); } catch { process.exit(0); }
	const cwd = input.cwd || process.cwd();
	const stateDir = stateDirFor(cwd);
	const identity = readIdentity<Identity>(stateDir);
	if (!identity?.hub_url || !identity.auth_token || !identity.session_id) {
		process.exit(0);
	}

	const url =
		identity.hub_url.replace(/\/+$/, "") +
		`/v1/agents/${encodeURIComponent(identity.session_id)}` +
		`?project=${encodeURIComponent(identity.project)}`;

	const ac = new AbortController();
	const t = setTimeout(() => { try { ac.abort(); } catch { /* ignore */ } }, 2_000);
	try { (t as any).unref?.(); } catch { /* ignore */ }
	try {
		await fetch(url, {
			method: "DELETE",
			headers: { Authorization: `Bearer ${identity.auth_token}` },
			signal: ac.signal,
		});
	} catch (err: any) {
		// 404 just means the MCP server already DELETEd us. Anything else is logged.
		appendErrorLog(stateDir, `session-end DELETE failed: ${err?.message ?? String(err)}`);
	} finally {
		try { clearTimeout(t); } catch { /* ignore */ }
	}
	process.exit(0);
}

main().catch(() => process.exit(0));
