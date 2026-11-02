# Changelog

## 1.1.1 — 2026-11-01

**Fixed**
- Slow memory growth in the main process when the usage percentage changed often: tray icons are now drawn once per value and reused instead of being redrawn after a cache reset.
- Smaller Chromium disk cache.

**Added**
- `npm run test:soak`: a memory soak test that simulates hours of polling and reports growth after warm-up.

## 1.1.0 — 2026-11-01

**Added**
- **Installer** (`ClaudeUsageTray-Setup-1.1.0.exe`): one-click, per-user install with no admin rights, Start Menu and desktop shortcuts, and a normal uninstaller in Windows Settings.
- **Automatic updates** for installed copies, from this repo's GitHub Releases. Downloads are verified against the release's SHA-512 checksum and install when you quit, or right away with **Restart to update**. Can be turned off; **Check for updates** in the tray menu.
- **About** item in the tray menu showing the version.

**Fixed**
- Included credits now show what's left ("85% left") and the expiry as a date ("Expires Nov 5"), like claude.ai. Expired allowances are hidden.
- Per-model limits that differ only by surface (for example Claude Code vs. web) no longer hide each other, and legacy fields can't duplicate rows from the limits list.
- Odd values in the response (missing or negative dollar amounts, bad currency codes) can no longer show wrong numbers or blank the widget.
- Signing in to a different account clears the previous account's pace history.
- Long limit names are trimmed instead of overflowing.

## 1.0.1 — 2026-11-01

**Fixed**
- The widget showed internal code names and duplicate rows (for example "Iguana Necktie", "Session · Session", "Weekly · Weekly", "Extra Usage 0%"). It now shows the same limits and labels as claude.ai's Settings → Usage page.
- Per-model weekly limits (such as Fable or Opus) only appear once you've started using them, as on claude.ai.

**Added**
- Included credits, such as **Cloud session credits**, with dollars left and expiry date.

## 1.0.0 — 2026-11-01

First release: tray icon and always-on-top widget for session and weekly limits, live reset countdowns, pace estimate, optional alerts, Start with Windows, and a locked-down, sandboxed sign-in.
