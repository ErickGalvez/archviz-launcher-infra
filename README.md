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
