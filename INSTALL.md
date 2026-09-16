# Setting Up ArchViz On A New Computer

Follow these steps in order. Don't skip ahead.

## Before you start, get these from Erick
- [ ] The game build folder (several GB - USB drive or shared link)
- [ ] The `get_cf_turn_creds.ps1` file
- [ ] Two files from the old computer's `.cloudflared` folder: `config.yml` and one ending in `.json`
- [ ] A name for this machine (e.g. "Office GPU Rig")

## Step 1: Install Node.js
1. Go to nodejs.org
2. Click the big download button (the one labeled "LTS")
3. Open the downloaded file, click Next through the installer, then Finish

## Step 2: Install Unreal Engine 5.7
1. Go to epicgames.com and download the Epic Games Launcher
2. Install it, open it, sign in (ask Erick for the login if you don't have one)
3. Click "Unreal Engine" on the left, then "Library"
4. Click the **+** next to Engine Versions
5. Pick **5.7** and click Install (this takes a while, it's a big download)

## Step 3: Copy the game build
1. Make a folder: `C:\ArchViz\Build`
2. Copy the whole game folder Erick gave you into it

## Step 4: Download the setup files
1. Go to github.com/ErickGalvez/archviz-launcher-infra
2. Click the green "Code" button, then "Download ZIP"
3. Unzip it into a new folder: `C:\ArchViz\ProjectFiles`

## Step 5: Run the setup script
1. Open the `C:\ArchViz\ProjectFiles` folder in File Explorer
2. Click into the address bar at the top, type `powershell`, press Enter
3. Type this and press Enter:
   ```
   powershell -ExecutionPolicy Bypass -File .\setup_new_host.ps1
   ```
4. Answer the questions it asks:
   - **Host machine name** - whatever Erick told you
   - **Path to the UE5 .exe** - the .exe inside the folder from Step 3
   - **Path to SignallingWebServer** - inside your Unreal Engine install, find:
     `...\Engine\Plugins\Media\PixelStreaming\Resources\WebServers\SignallingWebServer`
     and paste its full path
5. When it asks about background tasks, type `y` and press Enter

## Step 6: Copy in the files it can't download for you
When the script finishes, it prints a numbered list. Do these two now:
1. Copy the `get_cf_turn_creds.ps1` file Erick gave you into the `ProjectFiles` folder
2. Copy `config.yml` and the `.json` file Erick gave you into `C:\Users\<your username>\.cloudflared\` (make that folder if it's not there)
3. Copy `common.bat.patched` (in `ProjectFiles`) over this file, renaming it to `common.bat`:
   `...\SignallingWebServer\platform_scripts\cmd\common.bat`

## Step 7: First-time start
1. Double-click `launch_pixelstream.bat` in the `ProjectFiles` folder
2. Wait about a minute for everything to open
3. A `www` folder will now exist here:
   `...\SignallingWebServer\www`
4. Copy `archviz-ui.js` from `ProjectFiles\_archviz-ui-overlay` into that `www` folder, replacing the file that's already there

## Step 8: Check it worked
1. Close everything - all the black command windows and the game window
2. Restart the computer
3. Wait about a minute after it logs back in
4. Open a browser, go to: `https://api.g-741studio.com/api/status`
   - You should see some text with `hostName` in it
5. Go to: `https://g-741studio.com/archviz/`
   - It should say "Host Online"

**If Step 8 doesn't work, stop and message Erick. Don't guess.**

---

## Running two hosts at once (a backup machine)

Skip this whole section if you're just replacing the only computer that runs ArchViz - Steps 1-8 above are all you need, and you're done.

Read this if the OLD computer is going to keep running too, as a backup, once the new one is set up. The idea: normally the new (faster/more reliable) computer serves everyone, but if it's turned off or something's wrong with it, the old one keeps the site working instead of it just going down. This needs a few things set up slightly differently so the two computers don't fight over the same visitors or the same login keys.

### The code stays in sync automatically

Both computers now check GitHub every 3 minutes and pull down anything new, restarting the background service automatically if there's an update (this is what Step 5's setup script registers as "ArchViz-Sync"). You never need to manually copy files between the two computers - every change (including ones pushed through the Dev Console) reaches both within a few minutes on its own. **Never hand-edit files directly on either computer** - always go through git (a normal push) or the Dev Console, or the next sync will have nothing to compare against and could get confused.

### The four secret key files must be identical on both computers

`admin.key`, `qa.key`, `devconsole.key`, and `devconsole-github.key` each get invented automatically the first time the server starts if they're missing - that's fine for one computer, but breaks things the moment a visitor's request happens to land on the *other* computer, since it would have invented different keys. **Copy these four files from the computer that's already running onto the new one before starting it the first time.** Do not let the new computer generate its own.

### Each computer needs its own Cloudflare Tunnel identity (not a shared one)

This is different from a straight replacement (Step 6.2 above, which intentionally moves the SAME tunnel to the new computer). For a backup setup, each computer gets its OWN tunnel instead, each with its own private internal address:
- `nh-internal.g-741studio.com` → the new/main computer
- `oh-internal.g-741studio.com` → the old/backup computer

The public addresses everyone actually uses (`api.g-741studio.com`, `stream.g-741studio.com`) don't point at either tunnel directly anymore - they point at a small Cloudflare Worker (`cloudflare_worker_fallback.js` in this folder) that tries the main computer first and only falls back to the backup one if the main one doesn't answer. This has to be set up once in the Cloudflare dashboard - see the instructions at the top of `cloudflare_worker_fallback.js` for the exact steps, or ask Erick to do this part.

One nice side effect: you can always check a computer directly by visiting its own internal address (e.g. `https://nh-internal.g-741studio.com/api/status`) - useful for testing a freshly set up computer before it's ever handling real visitors, completely separately from whatever's currently live on the public site.

### Day to day

- If both computers are on, the main one (NH) serves everyone. The backup does nothing but stay ready and stay in sync.
- If the main one is off or crashed, the backup starts serving automatically within seconds - nobody needs to flip a switch.
- Never run the actual pixel-streaming presentation (`launch_pixelstream.bat`) on both computers for the same visitor session - only one computer should ever be actively streaming to the public at a time. The failover above only decides which computer *answers requests*; starting a live session is still something a person does deliberately on whichever computer should be presenting.
