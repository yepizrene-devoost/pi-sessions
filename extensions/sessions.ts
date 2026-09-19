import {
  DynamicBorder,
  SessionManager,
  type ExtensionAPI,
  type ExtensionCommandContext,
  type SessionInfo,
} from "@earendil-works/pi-coding-agent";
import {
  Container,
  Key,
  type SelectItem,
  SelectList,
  Text,
  matchesKey,
} from "@earendil-works/pi-tui";

const MAX_LABEL = 56;
const MAX_SUBTITLE = 80;

type Picked =
  | { action: "resume"; path: string }
  | { action: "rename"; path: string };

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
  return date.toLocaleDateString();
}

function itemLabel(session: Pick<SessionInfo, "name" | "firstMessage" | "id">): string {
  const raw = session.name?.trim() || session.firstMessage?.trim() || session.id.slice(0, 8);
  return truncate(raw, MAX_LABEL);
}

function itemDescription(
  session: Pick<SessionInfo, "messageCount" | "modified" | "id" | "path" | "cwd">,
  currentFile: string | undefined,
  listAll: boolean,
): string {
  const parts = [
    `${session.messageCount} msg`,
    relativeTime(session.modified),
    session.id.slice(0, 8),
  ];
  if (session.path === currentFile) parts.push("current");
  if (listAll) parts.push(session.cwd);
  return parts.join(" · ");
}

function buildItems(
  sessions: SessionInfo[],
  currentFile: string | undefined,
  listAll: boolean,
): SelectItem[] {
  return sessions.map((session) => ({
    value: session.path,
    label: itemLabel(session),
    description: itemDescription(session, currentFile, listAll),
  }));
}

export default function sessionsExtension(pi: ExtensionAPI) {
  pi.registerCommand("sessions", {
    description: "List sessions for the current directory and resume or rename one",
    getArgumentCompletions: (prefix) => {
      const opts = ["--all"].filter((o) => o.startsWith(prefix));
      return opts.length > 0 ? opts.map((o) => ({ value: o, label: o })) : null;
    },
    async handler(args, ctx) {
      const trimmed = args.trim();
      const listAll = trimmed === "--all" || trimmed === "-a";

      let sessions;
      try {
        sessions = listAll ? await SessionManager.listAll() : await SessionManager.list(ctx.cwd);
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

      const sorted = [...sessions].sort((a, b) => b.modified.getTime() - a.modified.getTime());
      const currentFile = ctx.sessionManager.getSessionFile();

      for (;;) {
        const picked =
          ctx.mode === "tui"
            ? await pickModal(ctx, sorted, currentFile, listAll)
            : await pickFallback(ctx, sorted, currentFile, listAll);

        if (!picked) return;

        if (picked.action === "rename") {
          const session = sorted.find((s) => s.path === picked.path);
          const newName = await ctx.ui.input("Rename session", session?.name?.trim() ?? "");
          if (newName === undefined) continue; // input cancelled -> back to picker

          const cleaned = newName.replace(/[\r\n]+/g, " ").trim();
          try {
            renameSession(ctx, picked.path, cleaned);
          } catch (error) {
            ctx.ui.notify(
              `Rename failed: ${error instanceof Error ? error.message : String(error)}`,
              "error",
            );
            continue;
          }
          if (session) session.name = cleaned || undefined;
          ctx.ui.notify(cleaned ? `Renamed to "${cleaned}"` : "Session name cleared", "info");
          continue;
        }

        // resume
        const session = sorted.find((s) => s.path === picked.path);
        if (!session) return;

        if (session.path === currentFile) {
          ctx.ui.notify("Already in this session.", "info");
          return;
        }

        const ok = await ctx.ui.confirm(
          `Resume "${itemLabel(session)}"?`,
          `${session.path}\n\nSwitching suspends the current session and resumes the selected one.`,
        );
        if (!ok) return;

        const result = await ctx.switchSession(session.path, {
          withSession: async (newCtx) => {
            newCtx.ui.notify("Session resumed.", "info");
          },
        });
        if (result.cancelled) ctx.ui.notify("Switch cancelled.", "info");
        return;
      }
    },
  });
}

function renameSession(ctx: ExtensionCommandContext, path: string, name: string): void {
  if (path === ctx.sessionManager.getSessionFile()) {
    ctx.sessionManager.appendSessionInfo(name);
    return;
  }
  const manager = SessionManager.open(path);
  manager.appendSessionInfo(name);
}

async function pickModal(
  ctx: ExtensionCommandContext,
  sessions: SessionInfo[],
  currentFile: string | undefined,
  listAll: boolean,
): Promise<Picked | null> {
  return ctx.ui.custom<Picked | null>(
    (tui, theme, _keybindings, done) => {
      const items = buildItems(sessions, currentFile, listAll);
      const title = listAll ? "All sessions" : "Sessions";
      const subtitle = listAll ? "Across every project" : truncate(ctx.cwd, MAX_SUBTITLE);

      const container = new Container();
      container.addChild(new DynamicBorder((s) => theme.fg("accent", s)));
      container.addChild(new Text(theme.fg("accent", theme.bold(title)), 1, 0));
      container.addChild(new Text(theme.fg("dim", subtitle), 1, 0));

      const selectList = new SelectList(items, Math.min(items.length, 12), {
        selectedPrefix: (t) => theme.fg("accent", t),
        selectedText: (t) => theme.fg("accent", t),
        description: (t) => theme.fg("muted", t),
        scrollInfo: (t) => theme.fg("dim", t),
        noMatch: (t) => theme.fg("warning", t),
      });
      selectList.onSelect = (item) => done({ action: "resume", path: item.value });
      selectList.onCancel = () => done(null);
      container.addChild(selectList);

      container.addChild(
        new Text(theme.fg("dim", "↑↓ navigate · enter resume · ctrl+r rename · esc cancel"), 1, 0),
      );
      container.addChild(new DynamicBorder((s) => theme.fg("accent", s)));

      return {
        render: (width) => container.render(width),
        invalidate: () => container.invalidate(),
        handleInput: (data) => {
          if (matchesKey(data, Key.ctrl("r"))) {
            const item = selectList.getSelectedItem();
            if (item) done({ action: "rename", path: item.value });
            return;
          }
          selectList.handleInput(data);
          tui.requestRender();
        },
      };
    },
    {
      overlay: true,
      overlayOptions: { anchor: "center", width: "85%", minWidth: 50, maxHeight: "85%", margin: 2 },
    },
  );
}

async function pickFallback(
  ctx: ExtensionCommandContext,
  sessions: SessionInfo[],
  currentFile: string | undefined,
  listAll: boolean,
): Promise<Picked | null> {
  const items = sessions.map(
    (s) => `${itemLabel(s)}  ·  ${itemDescription(s, currentFile, listAll)}`,
  );
  const title = listAll ? "All sessions" : `Sessions · ${truncate(ctx.cwd, MAX_SUBTITLE)}`;
  const selected = await ctx.ui.select(title, items);
  if (!selected) return null;

  const index = items.indexOf(selected);
  const session = index >= 0 ? sessions[index] : undefined;
  if (!session) return null;
  return { action: "resume", path: session.path };
}
