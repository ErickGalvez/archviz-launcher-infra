# UE5 Pixel Streaming — Self-Hosted Setup
### ArchViz client presentations · single session

---

## Files in this package

| File | Purpose |
|------|---------|
| `launch_pixelstream.bat` | Main launcher — starts UE5 + signaling server |
| `signalling_config.json` | Signaling server config (auto-written by launcher) |
| `expose_cloudflare_tunnel.bat` | Optional: creates a public HTTPS URL, no port forwarding |

---

## Prerequisites

Install these once:

1. **Node.js 18+** — https://nodejs.org (LTS version)
2. **cloudflared.exe** — only if using Cloudflare Tunnel (recommended)
   - Download from https://github.com/cloudflare/cloudflared/releases/latest
   - File: `cloudflared-windows-amd64.exe` → rename to `cloudflared.exe`
   - Place it next to `expose_cloudflare_tunnel.bat`

---

## First-time setup (5 minutes)

1. Open `launch_pixelstream.bat` in a text editor (right-click → Edit)
2. Set the two paths in the `CONFIG` section:
   ```
   UE5_EXE   = full path to your packaged .exe
   SIGNAL_DIR = full path to the SignallingWebServer folder inside your package
   ```
   The signaling server folder is typically at:
   ```
   <YourPackage>\Samples\PixelStreaming\WebServers\SignallingWebServer\
   ```
3. Adjust `STREAM_W`, `STREAM_H`, `STREAM_FPS` if needed
4. Save and close

---

## Running a presentation

**Step 1 — Start the stream**
```
Double-click: launch_pixelstream.bat
```
Wait ~15 seconds for UE5 to finish loading. You'll see two windows open:
- A command prompt (signaling server)
- The UE5 render window (may be hidden if `-RenderOffScreen` is active)

**Step 2 — Get a URL for your client**

Option A — Local network only (same WiFi):
```
http://<your-local-IP>:80
```
Find your local IP: open a terminal and run `ipconfig`, look for IPv4 Address.

Option B — Remote client, easiest (no router config needed):
```
Double-click: expose_cloudflare_tunnel.bat
```
Copy the `https://xxxx.trycloudflare.com` URL that appears and send it to your client.

Option C — Remote client, static/DDNS:
```
http://<your-public-IP-or-ddns-hostname>
```
Requires port 80 forwarded on your router to this machine.

**Step 3 — Client opens the URL in any browser**

Chrome or Edge recommended. No plugins needed. The stream starts automatically.

---

## Updating and restarting the launcher

The admin panel (`http://localhost:3000`, local only) has a **Launcher software** box under the log. It says how many changes are ahead of the code this launcher started with
(whether they were pushed from another PC or committed in this checkout), lists their titles, and says whether the launcher itself changed. The button then reads
**Update & restart (N)**, **Update (N, no restart needed)** for tests/docs-only changes, or **Restart launcher** when nothing is new.

- It pulls fast-forward only, checks that the new `launcher-server.js` and the bridge load, and rolls the pull back (no restart) if they do not.
- A running stream, a turn, a queue or someone in the room blocks it; the panel asks before cutting that off.
- It exits the process and `listener_service.bat` relaunches it about 5 seconds later. The panel does not reload itself afterwards (loading the panel starts a stream).
- Needs the admin key (`/api/update/status`, `/api/update/apply`). Tests: `node updater.test.js` (real git, 21 checks), `node updater.mutation.js`.

### From the Dev Console (Launchers card)

The website's Dev Console has **Restart All Launchers**, **Restart PC 1**, **Restart PC 2** and **Start Agents** (`remote-restart.js`; Dev Console key):

| Button | Route | What happens |
|---|---|---|
| Restart PC 1 | `POST /api/devconsole/restart-launchers` `{ "pc": 1 }` | This launcher restarts through the same updater as the panel (fast-forward pull, checks, rollback), then PC 1's node agent restarts on the new code |
| Restart PC 2 | `{ "pc": 2 }` | PC 2's node agent restarts (PC 2 has no launcher; it is the AI worker). Its folder is a copy, so this reloads it, it does not update it |
| Restart All | `{}` | PC 2's agent, then PC 1 as above |
| Start Agents | `POST /api/devconsole/start-agents` | The local model starts on every PC that is free (not rendering, not reserved); one that already runs it is left alone |

- A live session (a stream, a turn, a queue, someone in the room) refuses Restart PC 1 and Restart All with a 409; it is never forced from the console. Restart PC 2 does not touch the session.
- A node agent restarts only when it runs under `bridge\start-node.bat` (which passes `--supervised` and starts it again 5 seconds later) and has no job running; started by hand, it says so instead.
- One restart every 20 seconds and one model start every 10 seconds. Nothing from the request reaches a command: only which PC.
- Tests: `node remote-restart.test.js` (11 checks), `node remote-restart.mutation.js`; the agent and hub side are in `bridge/bridge.test.js`.

## Stopping the stream

- Close the UE5 window (or the command prompt titled "UE5 PixelStream")
- Close the signaling server window (titled "PS Signalling Server")
- Close the Cloudflare Tunnel window if open

---

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| Black screen in browser | UE5 is still loading — wait 15–30s and refresh |
| "Connection refused" on port 80 | Windows Firewall may be blocking it — allow Node.js through |
| Client can connect locally but not remotely | Use Cloudflare Tunnel to bypass NAT/router issues |
| High latency / artifacts | Lower bitrate in launcher: change `15000000` to `8000000` |
| Audio not streaming | Ensure `-AudioMixer` flag is present and audio output device is active |
| npm install fails | Run the script as Administrator, or install Node.js dependencies manually |

**Windows Firewall — quick fix:**
If port 80 is blocked, open PowerShell as Administrator and run:
```powershell
New-NetFirewallRule -DisplayName "UE5 PixelStream" -Direction Inbound -Protocol TCP -LocalPort 80 -Action Allow
```

---

## Bitrate guide

| Scene complexity | Upload needed | Recommended setting |
|---|---|---|
| Simple, few materials | ~4 Mbps | `TargetBitrate=4000000` |
| Typical archviz interior | ~8–12 Mbps | `TargetBitrate=10000000` (default) |
| High-detail, Lumen on | ~15–20 Mbps | `TargetBitrate=15000000` |

Check your upload speed at https://fast.com before the presentation.

---

## Notes on UE5 Pixel Streaming plugin versions

- UE5.1–5.3: uses `Pixel Streaming` plugin (this setup)
- UE5.4+: Epic introduced `Pixel Streaming 2` — check which plugin your project uses
  in the UE5 Editor under Edit → Plugins → search "Pixel Streaming"
- The signaling server location and launch flags are the same for both versions
