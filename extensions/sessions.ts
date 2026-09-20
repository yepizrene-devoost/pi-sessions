import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import {
  SessionManager,
  type ExtensionAPI,
  type ExtensionCommandContext,
  type SessionInfo,
} from "@earendil-works/pi-coding-agent";
import {
  Input,
  type SelectItem,
  SelectList,
  matchesKey,
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";

const MAX_LABEL = 56;
const MAX_SUBTITLE = 80;
const ARCHIVE_FILE = ".pi-sessions-archived.json";

type SessionView = "active" | "archived";

/** Soft-delete state, keyed by session id so it survives moving a session file. */
interface ArchiveRegistry {
  version: number;
  archived: Record<string, { archivedAt: string; path?: string }>;
}

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

function isArchived(registry: ArchiveRegistry, session: SessionInfo): boolean {
  return Object.prototype.hasOwnProperty.call(registry.archived, session.id);
}

function archiveRegistryPath(ctx: ExtensionCommandContext): string {
  const file = ctx.sessionManager.getSessionFile();
  const root = file ? dirname(dirname(file)) : join(homedir(), ".pi", "agent", "sessions");
  return join(root, ARCHIVE_FILE);
}

function loadArchiveRegistry(path: string): ArchiveRegistry {
  try {
    if (existsSync(path)) {
      const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<ArchiveRegistry>;
      if (parsed && typeof parsed === "object" && parsed.archived && typeof parsed.archived === "object") {
        return { version: 1, archived: parsed.archived };
      }
    }
  } catch {
    // Corrupt or unreadable registry: start from an empty one.
  }
  return { version: 1, archived: {} };
}

function saveArchiveRegistry(path: string, registry: ArchiveRegistry): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(registry, null, 2)}\n`);
}

export default function sessionsExtension(pi: ExtensionAPI) {
  pi.registerCommand("sessions", {
    description: "List, resume, rename, archive (soft-delete), or delete sessions",
    getArgumentCompletions: (prefix) => {
      const opts = ["--all", "--archived"].filter((o) => o.startsWith(prefix));
      return opts.length > 0 ? opts.map((o) => ({ value: o, label: o })) : null;
    },
    async handler(args, ctx) {
      const flags = args.trim().split(/\s+/).filter(Boolean);
      const listAll = flags.includes("--all") || flags.includes("-a");
      const wantArchived = flags.includes("--archived");

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

      const registryPath = archiveRegistryPath(ctx);
      const registry = loadArchiveRegistry(registryPath);
      const hasActive = sorted.some((s) => !isArchived(registry, s));
      const initialView: SessionView = wantArchived || !hasActive ? "archived" : "active";

      const pickedPath =
        ctx.mode === "tui"
          ? await pickModal(ctx, sorted, currentFile, listAll, registry, registryPath, initialView)
          : await pickFallback(
              ctx,
              sorted.filter((s) => !isArchived(registry, s)),
              currentFile,
              listAll,
            );

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
          if (matchesKey(data, "ctrl+c")) {
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
  registry: ArchiveRegistry,
  registryPath: string,
  initialView: SessionView,
): Promise<string | null> {
  return ctx.ui.custom<string | null>(
    (tui, theme, _keybindings, done) => {
      const maxBody = 14;
      const minBody = 6;
      let view: SessionView = initialView;
      let selectedPath: string | undefined;

      const visibleSessions = (): SessionInfo[] =>
        sessions.filter((s) => (view === "archived" ? isArchived(registry, s) : !isArchived(registry, s)));

      const makeList = (): SelectList => {
        const items = buildItems(visibleSessions(), currentFile, listAll);
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

      const rebuild = (): void => {
        selectList = makeList();
        tui.requestRender();
      };

      const selectedSession = (): SessionInfo | undefined => {
        const item = selectList.getSelectedItem();
        return item ? sessions.find((s) => s.path === item.value) : undefined;
      };

      const openRename = (): void => {
        const session = selectedSession();
        if (!session) return;
        selectedPath = session.path;
        void renameDialog(ctx, session.name?.trim() ?? "").then((newName) => {
          if (newName !== undefined) {
            const cleaned = newName.replace(/[\r\n]+/g, " ").trim();
            try {
              renameSession(ctx, session.path, cleaned);
              session.name = cleaned || undefined;
              ctx.ui.notify(cleaned ? `Renamed to "${cleaned}"` : "Session name cleared", "info");
            } catch (error) {
              ctx.ui.notify(
                `Rename failed: ${error instanceof Error ? error.message : String(error)}`,
                "error",
              );
            }
          }
          rebuild();
        });
      };

      const toggleArchive = (): void => {
        const session = selectedSession();
        if (!session) return;
        const previous = registry.archived[session.id];
        if (isArchived(registry, session)) {
          delete registry.archived[session.id];
        } else {
          registry.archived[session.id] = { archivedAt: new Date().toISOString(), path: session.path };
        }
        try {
          saveArchiveRegistry(registryPath, registry);
        } catch (error) {
          // Revert in-memory state so it stays consistent with disk.
          if (previous) registry.archived[session.id] = previous;
          else delete registry.archived[session.id];
          ctx.ui.notify(
            `Could not save archive state: ${error instanceof Error ? error.message : String(error)}`,
            "error",
          );
          return;
        }
        selectedPath = undefined;
        rebuild();
      };

      const deleteSelected = (): void => {
        const session = selectedSession();
        if (!session) return;
        void (async () => {
          const ok = await ctx.ui.confirm(
            `Delete "${itemLabel(session)}"?`,
            `${session.path}\n\nThis permanently removes the session file. It cannot be undone.`,
          );
          if (!ok) return;
          try {
            if (existsSync(session.path)) rmSync(session.path, { force: true });
            delete registry.archived[session.id];
            saveArchiveRegistry(registryPath, registry);
            const index = sessions.indexOf(session);
            if (index >= 0) sessions.splice(index, 1);
            ctx.ui.notify("Session deleted.", "info");
          } catch (error) {
            ctx.ui.notify(
              `Delete failed: ${error instanceof Error ? error.message : String(error)}`,
              "error",
            );
          }
          selectedPath = undefined;
          rebuild();
        })();
      };

      const toggleView = (): void => {
        view = view === "active" ? "archived" : "active";
        selectedPath = undefined;
        rebuild();
      };

      return {
        render: (width) => {
          const inner = Math.max(1, width - 4);
          const termRows = Math.max(20, tui.terminal.rows);
          const archived = view === "archived";

          const title = archived ? "Archived sessions" : listAll ? "All sessions" : "Sessions";
          const subtitle = archived
            ? "Soft-deleted · enter resumes · ctrl+d deletes"
            : listAll
              ? "Across every project"
              : truncate(ctx.cwd, MAX_SUBTITLE);
          const help = archived
            ? "↑↓ move · enter resume · ctrl+r rename · ctrl+a unarchive · ctrl+d delete · tab active · esc close"
            : "↑↓ move · enter resume · ctrl+r rename · ctrl+a archive · tab archived · esc close";

          const header = [
            " " + theme.fg("accent", theme.bold(title)),
            " " + theme.fg("dim", truncate(subtitle, MAX_SUBTITLE)),
            "",
            "",
          ];
          const footer = ["", " " + theme.fg("dim", help)];

          const empty = visibleSessions().length === 0;
          const listLines = empty
            ? [" " + theme.fg("dim", archived ? "(no archived sessions)" : "(no active sessions)")]
            : selectList.render(inner);

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
          selectList.invalidate();
        },
        handleInput: (data) => {
          if (matchesKey(data, "ctrl+r")) {
            openRename();
            return;
          }
          if (matchesKey(data, "ctrl+a")) {
            toggleArchive();
            return;
          }
          if (matchesKey(data, "ctrl+d")) {
            if (view === "archived") deleteSelected();
            return;
          }
          if (matchesKey(data, "tab")) {
            toggleView();
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
  if (sessions.length === 0) {
    ctx.ui.notify("No active sessions to show.", "info");
    return null;
  }
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