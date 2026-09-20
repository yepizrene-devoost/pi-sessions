# pi-sessions

A tiny [Pi](https://pi.dev) extension that adds a `/sessions` command to list the
sessions associated with the current working directory — and resume any of them
directly from the interactive UI.

No more digging through `~/.pi/agent/sessions/` to find sessions.

## Features

- `/sessions` lists sessions scoped to the directory where you launched Pi, in a
  centered TUI overlay (modal), not an inline list.
- Each entry shows the display name (or first message), message count, modified
  time, and a short id.
- The currently open session is marked `current`.
- Pick one to confirm and resume it; the current session is suspended and the
  selected one is reopened in place.
- Rename any session directly from the picker with `Ctrl+R` (emptying the name
  clears it).
- Archive a session with `Ctrl+A`: it is a soft delete, so it leaves the active
  list but its file stays on disk.
- `Tab` switches to the archived view. From there you can resume an archived
  session, unarchive it (`Ctrl+A`), or permanently delete it (`Ctrl+D`).
- `/sessions --all` lists sessions from every project, with the project path
  shown per entry.
- `/sessions --archived` opens directly in the archived view.

## Install

Install the latest `main` (development branch):

```bash
pi install git:github.com/yepizrene-devoost/pi-sessions@main
```

Quick test without installing (defaults to `main`):

```bash
pi -e git:github.com/yepizrene-devoost/pi-sessions
```

Local development:

```bash
pi -e ./extensions/sessions.ts
```

## Versioning

`main` is the living development branch and is the recommended install target.
Stable releases are cut with a git tag (for example `v0.1.0`) when a release is
published; point `@<tag>` at those only if you want a pinned frozen version.
While iterating, install from `@main` so `/reload` picks up the latest commits
without re-tagging every change.

## Usage

Run Pi inside your project, then type:

```text
/sessions
```

Inside the picker:

- `↑`/`↓` navigate
- `Enter` resume the selected session
- `Ctrl+R` rename the selected session
- `Ctrl+A` archive / unarchive the selected session
- `Tab` switch between the active and archived views
- `Ctrl+D` delete the selected session permanently (archived view only)
- `Esc` cancel

Options:

```text
/sessions --all        # include sessions from every project
/sessions --archived   # open directly in the archived view
```

## Archiving

Archiving is a **soft delete**: the session is hidden from the active list but
its `.jsonl` file is untouched and still shows up in the archived view.
Permanent deletion (`Ctrl+D`) is only available from the archived view, asks for
confirmation, and then removes the session file from disk.

Archive state lives next to your sessions in
`~/.pi/agent/sessions/.pi-sessions-archived.json`, keyed by session id, so it
survives renaming or moving a session file.

## How it works

The extension registers a slash command and uses the built-in
`SessionManager.list(cwd)` API to enumerate sessions for the current directory,
then `ctx.switchSession()` to resume the selection. It only reads Pi's own
session API; it does not parse session files by hand.

## Repo layout

```text
pi-sessions/
├── extensions/
│   └── sessions.ts   # the /sessions command
├── package.json      # pi-package manifest
├── README.md
└── LICENSE
```

## Security

Extensions run with full system permissions. This repo does not store session
files, keys, or raw `settings.json`; provider credentials belong in environment
variables referenced as `$VAR`, never committed in plain text.

## License

MIT — see [LICENSE](LICENSE).
