/**
 * identity — resolve {name, purpose, color, project, explicit} for this CC
 * session in the coms-net pool.
 *
 * Sources, in precedence order:
 *   1. .claude/coms-net-cc.local.md frontmatter (project-local)
 *   2. ~/.claude/coms-net-cc.local.md frontmatter (user-global)
 *   3. Env vars PI_COMS_NET_{NAME,PURPOSE,COLOR,PROJECT,EXPLICIT}
 *   4. Deterministic defaults from session_id
 *
 * Helpers (ulid, color palette, frontmatter parser, hex validation) are
 * verbatim ports of the equivalents in extensions/coms-net.ts.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

const FALLBACK_PALETTE = [
	"#72F1B8", "#36F9F6", "#FF7EDB", "#FEDE5D",
	"#C792EA", "#FF8B39", "#4D9DE0", "#FFAA8B",
];

export function ulid(): string {
	const time = Date.now();
	const rand = crypto.randomBytes(10);
	let timeStr = "";
	let t = time;
	for (let i = 9; i >= 0; i--) {
		timeStr = CROCKFORD[t % 32] + timeStr;
		t = Math.floor(t / 32);
	}
	let randStr = "";
	let bits = 0;
	let value = 0;
	for (const byte of rand) {
		value = (value << 8) | byte;
		bits += 8;
		while (bits >= 5) {
			bits -= 5;
			randStr += CROCKFORD[(value >> bits) & 31];
		}
	}
	return (timeStr + randStr).slice(0, 26);
}

export function isValidHex(hex: string): boolean {
	return /^#[0-9a-fA-F]{6}$/.test(hex);
}

export function fallbackColor(sessionId: string): string {
	const h = crypto.createHash("sha256").update(sessionId).digest("hex").slice(0, 8);
	return FALLBACK_PALETTE[Number(BigInt("0x" + h)) % FALLBACK_PALETTE.length];
}

function parseFrontmatter(raw: string): Record<string, string> {
	const match = raw.match(/^---\n([\s\S]*?)\n---\n?/);
	if (!match) return {};
	const fm: Record<string, string> = {};
	for (const line of match[1].split("\n")) {
		const idx = line.indexOf(":");
		if (idx <= 0) continue;
		const key = line.slice(0, idx).trim();
		let val = line.slice(idx + 1).trim();
		if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
			val = val.slice(1, -1);
		}
		fm[key] = val;
	}
	return fm;
}

function readFrontmatterFile(filePath: string): Record<string, string> {
	try {
		if (!fs.existsSync(filePath)) return {};
		return parseFrontmatter(fs.readFileSync(filePath, "utf-8"));
	} catch {
		return {};
	}
}

export interface Identity {
	session_id: string;
	name: string;
	purpose: string;
	color: string;
	project: string;
	explicit: boolean;
	cwd: string;
	model: string;
}

/**
 * Find the project root by walking up from this file's location until we hit
 * `.claude-plugin/marketplace.json` (the marker for our pi-vs-cc marketplace).
 * Falls back to the supplied cwd if nothing is found within 6 levels.
 *
 * Necessary because when the MCP server is spawned via the fakechat plugin
 * substitution, process.cwd() ends up being fakechat's directory — not the
 * repo where the user's project-local .claude/coms-net-cc.local.md lives.
 * import.meta.url always points to THIS file inside the plugin tree, so it
 * gives us a stable anchor.
 */
function findProjectRoot(fallbackCwd: string): string {
	let dir: string;
	try { dir = path.dirname(fileURLToPath(import.meta.url)); }
	catch { return fallbackCwd; }
	for (let i = 0; i < 6; i++) {
		const marker = path.join(dir, ".claude-plugin", "marketplace.json");
		if (fs.existsSync(marker)) return dir;
		const parent = path.dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	return fallbackCwd;
}

export function resolveIdentity(cwd: string): Identity {
	const projectRoot = findProjectRoot(cwd);
	const projectFm = readFrontmatterFile(path.join(projectRoot, ".claude", "coms-net-cc.local.md"));
	const globalFm = readFrontmatterFile(path.join(os.homedir(), ".claude", "coms-net-cc.local.md"));
	const env = process.env;

	const session_id = ulid();
	const defaultName = `claude-${session_id.slice(-6).toLowerCase()}`;
	const name =
		projectFm.name ||
		globalFm.name ||
		env.PI_COMS_NET_NAME ||
		defaultName;
	const purpose =
		projectFm.purpose ||
		globalFm.purpose ||
		env.PI_COMS_NET_PURPOSE ||
		"Claude Code peer";
	const project =
		projectFm.project ||
		globalFm.project ||
		env.PI_COMS_NET_PROJECT ||
		"default";
	const explicit =
		(projectFm.explicit ?? globalFm.explicit ?? env.PI_COMS_NET_EXPLICIT ?? "false")
			.toString()
			.toLowerCase() === "true";

	let color = fallbackColor(session_id);
	for (const candidate of [globalFm.color, projectFm.color, env.PI_COMS_NET_COLOR]) {
		if (candidate && isValidHex(candidate)) color = candidate;
	}

	return {
		session_id,
		name,
		purpose,
		color,
		project,
		explicit,
		// Use projectRoot (not the raw cwd) so the state dir keys match the
		// `cwd` field CC's hooks receive (always the user's project root).
		cwd: projectRoot,
		model: "claude-code",
	};
}
