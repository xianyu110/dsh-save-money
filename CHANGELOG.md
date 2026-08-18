# Changelog

All notable changes to **dsh-save-money**, described by what you get and how your usage changes.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.4.1] — 2026-08-18

### Added

- **Per-model-tier save mode (apply only to the models you want)**: the settings panel now has an "Apply to models" section with four independent toggles — official flash / official pro / opencode go·zen flash / opencode go·zen pro. A checked tier is paused inside windows (saving money); an unchecked tier is **exempt** (requests flow normally even during a pause window). Requests are classified at runtime by provider route (`deepseek-official` vs any provider whose name contains `opencode`) and model name (`flash` / `pro`).
- **Sensible defaults + respect user choice**: on a fresh install the official flash and pro tiers are checked (paused), while opencode go/zen tiers are unchecked (exempt — OpenCode is a subscription, you opt in when you want it paused). Once you change any toggle, your persisted choice is honored and never reset.
- **Safe fallback**: any model that cannot be recognized as official flash/pro or opencode flash/pro — legacy names (`deepseek-chat` / `deepseek-reasoner`), other third parties, or any other model — is always **exempt** (never paused), so an unrecognized provider can never block your requests.
- The **One-click DeepSeek preset** button moved just above the pause-window list (it is a shortcut for the windows, not general settings).

## [1.4.0] — 2026-08-18

### Added

- **Spend bar chart (last 8 hours, per 10 minutes)**: click the balance in the header to open a popup chart. 48 bars, positive = spent (red, up), negative = top-up/recovery (green, down), 0 = neutral, unsampled = faint. Zero chart-library dependency, theme tokens only. 10 languages. Includes **X axis** (8 whole-hour ticks in the configured timezone) and **Y axis** (1/2/5×10ⁿ key-point ticks, ≤5, with dashed gridlines; the axis top sits slightly above the tallest bar for readability).
- **Time-aligned sampling and windows**: sample points are aligned to whole 5-minute boundaries and bar windows to whole 10-minute boundaries **in the configured timezone** (DST-aware, incl. non-whole-hour offsets like Asia/Kathmandu +5:45) — matching how the official console bills by local whole hours, so the chart compares cleanly with official records. The hover spend card shows the exact window range (e.g. `近1h消费 07:00–08:00 ¥1.25`), consistent with the bar chart.
- **Balance history is now persisted** to `~/.dsh/dsh-save-money-balance.json` (account-level, shared across projects): the plugin no longer loses sampled history on update / restart / disable-re-enable. The file is keyed by a fingerprint of the DeepSeek API key — **changing the key (= changing the account) automatically discards the old history**, so one account's balance trajectory never bleeds into another's.
- **External-spend attribution (no more "1-second spend explosion" scare)**: the plugin records whether the local environment actually made model requests (`llm/stream` activity) per sample. On the bar chart, a window where the balance dropped **without any local activity** is rendered as a **warning-colored bar** with a hover note "no local activity in this window; change may come from elsewhere" — instead of being reported as local consumption.
- **Chart footer disclaimer**: "data is estimated from sampling and is for reference only; official records take precedence" (10 languages).

### Fixed

- **False-zero bars in the spend chart**: a window whose both ends resolve to the same sample (insufficient coverage) is now `null` (faint), never a fabricated `0` that would look like "no spend".
- **Bar chart interaction**: clicking the balance now toggles the popup and clears the hover card; truly-zero bars use a neutral color instead of red; the title is no longer duplicated; opening the chart forces a refresh so it always shows the latest sample.
- **Unified window clock**: the 1h/10m/24h spend stats now share the same aligned clock basis as the bar chart, so the hover card and the chart refer to the same time windows (previously they could disagree by a few minutes).

## [1.3.3] — 2026-08-17

### Fixed

- **Balance visibility now follows the actual model in use (multi-provider setups)**: with several model sources configured (official DeepSeek + SiliconFlow / relays / …), the balance used to disappear whenever the session's default model was not the official one. The plugin now reads the **provider of the most recent real model request** (`llm/stream`); the balance is shown while the latest request ran on `deepseek-official` and hidden otherwise. Hiding does **not** clear the sampled spend history, so switching back to DeepSeek re-shows the balance (and its spend stats) immediately.
- **The official-API gate no longer depends on the default model**: previously the gate rejected when `agentDefaultModel.currentSelection()` was not `deepseek-official` — a wrong signal, because the balance is a property of the official account, not of the current default selection. Only the `llm-deepseek` baseURL override to a non-official endpoint (a relay without `/user/balance`) disables it.

## [1.3.2] — 2026-08-17

### Added

- **Plugin name + version in the settings popover**: the settings footer now shows `save-money v1.3.2` on the left of the Save button (the version is injected at build time from `package.json`, so it always matches the shipped manifest).

### Fixed

- **Config persistence no longer depends on activation order**: on machines where the plugin row activates before the harness's `fs` service (a different load order than the developer machine), a one-shot `ctx.get('fs')` at startup used to be `undefined`, so settings were never saved or loaded — saved settings "silently disappeared" after restart. The host now reads `fs` dynamically on every use and waits for the service via `ctx.inject(['fs'])`, so a late `fs` is picked up the moment it exists.

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
