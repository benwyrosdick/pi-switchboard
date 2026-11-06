# pi-switchboard

A Pi extension for keeping several conversations in reach, in the style of Grok's agent dashboard (`Ctrl+\`) and Claude Code's agents view (Left at the start of the prompt).

Pi still runs one conversation at a time. Switching away from a live response aborts it, after a confirmation. Other conversations stay on disk and come back with their history.

## Keys

| Key | Where | Action |
| --- | --- | --- |
| `Ctrl+\` | Anywhere | Toggle the switchboard |
| `Left` | Prompt, cursor at column 0 | Open the switchboard |
| `/switchboard` | Prompt | Open it (also `/conversations`) |

Inside the panel:

| Key | Action |
| --- | --- |
| `Up` / `Down`, `j` / `k` | Move |
| `1`–`9` | Jump to a row |
| `Enter` | Switch to the conversation |
| `n` | New conversation |
| `r` | Rename |
| `x` | Hide from the open list (does not delete the session) |
| `/` | Filter |
| `Esc`, `Left`, `Ctrl+\` | Close |

`/switchboard next` and `/switchboard prev` cycle the open list without opening the panel.

## Install

From npm:

```bash
pi install npm:pi-switchboard
```

That adds it to `~/.pi/agent/settings.json` and loads it on the next start. Pin a release with `pi install npm:pi-switchboard@0.1.0`. Try it once without installing:

```bash
pi -e npm:pi-switchboard
```

From a checkout of this repo:

```bash
pi install .
```

Then `/reload` after edits.

`Ctrl+\` is SIGQUIT in a cooked terminal. Pi's TUI uses raw mode, so the key should arrive as a shortcut. If a terminal still kills Pi, use Left or `/switchboard`.

## State

Open conversations and parked drafts are stored in `~/.pi/agent/switchboard.json`, grouped by working directory. Hiding a row only removes it from that list. Delete sessions from `/resume`.
