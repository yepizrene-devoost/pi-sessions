import {
  SessionManager,
  type ExtensionAPI,
  type ExtensionCommandContext,
  type SessionInfo,
} from "@earendil-works/pi-coding-agent";
import {
  Input,
  Key,
  type SelectItem,
  SelectList,
  Text,
  matchesKey,
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";

const MAX_LABEL = 56;
const MAX_SUBTITLE = 80;

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

// Wrap rendered content lines in a full box with all four borders.
function frameLines(lines: readonly string[], width: number): string[] {
  const inner = Math.max(1, width - 4); // space between the side borders (1+1 padding, 1+1 borders)
  const top = "┌" + "─".repeat(Math.max(0, width - 2)) + "┐";
  const bottom = "└" + "─".repeat(Math.max(0, width - 2)) + "┘";
  const body = lines.map((line) => {
    const txt = truncateToWidth(line, inner, "");
    const pad = Math.max(0, inner - visibleWidth(txt));
    return "│ " + txt + " ".repeat(pad) + " │";
  });
  return [top, ...body, bottom];
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

      const pickedPath =
        ctx.mode === "tui"
          ? await pickModal(ctx, sorted, currentFile, listAll)
          : await pickFallback(ctx, sorted, currentFile, listAll);

      if (!pickedPath) return;

      const session = sorted.find((s) => s.path === pickedPath);
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

// A small modal overlay with a text input, stacked on top of the picker.
async function renameDialog(
  ctx: ExtensionCommandContext,
  initialName: string,
): Promise<string | undefined> {
  return ctx.ui.custom<string | undefined>(
    (tui, theme, _keybindings, done) => {
      const input = new Input({ prompt: "› " });
      input.setValue(initialName);
      input.onSubmit = (value) => done(value);
      input.onEscape = () => done(undefined);

      let focused = false;
      return {
        get focused() {
          return focused;
        },
        set focused(value: boolean) {
          focused = value;
          input.focused = value;
        },
        render: (width: number) => {
          const inner = Math.max(1, width - 4);
          const block = [
            theme.fg("accent", theme.bold("Rename session")),
            "",
            ...input.render(inner),
            "",
            theme.fg("dim", "enter submit · esc cancel"),
          ];
          return frameLines(block, width);
        },
        invalidate: () => input.invalidate(),
        handleInput: (data: string) => {
          if (matchesKey(data, Key.ctrl("c"))) {
            done(undefined);
            return;
          }
          input.handleInput(data);
          tui.requestRender();
        },
      };
    },
    {
      overlay: true,
      overlayOptions: { anchor: "center", width: 66, minWidth: 48, margin: 2 },
    },
  );
}

async function pickModal(
  ctx: ExtensionCommandContext,
  sessions: SessionInfo[],
  currentFile: string | undefined,
  listAll: boolean,
): Promise<string | null> {
  return ctx.ui.custom<string | null>(
    (tui, theme, _keybindings, done) => {
      const title = listAll ? "All sessions" : "Sessions";
      const subtitle = listAll ? "Across every project" : truncate(ctx.cwd, MAX_SUBTITLE);

      const titleText = new Text(theme.fg("accent", theme.bold(title)), 1, 0);
      const subtitleText = new Text(theme.fg("dim", subtitle), 1, 0);
      const helpText = new Text(
        theme.fg("dim", "↑↓ navigate · enter resume · ctrl+r rename · esc cancel"),
        1,
        0,
      );

      const maxBody = 14;
      const minBody = 6;
      let selectedPath: string | undefined;

      const makeList = (): SelectList => {
        const items = buildItems(sessions, currentFile, listAll);
        const list = new SelectList(
          items,
          maxBody,
          {
            selectedPrefix: (t) => theme.fg("accent", t),
            selectedText: (t) => theme.fg("accent", t),
            description: (t) => theme.fg("muted", t),
            scrollInfo: (t) => theme.fg("dim", t),
            noMatch: (t) => theme.fg("warning", t),
          },
          { maxPrimaryColumnWidth: 44 },
        );
        list.onSelect = (item) => done(item.value);
        list.onCancel = () => done(null);
        list.onSelectionChange = (item) => {
          selectedPath = item.value;
        };
        if (selectedPath) {
          const index = items.findIndex((item) => item.value === selectedPath);
          if (index >= 0) list.setSelectedIndex(index);
        }
        return list;
      };

      let selectList = makeList();

      const openRename = (): void => {
        const item = selectList.getSelectedItem();
        if (!item) return;
        selectedPath = item.value;
        const session = sessions.find((s) => s.path === item.value);

        void renameDialog(ctx, session?.name?.trim() ?? "").then((newName) => {
          if (newName !== undefined) {
            const cleaned = newName.replace(/[\r\n]+/g, " ").trim();
            try {
              renameSession(ctx, item.value, cleaned);
              if (session) session.name = cleaned || undefined;
              ctx.ui.notify(cleaned ? `Renamed to "${cleaned}"` : "Session name cleared", "info");
            } catch (error) {
              ctx.ui.notify(
                `Rename failed: ${error instanceof Error ? error.message : String(error)}`,
                "error",
              );
            }
            selectList = makeList(); // rebuild labels, restore selection
          }
          tui.requestRender();
        });
      };

      return {
        render: (width) => {
          const inner = Math.max(1, width - 4);
          const termRows = Math.max(20, tui.terminal.rows);

          const header = [...titleText.render(inner), ...subtitleText.render(inner), "", ""];
          const footer = ["", ...helpText.render(inner)];

          const listLines = selectList.render(inner); // includes a trailing scroll-indicator line when there are more sessions than visible rows
          const available = termRows - 4 - header.length - footer.length;
          const bodyHeight = Math.max(minBody, Math.min(listLines.length, available));

          const visible = listLines.slice(0, bodyHeight);
          const padTop = Math.max(0, Math.floor((bodyHeight - visible.length) / 2));
          const padBottom = Math.max(0, bodyHeight - visible.length - padTop);

          const block = [
            ...header,
            ...Array<string>(padTop).fill(""),
            ...visible,
            ...Array<string>(padBottom).fill(""),
            ...footer,
          ];
          return frameLines(block, width);
        },
        invalidate: () => {
          titleText.invalidate();
          subtitleText.invalidate();
          helpText.invalidate();
          selectList.invalidate();
        },
        handleInput: (data) => {
          if (matchesKey(data, Key.ctrl("r"))) {
            openRename();
            return;
          }
          selectList.handleInput(data);
          tui.requestRender();
        },
      };
    },
    {
      overlay: true,
      overlayOptions: { anchor: "center", width: 100, minWidth: 80, maxHeight: "85%", margin: 2 },
    },
  );
}

async function pickFallback(
  ctx: ExtensionCommandContext,
  sessions: SessionInfo[],
  currentFile: string | undefined,
  listAll: boolean,
): Promise<string | null> {
  const items = sessions.map(
    (s) => `${itemLabel(s)}  ·  ${itemDescription(s, currentFile, listAll)}`,
  );
  const title = listAll ? "All sessions" : `Sessions · ${truncate(ctx.cwd, MAX_SUBTITLE)}`;
  const selected = await ctx.ui.select(title, items);
  if (!selected) return null;

  const index = items.indexOf(selected);
  const session = index >= 0 ? sessions[index] : undefined;
  return session ? session.path : null;
}
