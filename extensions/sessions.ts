import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";

import {
  SessionManager,
  type ExtensionAPI,
  type ExtensionCommandContext,
  type SessionInfo,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import {
  Input,
  type SelectItem,
  SelectList,
  type SelectListTheme,
  fuzzyMatch,
  getKeybindings,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";

const MAX_LABEL = 56;
const MAX_SUBTITLE = 80;
const ARCHIVE_FILE = ".pi-sessions-archived.json";
const GROUP_PREFIX = "__group__:";
// Blank row that separates a day header from its sessions.
const GAP_PREFIX = "__gap__:";

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

/**
 * Sessions are listed newest-activity-first, so a group boundary is just a day
 * change in `modified`. The current day gets a friendly label; older days keep
 * an unambiguous date.
 */
function groupLabel(date: Date, today: Date = new Date()): string {
  if (Number.isNaN(date.getTime())) return "Unknown date";
  const sameDay =
    date.getFullYear() === today.getFullYear() &&
    date.getMonth() === today.getMonth() &&
    date.getDate() === today.getDate();
  return sameDay ? "Today" : date.toDateString();
}

/** Day headers and the blank rows between groups: rendered, never selectable. */
function isDecorRow(value: string): boolean {
  return value.startsWith(GROUP_PREFIX) || value.startsWith(GAP_PREFIX);
}

function firstSelectableIndex(items: SelectItem[]): number {
  const index = items.findIndex((item) => !isDecorRow(item.value));
  return index >= 0 ? index : 0;
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

// Day headers and the blank row between groups are ordinary (non-selectable)
// items, so SelectList keeps scrolling them together with their group instead of
// us reimplementing list rendering, scrolling and selection bookkeeping.
function buildItems(
  sessions: SessionInfo[], // must already be sorted by `modified` descending
  currentFile: string | undefined,
  listAll: boolean,
  theme: Theme,
): SelectItem[] {
  const items: SelectItem[] = [];
  let currentGroup: string | undefined;
  for (const session of sessions) {
    const label = groupLabel(session.modified);
    if (label !== currentGroup) {
      currentGroup = label;
      // A blank row separates consecutive groups, opencode-style: the day title
      // sits directly above its own sessions instead of being pushed away from
      // them. The first group starts at the top with no leading blank line.
      // The label must not be empty: SelectList renders `item.label ||
      // item.value` and would show the raw `__gap__:` marker instead.
      if (items.length > 0) items.push({ value: `${GAP_PREFIX}${label}`, label: " " });
      items.push({
        value: `${GROUP_PREFIX}${label}`,
        // Theme `text` (near-white on a dark theme) keeps the day label readable
        // while still following the active theme.
        label: theme.fg("text", theme.bold(label)),
      });
    }
    items.push({
      value: session.path,
      label: itemLabel(session),
      description: itemDescription(session, currentFile, listAll),
    });
  }
  return items;
}

/**
 * What the picker searches: exactly the text each row displays, meaning the same
 * label the list renders, the short id shown in every description, and — only
 * when listing every project, where the row shows the project path — the project
 * folder name. Searching anything broader (the full uuid, the whole first
 * message, the whole path) matched rows whose visible text has nothing to do
 * with the query, because fuzzy matching over a long string matches almost any
 * short query.
 */
function sessionSearchText(session: SessionInfo, includeProject: boolean): string {
  const base = `${session.id.slice(0, 8)} ${itemLabel(session)}`;
  return includeProject ? `${base} ${basename(session.cwd)}` : base;
}

// Every whitespace-separated token must match somewhere (AND semantics); each
// token is a fuzzy in-order match: the same matcher Pi's own session picker
// uses, so search behaves the way it does elsewhere in Pi.
function matchesSearch(session: SessionInfo, query: string, includeProject = false): boolean {
  const tokens = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return true;
  const text = sessionSearchText(session, includeProject);
  return tokens.every((token) => fuzzyMatch(token, text).matches);
}

// Paint a solid panel background over a fully padded line. Nested styled text
// and `truncateToWidth` can emit a full reset, which would punch a transparent
// hole in the panel, so the background is re-applied after every reset.
function solidLine(text: string, theme: Theme): string {
  const bg = theme.getBgAnsi("customMessageBg");
  return bg + text.replaceAll("\x1b[0m", `\x1b[0m${bg}`) + "\x1b[49m";
}

// Wrap rendered content lines in a full box with all four borders, painted on an
// opaque panel background so the transcript behind the modal never shows through.
function frameLines(lines: readonly string[], width: number, theme: Theme): string[] {
  const inner = Math.max(1, width - 4); // space between the side borders (1+1 padding, 1+1 borders)
  const top = "┌" + "─".repeat(Math.max(0, width - 2)) + "┐";
  const bottom = "└" + "─".repeat(Math.max(0, width - 2)) + "┘";
  const body = lines.map((line) => {
    const txt = truncateToWidth(line, inner, "");
    const pad = Math.max(0, inner - visibleWidth(txt));
    return solidLine("│ " + txt + " ".repeat(pad) + " │", theme);
  });
  return [solidLine(top, theme), ...body, solidLine(bottom, theme)];
}

// `rowWidth` is a getter because the list only learns the row width while it
// renders, which is when these callbacks run. With the default (0) the selected
// row is styled but not painted as a full-width bar.
function selectTheme(theme: Theme, rowWidth: () => number = () => 0): SelectListTheme {
  return {
    selectedPrefix: (t) => theme.fg("accent", t),
    // The whole selected row (prefix, label, spacing and description) arrives here
    // as one string, so padding it to the row width paints the bar across the
    // entire row. Over-padding on a narrow terminal is harmless: the line is
    // truncated to the panel width afterwards.
    //
    // The row is not recoloured: the bar alone marks the selection. The leading
    // `→ ` that SelectList hardcodes for the selected row is replaced by two
    // spaces, which is exactly the prefix every other row uses, so the text stays
    // aligned with its neighbours and only the background differs.
    selectedText: (t) => {
      const row = t.startsWith("→ ") ? `  ${t.slice(2)}` : t;
      const pad = " ".repeat(Math.max(0, rowWidth() - visibleWidth(row)));
      return theme.bg("selectedBg", row + pad);
    },
    description: (t) => theme.fg("muted", t),
    scrollInfo: (t) => theme.fg("dim", t),
    noMatch: (t) => theme.fg("warning", t),
  };
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
          return frameLines(block, width, theme);
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

type ConfirmTone = "dim" | "warning" | "error";

interface ConfirmLine {
  text: string;
  tone?: ConfirmTone;
}

interface ConfirmOverlayOptions {
  title: string;
  lines: ConfirmLine[];
  confirmLabel?: string;
  cancelLabel?: string;
}

// A confirmation dialog rendered as its own overlay, so it stacks on top of the
// picker instead of replacing the editor area underneath it. The non-destructive
// entry starts selected: this dialog only guards irreversible actions, so a stray
// Enter must cancel instead of confirming.
async function confirmOverlay(
  ctx: ExtensionCommandContext,
  options: ConfirmOverlayOptions,
): Promise<boolean> {
  return ctx.ui.custom<boolean>(
    (tui, theme, _keybindings, done) => {
      let rowWidth = 0;
      const list = new SelectList(
        [
          { value: "confirm", label: options.confirmLabel ?? "Yes" },
          { value: "cancel", label: options.cancelLabel ?? "No" },
        ],
        2,
        selectTheme(theme, () => rowWidth),
      );
      list.onSelect = (item) => done(item.value === "confirm");
      list.onCancel = () => done(false);
      list.setSelectedIndex(1);

      return {
        render: (width: number) => {
          const inner = Math.max(1, width - 4);
          rowWidth = inner;
          const wrapWidth = Math.max(8, inner - 1);
          const body = options.lines.flatMap((line) => {
            if (line.text.trim() === "") return [""];
            return wrapTextWithAnsi(line.text, wrapWidth).map(
              (chunk) => " " + (line.tone ? theme.fg(line.tone, chunk) : chunk),
            );
          });
          const block = [
            " " + theme.fg("error", theme.bold(options.title)),
            "",
            ...body,
            "",
            ...list.render(inner),
            "",
            " " + theme.fg("dim", "enter select · esc cancel"),
          ];
          return frameLines(block, width, theme);
        },
        invalidate: () => list.invalidate(),
        handleInput: (data: string) => {
          if (matchesKey(data, "ctrl+c")) {
            done(false);
            return;
          }
          list.handleInput(data);
          tui.requestRender();
        },
      };
    },
    {
      overlay: true,
      overlayOptions: { anchor: "center", width: 72, minWidth: 44, margin: 2 },
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

      const search = new Input({
        prompt: " ",
        placeholder: "Search",
        placeholderStyle: (text) => theme.fg("dim", text),
      });

      const visibleSessions = (): SessionInfo[] =>
        sessions.filter((s) => (view === "archived" ? isArchived(registry, s) : !isArchived(registry, s)));

      const filteredSessions = (): SessionInfo[] => {
        const query = search.getValue();
        if (!query.trim()) return visibleSessions();
        return visibleSessions().filter((session) => matchesSearch(session, query, listAll));
      };

      let itemCount = 0;
      let rowWidth = 0;

      const makeList = (): SelectList => {
        const items = buildItems(filteredSessions(), currentFile, listAll, theme);
        itemCount = items.length;
        const list = new SelectList(
          items,
          maxBody,
          selectTheme(theme, () => rowWidth),
          { maxPrimaryColumnWidth: 44 },
        );
        // A day header must never be picked or kept as the selection.
        list.onSelect = (item) => {
          if (!isDecorRow(item.value)) done(item.value);
        };
        list.onCancel = () => done(null);
        list.onSelectionChange = (item) => {
          if (!isDecorRow(item.value)) selectedPath = item.value;
        };
        const index = selectedPath ? items.findIndex((item) => item.value === selectedPath) : -1;
        list.setSelectedIndex(index >= 0 ? index : firstSelectableIndex(items));
        return list;
      };

      let selectList = makeList();

      // Arrow keys (including the wrap-around at both ends) can land on a day
      // header or a blank row between groups; keep walking in the same direction
      // until a session is selected.
      const movePastHeader = (data: string): void => {
        for (let guard = 0; guard <= itemCount; guard += 1) {
          const value = selectList.getSelectedItem()?.value;
          if (!value || !isDecorRow(value)) return;
          selectList.handleInput(data);
        }
      };

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
          const archived = isArchived(registry, session);
          const lines: ConfirmLine[] = [
            { text: session.path, tone: "dim" },
            { text: "" },
            { text: "This permanently removes the session file and cannot be undone.", tone: "warning" },
          ];
          if (!archived) lines.push({ text: "This session is not archived.", tone: "warning" });
          const ok = await confirmOverlay(ctx, {
            title: `Delete "${itemLabel(session)}"?`,
            lines,
          });
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

      let focused = false;
      return {
        get focused() {
          return focused;
        },
        set focused(value: boolean) {
          focused = value;
          search.focused = value;
        },
        render: (width) => {
          const inner = Math.max(1, width - 4);
          rowWidth = inner;
          const termRows = Math.max(20, tui.terminal.rows);
          const archived = view === "archived";

          const title = archived ? "Archived sessions" : listAll ? "All sessions" : "Sessions";
          const subtitle = archived
            ? "Soft-deleted · enter resumes · ctrl+d deletes"
            : listAll
              ? "Across every project"
              : truncate(ctx.cwd, MAX_SUBTITLE);
          const help = archived
            ? "↑↓ move · enter resume · ctrl+r rename · ctrl+a unarchive · ctrl+d delete · tab active"
            : "↑↓ move · enter resume · ctrl+r rename · ctrl+a archive · ctrl+d delete · tab archived";
          const filterHint = search.getValue().trim()
            ? "esc clear filter"
            : "esc close · type to search";

          const header = [
            " " + theme.fg("accent", theme.bold(title)),
            " " + theme.fg("dim", truncate(subtitle, MAX_SUBTITLE)),
            ...search.render(inner),
            "",
          ];
          const footer = [
            "",
            " " + theme.fg("dim", help),
            " " + theme.fg("dim", filterHint),
          ];

          const empty = visibleSessions().length === 0;
          const listLines = empty
            ? [" " + theme.fg("dim", archived ? "(no archived sessions)" : "(no active sessions)")]
            : filteredSessions().length === 0
              ? [
                  " " +
                    theme.fg(
                      "dim",
                      `(no sessions match "${truncate(search.getValue(), 24)}")`,
                    ),
                ]
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
          return frameLines(block, width, theme);
        },
        invalidate: () => {
          selectList.invalidate();
        },
        handleInput: (data) => {
          const keybindings = getKeybindings();
          if (matchesKey(data, "ctrl+r")) {
            openRename();
            return;
          }
          if (matchesKey(data, "ctrl+a")) {
            toggleArchive();
            return;
          }
          if (matchesKey(data, "ctrl+d")) {
            deleteSelected();
            return;
          }
          if (matchesKey(data, "tab")) {
            toggleView();
            return;
          }
          if (keybindings.matches(data, "tui.select.cancel")) {
            // Escape clears an active filter before closing, so a search never
            // traps the user in a short list.
            if (matchesKey(data, "escape") && search.getValue().length > 0) {
              search.setValue("");
              selectedPath = undefined;
              rebuild();
              return;
            }
            selectList.handleInput(data);
            return;
          }
          if (keybindings.matches(data, "tui.select.confirm")) {
            selectList.handleInput(data);
            return;
          }
          if (
            keybindings.matches(data, "tui.select.up") ||
            keybindings.matches(data, "tui.select.down")
          ) {
            selectList.handleInput(data);
            movePastHeader(data);
            tui.requestRender();
            return;
          }
          // Anything else is search text: type to filter the list as you go.
          search.handleInput(data);
          rebuild();
        },
      };
    },
    {
      overlay: true,
      overlayOptions: { anchor: "center", width: 130, minWidth: 100, maxHeight: "85%", margin: 2 },
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