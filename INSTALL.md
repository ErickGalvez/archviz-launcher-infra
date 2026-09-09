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
