# Universal Claw

Universal Claw lets you control one or more `tmux` terminal sessions from your phone through a mobile web UI. It runs a local host dashboard, exposes a secure remote URL through `ngrok`, and gives each remote session its own shareable link and QR code.

## What It Does

- Share the `tmux` pane you are already using
- Start clean detached terminal sessions remotely
- Manage multiple remotes from one dashboard
- Open each remote from a phone with a QR code or secure URL
- Send typed or dictated input from mobile
- Use terminal-friendly mobile shortcuts such as `Esc`, `Tab`, `Enter`, `Ctrl+C`, and `End`
- Return to the same remote session later from desktop with a `tmux` attach command

## Requirements

- `tmux`
- Node.js `22+`
- An `ngrok` account and auth token

If you already authenticated `ngrok` with its own CLI, Universal Claw can usually reuse that token automatically from your local `ngrok` config.

## Install

Global install with npm:

```bash
npm install -g universal-claw
remote-terminal doctor
remote-terminal auth <your-ngrok-token>
remote-terminal
```

Without installing globally:

```bash
npx universal-claw doctor
npx universal-claw auth <your-ngrok-token>
npx universal-claw
```

Run directly from this repository:

```bash
node server.mjs
```

## Quick Start

If you are already inside the terminal pane you want to share:

```bash
remote-terminal here
```

If you are in a regular shell and want a fresh detached remote in the current directory:

```bash
remote-terminal
```

Then:

1. Open the local host dashboard.
2. Scan the QR code or open the remote URL on your phone.
3. Type in the mobile composer and tap `Send`.
4. Use `Show Keys` when you need terminal shortcuts such as `Esc` or `Ctrl+C`.

## Typical Workflows

### Share Your Current `tmux` Pane

```bash
remote-terminal here
```

Alias:

```bash
remote-terminal share
```

This shares the exact `tmux` pane you are currently using.

### Start a Fresh Remote Session

```bash
remote-terminal
```

Outside `tmux`, this creates a detached remote session in the current working directory.

### Attach a Specific Existing `tmux` Target

```bash
remote-terminal --attach %12
remote-terminal --attach work:0.1
remote-terminal --attach work
```

### Force a Detached Remote Even While Inside `tmux`

```bash
remote-terminal --detached
```

### Start in Another Directory

```bash
remote-terminal --cwd ~/projects/my-app
```

## Host Dashboard

The host dashboard is local-only and runs on `127.0.0.1`. From there you can:

- create detached remotes
- attach existing `tmux` targets
- copy each remote URL
- open the mobile remote page
- copy the desktop `tmux` continue command
- revoke individual remotes
- stop public access
- end all remotes and shut down the host completely

Important: with a free `ngrok` plan, only one Universal Claw host can be active at a time. Run `remote-terminal` once, then create all extra remotes from that same dashboard.

## Mobile Remote

The mobile UI is optimized for narrow screens and terminal agent sessions.

- The text box clears automatically after each send
- The terminal view only auto-follows when you are already at the bottom
- Advanced keys can be hidden or shown to save space
- A microphone button is available on supported mobile browsers
- `Continue in Terminal` shows the exact desktop command needed to reopen the same session locally

## Continue on Desktop

Each remote session is backed by `tmux`. To continue the same session from desktop, use the session name shown in the dashboard and attach it locally:

```bash
tmux switch-client -t '<session-name>' 2>/dev/null || tmux attach -t '<session-name>'
```

You can also use the `Continue in Terminal` action in the dashboard or mobile UI to copy that command.

## Multiple Remotes

One host dashboard can manage multiple remotes at the same time.

- Each remote has its own secure URL
- Each remote can be revoked independently
- All remotes share the same `ngrok` tunnel
- Detached remotes stay available until you revoke or kill their backing `tmux` session

To see all remote-backed sessions on desktop:

```bash
tmux ls
```

## CLI Reference

```bash
remote-terminal
remote-terminal here
remote-terminal share
remote-terminal --detached
remote-terminal --attach <tmux-target>
remote-terminal --cwd <dir>
remote-terminal --no-open
remote-terminal doctor
remote-terminal auth <ngrok-token>
remote-terminal auth --status
remote-terminal auth --clear
remote-terminal --help
```

Behavior summary:

- Inside `tmux`, `remote-terminal` shares the current pane by default
- `remote-terminal here` and `remote-terminal share` explicitly share the current pane
- Outside `tmux`, `remote-terminal` creates a detached remote session in the current directory
- `--attach` targets a specific existing `tmux` session or pane
- `--detached` forces a fresh detached remote
- `doctor` checks required dependencies and auth setup

## Security Notes

- The host dashboard is only exposed locally
- Mobile access is granted through per-remote secure URLs
- Remote access can be revoked per session
- `Stop Remote Access` disables the public tunnel
- `End All & Exit` revokes remotes, stops `ngrok`, closes detached sessions created for remotes, and shuts down the host

## Troubleshooting

### `failed to connect session` or `ERR_NGROK_108`

Your `ngrok` plan is already using another active Universal Claw host. Stop the old host first, or use the existing dashboard instead of starting `remote-terminal` again.

### The remote page does not submit to Codex or another CLI agent

Universal Claw sends typed input first and then submits `Enter` with a small delay so raw terminal agent UIs have time to process the pasted text correctly.

### I want to start completely fresh

Use `End All & Exit` from the dashboard, or stop the host and kill the remote `tmux` sessions manually:

```bash
tmux kill-session -t <session-name>
```

## License

MIT
