import { SessionManager, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * /sessions extension
 *
 * Lists the Pi sessions associated with the current working directory and lets
 * the user pick one to resume from the interactive UI (without touching
 * ~/.pi/agent/sessions/ by hand).
 */

const MAX_LABEL_LENGTH = 48;

function truncate(text: string, max: number): string {
	const clean = text.replace(/\s+/g, " ").trim();
	if (clean.length <= max) return clean;
	return clean.slice(0, max - 1) + "…";
}

function relativeTime(date: Date): string {
	const diffMs = Date.now() - date.getTime();
	if (diffMs < 60_000) return "just now";
	const minutes = Math.floor(diffMs / 60_000);
	if (minutes < 60) return `${minutes} min ago`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours} h ago`;
	const days = Math.floor(hours / 24);
	if (days < 30) return `${days} d ago`;
	const months = Math.floor(days / 30);
	if (months < 12) return `${months} mo ago`;
	const years = Math.floor(months / 12);
	return `${years} y ago`;
}

export default function sessionsExtension(pi: ExtensionAPI) {
	pi.registerCommand("sessions", {
		description: "List sessions for the current directory and resume one",
		async handler(_args, ctx) {
			const currentFile = ctx.sessionManager.getSessionFile();

			let sessions;
			try {
				sessions = await SessionManager.list(ctx.cwd);
			} catch (error) {
				ctx.ui.notify(
					`Failed to list sessions: ${error instanceof Error ? error.message : String(error)}`,
					"error",
				);
				return;
			}

			if (sessions.length === 0) {
				ctx.ui.notify(`No sessions found for ${ctx.cwd}`, "info");
				return;
			}

			// Most recently modified first.
			const sorted = [...sessions].sort(
				(a, b) => b.modified.getTime() - a.modified.getTime(),
			);

			const items = sorted.map((session) => {
				const label = session.name?.trim() || session.firstMessage?.trim();
				const fallback = session.id.slice(0, 8);
				const name = truncate(label || fallback, MAX_LABEL_LENGTH);
				const current = session.path === currentFile ? " · current" : "";
				return `${name} · ${session.messageCount} msg · ${relativeTime(session.modified)} · ${session.id.slice(0, 8)}${current}`;
			});

			const selected = await ctx.ui.select("Sessions — pick one to resume", items);
			if (!selected) return;

			const index = items.indexOf(selected);
			const session = index >= 0 ? sorted[index] : undefined;
			if (!session) return;

			if (session.path === currentFile) {
				ctx.ui.notify("Already in this session.", "info");
				return;
			}

			const title =
				session.name?.trim() || truncate(session.firstMessage || session.id, MAX_LABEL_LENGTH);
			const ok = await ctx.ui.confirm(
				`Resume "${title}"?`,
				`${session.path}\n\nSwitching suspends the current session and resumes the selected one.`,
			);
			if (!ok) return;

			const result = await ctx.switchSession(session.path, {
				withSession: async (newCtx) => {
					newCtx.ui.notify("Session resumed.", "info");
				},
			});

			if (result.cancelled) {
				ctx.ui.notify("Switch cancelled.", "info");
			}
		},
	});
}
