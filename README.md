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
- `/sessions --all` lists sessions from every project, with the project path
  shown per entry.

## Install

From GitHub (git package):

```bash
pi install git:github.com/yepizrene-devoost/pi-sessions@v0.1.0
```

Quick test without installing:

```bash
pi -e git:github.com/yepizrene-devoost/pi-sessions
```

Local development:

```bash
pi -e ./extensions/sessions.ts
```

## Usage

Run Pi inside your project, then type:

```text
/sessions
```

Inside the picker:

- `↑`/`↓` navigate
- `Enter` resume the selected session
- `Ctrl+R` rename the selected session
- `Esc` cancel

To list sessions from every project instead of just the current directory:

```text
/sessions --all
```

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
