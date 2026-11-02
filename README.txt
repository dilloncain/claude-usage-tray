CLAUDE USAGE TRAY  -  v1.0.0
============================

Shows how much of your Claude plan you've used: the 5-hour session limit,
the weekly limits, and extra-usage credits, right in the Windows tray and in
a small always-on-top widget.

Works with any Claude Pro, Max, Team or Enterprise account. Each person signs
in with their own account on their own PC.


SETUP (about a minute)
----------------------
1. Right-click the zip > "Extract All..." and put the folder somewhere it can
   stay, for example  C:\Users\<you>\Apps\ClaudeUsageTray
   (Don't run it from inside the zip.)
2. Open the folder and double-click  "Claude Usage Tray.exe".
   - If Windows SmartScreen says "Windows protected your PC", click
     "More info" > "Run anyway". (The app isn't code-signed, that's all.)
3. A "Sign in to Claude" window opens. Sign in the same way you do on
   claude.ai (email code, Google, or Apple).
4. The window closes by itself and the widget appears in the bottom-right.

Tip: the tray icon may be hidden behind the "^" arrow next to the clock.
Drag it onto the taskbar to keep it visible.


USING IT
--------
- Tray icon: shows your current session % (green / yellow / orange / red).
  Hover it for a summary. Left-click to show or hide the widget.
  Right-click for the menu.
- Widget: drag it anywhere by its title bar. It remembers where you put it.
  Each bar shows the %, when it resets, and — if you're using it quickly —
  "Full in ~X", an estimate of when you'll hit the limit at your current pace.
- Refresh: automatic every minute (change under Settings > Refresh every),
  and right after each reset. The countdowns tick every second.


SETTINGS (right-click the tray icon > Settings)
-----------------------------------------------
- Tray icon shows ......... current session, or whichever limit is highest
- Tray icon style ......... number or ring
- Refresh every ........... 30 s / 1 min / 2 min / 5 min
- Widget opacity .......... 100% to 60%
- Alerts .................. turn desktop alerts on or off, pick the levels
                            (50 / 75 / 80 / 90 / 95 / 100%), get a toast when
                            your session resets, or send a test alert.
                            Each alert fires once per limit window.
- Start with Windows ...... launch automatically when you sign in to Windows


PRIVACY
-------
- You sign in on claude.ai's own page inside the app. The app never sees or
  stores your password.
- Your sign-in stays on your PC, in the app's own storage (encrypted by
  Windows):  %APPDATA%\Claude Usage Tray
- If you sign in with Google or Apple, the app throws away their cookies
  right after, and keeps only your claude.ai session.
- The sign-in window can only show claude.ai and the official Google/Apple
  sign-in pages. Other links open in your normal browser.
- The app only talks to claude.ai, and only reads the same usage numbers the
  claude.ai Settings > Usage page shows. No analytics, nothing sent elsewhere.
- "Sign out of Claude" in the tray menu wipes everything the app stored. To
  also end the session on Claude's side, use "Log out of all devices" in
  claude.ai settings.


NOTES
-----
- Claude doesn't publish token counts for plan limits, so the app shows
  percentages, the same as claude.ai's usage page.
- This is an unofficial tool, not made by Anthropic. It reads an internal
  claude.ai endpoint, so a future claude.ai change could break it.
- Uninstall: quit from the tray menu, turn off "Start with Windows" first if
  you enabled it, then delete the folder and  %APPDATA%\Claude Usage Tray


TROUBLESHOOTING
---------------
- Widget says "Sign in": your claude.ai session expired. Click Sign in.
- Google sign-in won't go through: use "Continue with email" instead and
  enter the code Claude emails you.
- Numbers look stale: right-click the tray icon > Refresh now.
- Widget went off-screen: it snaps back on the next launch; or quit and
  delete  %APPDATA%\Claude Usage Tray\settings.json
