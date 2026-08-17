# Changelog

All notable changes to **dsh-save-money**, described by what you get and how your usage changes.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.3.1] — 2026-08-17

### Fixed

- **Config file location resolution is now robust**: no longer relies on a session whose workspace happens to point at this repo. The plugin walks a candidate list (pointer file → current session workspace → repo-named session workspaces → DSH startup dir → a `dsh-save-money` dir sibling to the startup dir → final fallback) and **the first directory that actually contains a config file wins**; after writing it records a pointer in `~/.dsh/` so a restart loads the same file.
- **A fresh install no longer writes the config into the DSH install dir**: when no config exists anywhere, the plugin prefers the repo directory (the README quick-install `~/app/` side-by-side layout is matched too) instead of polluting the harness dir — fixing "settings changed but nowhere to be found / config lost after restart".

## [1.3.0] — 2026-08-17

### Added

- **Account balance display** (official DeepSeek API): your current balance appears next to the status text in the header, with automatic currency symbol (¥ / $ / €…) and theme-adaptive color. Off by default — tick "Show balance" in settings to enable.
- **Balance auto-refresh**: refreshed immediately every time you send a message, and automatically every 5 minutes.
- **Spend statistics**: the backend samples the balance every 5 minutes (288 points covering the last 24 hours); hovering the balance shows how much was spent in the last 1 hour / 10 minutes / 24 hours; balance increases (e.g. top-ups, refunds) show as "+amount".
- **Custom hover card**: balance details and spend statistics are now a multi-line card that follows the mouse, extends left from the cursor and never leaves the viewport (replacing the native browser tooltip, which got clipped at the screen edge).

## [Unreleased] — 1.2.5

### Fixed

- **The Enable checkbox (and every other setting) now works in the official install form**: on some deployments the plugin started before the Web server service was ready, so the interface's requests could not reach it and clicks appeared to do nothing. The plugin now waits for the Web server to be available before registering its endpoints — same behaviour as the dynamic-plugin form.

## [Unreleased] — 1.2.4

### Fixed

- The official install bundle now loads its browser UI correctly: v1.2.3's package manifest omitted the `./package.json` export entry, so DSH could not discover the bundled Client half and no status text / banner / settings page appeared after install. From v1.2.4 the UI loads automatically (refresh the browser page once after installing).

## [Unreleased] — 1.2.3

### Added

- **The official install form now includes the full interface** (status text, floating banner, settings page) right in the installation package: the browser loads the plugin UI automatically on startup, so installing with `dsh plugin add` (or `--patch`) gives you the complete plugin — no dynamic-plugin step or AI-assisted setup needed anymore. The dynamic-plugin form keeps working exactly as before.

## [Unreleased] — 1.2.2

### Fixed

- The official install form (`--patch` / bundle) no longer fails to start on machines without the dynamic-plugin sandbox: it now registers its tools through DSH's standard mechanism, so the plugin loads and works on any deployment (e.g. Raspberry Pi). The dynamic-plugin form is unchanged.

## [Unreleased] — 1.2.1

### Added

- **Timezone switching converts your windows**: change the timezone dropdown and every window time converts automatically (real timezone rules, daylight-saving aware; Beijing 08:58 becomes London 01:58 in summer / 00:58 in winter). It is saved together with the Save button.
- **24 whole-hour timezones** in the dropdown (UTC-11 … UTC+12), one representative per offset, each showing its current UTC offset — no more 400-entry list.
- **10 languages**: 简体中文, 繁體中文, English, Deutsch, Français, Español, Italiano, Português, 日本語, 한국어 — detected from your browser automatically, or chosen manually in settings.

### Fixed

- Corrected timezone offset math, including the ±12/13-hour boundary (e.g. New Zealand), so every timezone shows and converts accurately.

## [1.2.0] — 2026-08-16

### Added

- **"End this save mode" button** (on both the floating banner and the settings panel): ends only the **current** pause window —
  - if paused: work resumes immediately;
  - if a pause is upcoming: it is cancelled;
  - only the current window is skipped; the next window (today or later) still takes effect;
  - the **Enable** switch is never turned off — you cannot accidentally stop saving money for good.
- **Reset anytime**: toggle the Enable switch off and back on and every window takes effect again (previously skipped windows are re-armed too).
- **Green status line in settings**: while a window is being skipped, a green line tells you which window was skipped, when saving resumes, and how to reset it.
- **Default schedule pre-filled**: fresh installs and empty window lists show the DeepSeek peak schedule (**08:58–12:02, 13:58–18:02**, with a 2-minute margin at both boundaries).
- **One-click DeepSeek works on what you see**: it upgrades the window list currently shown in the settings UI (unsaved edits are respected) and shows the result immediately.
- **Version number on the plugin panel** (`save-money v1.2.0`); a plain-language "how it works" diagram added to the README.

### Improved

- The button no longer says "Disable save mode" — skipping one window and disabling the feature are now clearly separate actions.
- Cancelling an upcoming pause no longer leaves a stale yellow "pausing soon" reminder.
- Settings are always saved to the project directory you are currently working in.

### Fixed

- Fixed an edge case where, after skipping a window, requests could slip through while another overlapping window (in a different timezone) was active — windows that should pause still pause.

## [1.1.0] — 2026-08-15

### Added

- **No cost inside a pause window**: the AI sends no new requests while paused; everything resumes automatically when the window ends, with conversation context and in-flight tasks unaffected (the AI not replying during a window is expected).
- **Automatic pause on schedule**: running tasks are safely frozen at pause time (progress preserved) and resume automatically at window end; **nothing is paused when nothing is running**.
- **Multiple time windows**: freely add/remove pause-resume windows; midnight-crossing (23:00–08:00) and per-weekday filtering supported.
- **UI reminders**: a top floating banner (light yellow for an upcoming pause / light red while paused) plus a persistent colored status entry in the session header, following the state in real time.
- **One-click DeepSeek peak/off-peak savings**: adds the peak windows with a 2-minute boundary margin (08:58–12:02, 13:58–18:02); does not auto-enable — your call; legacy no-margin windows are upgraded automatically.
- **Timezone support**: browser auto-detection with manual override (Beijing time default).
- **Persistent settings**: everything is saved automatically and survives browser refresh and restarts.
- **Chinese/English UI**: follows the browser language automatically, with a manual override.
- **Three install options**: quick try, official package, developer/debug form.

### Notes

- First release recorded in git; earlier versions have no commit history.

## [1.0.x] — before git history

- Initial implementation (developer/debug form): time-window auto pause/resume; "Disable save mode" button and skip-pause behavior (replaced by "End this save mode" in 1.2.0); no-margin DeepSeek windows (auto-upgraded to the margin version by the one-click preset).
