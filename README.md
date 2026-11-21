# Stride: a running companion for your phone

An installable web app (PWA) that helps you on your running journey. No app store needed, it works offline, and all your data stays on your phone.

## Features
- **GPS run tracking:** distance, time, live pace, average pace and a route map
- **Voice updates:** spoken splits every km or mile
- **Couch-to-5K plan:** 9 weeks of guided run/walk intervals with voice, beep and vibration prompts
- **Progress:** total distance, best pace, longest run, weekly goal, 8-week chart, weekly streak
- **Run log:** how each run felt, notes, and manual entries for treadmill runs
- **Settings:** km or miles, keep the screen awake while running, backup export and import

## Get it on your phone
1. Host the folder over HTTPS. The easiest way is GitHub Pages: repo **Settings → Pages → Deploy from branch**, then choose the branch and `/ (root)`.
2. Open the Pages URL on your phone.
3. **iPhone (Safari):** Share → *Add to Home Screen*. **Android (Chrome):** menu → *Install app*.
4. Allow location access when you start your first run.

## Tips
- Keep the app open with the screen on during a run (the "keep screen on" setting is enabled by default). Browsers pause web apps that are in the background, so GPS can drop out if you lock the phone or switch apps.
- If the phone closes the app mid-run, reopen it and it will offer to restore your run.

## Run locally
```
python3 -m http.server 8000
```
Then open http://localhost:8000.
