# Testing the launcher API with Postman

The launcher's HTTP API (`launcher-server.js` and `bridge/`) as a Postman collection with tests.

| File | What it is |
|---|---|
| `archviz-launcher.postman_collection.json` | 112 requests in 12 folders, each with tests |
| `local.postman_environment.json` | **ArchViz Launcher · local**: `http://localhost:3000`, writes **on** |
| `live.postman_environment.json` | **ArchViz Launcher · live**: `https://api.g-741studio.com`, writes **off** |

The environments have empty key fields. **Never commit a key**: you type the keys into Postman yourself (step 3).

## What the folders do

| Folder | Key it needs | Changes data? | Safe against the live launcher? |
|---|---|---|---|
| 1 · Public | none | no | yes |
| 2 · Input validation | none | no: every request is refused before anything is stored | yes |
| 3 · Auth | none | no: each route answers 401 without the key, and each request was picked so that even a broken key check would change nothing | yes |
| 4 · Admin key (read-only) | `adminKey` | no | yes |
| 5 · Dev Console key (read-only) | `devconsoleKey` | no | yes |
| 6 · QA key (read-only) | `qaKey` | no | yes |
| 7 · Writes · QA tickets and reports | `qaKey` | creates a ticket and a report, then deletes both | skipped unless `allowWrites` is `true` |
| 8 · Writes · QA test cases | `qaKey` | creates a `PM-…` test case. **There is no delete route, so it stays.** | skipped unless `allowWrites` is `true` |
| 9 · Writes · Sales prospects | `devconsoleKey` | creates a prospect, then deletes it | skipped unless `allowWrites` is `true` |
| 10 · Writes · Owner tasks | `devconsoleKey` | creates and imports tasks, then deletes them | skipped unless `allowWrites` is `true` |
| 11 · Writes · Task-IO | `devconsoleKey` | records a task and marks it done. **Task-IO has no delete, so it stays in that day's list.** | skipped unless `allowWrites` is `true` |
| 12 · Writes · Room | none | two test visitors join and leave | skipped unless `allowWrites` is `true` |

The live environment has `allowWrites` set to `false`, so a run against it does folders 1–6 only (54 requests). Keep it that way: folders 8 and 11 leave records behind, and folder 12 puts test visitors in the room, where real visitors would see them.

Every response is also checked for two things: it arrives within `maxResponseMs` (3 s local, 8 s live, which is the Cloudflare Worker's own timeout), and every `/api/` response has the `Access-Control-Allow-Origin: *` header the website's pages need.

**Not in the collection, on purpose.** These routes do something real that a test cannot undo:

- **Stream and tunnel:** `launch-ps`, `launch-cf`, `stop-ps`, `stop-cf`, `stop-all`, `force-reset`. They start or stop UE5 and the tunnel.
- **Updates:** `update/apply` pulls and restarts the launcher.
- **Lobby:** `lobby/join`, `lobby/confirm`, `lobby/leave`. A join starts a visitor's turn.
- **GitHub:** `devconsole/dispatch`, `commit`, `undo`, `answer`. These open issues and merge PRs on GitHub.
- **Real records:** `sales/prospects/distribute` reschedules every prospect. `qa/cases/seed` is the one-time seed. `banner/upload` replaces the public thumbnail. A successful `inquiry` or `quote` stores a real lead.
- **The PCs:** the bridge write routes and `archive/start|cancel|forget` drive the real PCs.
- **Task-IO:** `taskio/ask` and `taskio/eod/submit`.
- **Installer sign-in:** a successful `app/nonce` or `app/download-ticket` needs a real Google sign-in.

Only the refusals of some of these are tested (folders 2 and 3).

## Setup

### 1. Get Postman

Install the Postman **desktop app** (postman.com/downloads). The web version can reach `localhost` only through the Postman Desktop Agent. For the live environment, either works.

### 2. Import the three files

1. In Postman: **File → Import** (or the **Import** button at the top left).
2. Drag in the three `.json` files from this `postman/` folder.
3. You now have the collection **ArchViz Launcher API** and two environments.

### 3. Put in the keys

The keys are files next to `launcher-server.js` on the launcher computer: the `ProjectFiles` folder, `C:\ArchViz\ProjectFiles` on a computer set up with `INSTALL.md`.

| Environment variable | File | Opens |
|---|---|---|
| `adminKey` | `admin.key` | the admin routes (stop/start the stream, updates). **The most powerful one.** |
| `qaKey` | `qa.key` | the QA console's writes |
| `devconsoleKey` | `devconsole.key` | the Dev Console, sales, owner tasks, Task-IO, bridge |

To copy one without opening it, run this in PowerShell in that folder (it pastes cleanly, with no line break at the end):

```powershell
(Get-Content .\devconsole.key -Raw).Trim() | Set-Clipboard
```

Then in Postman:

1. **Environments** (left sidebar) → **ArchViz Launcher · live**.
2. Paste each key into the **Current value** column, **not** Initial value. Current values stay on your computer. Initial values are uploaded to your Postman account and shared with anyone in the workspace.
3. The key variables are already of type *secret*, so they show as dots.
4. **Save**.

You only need the keys for the folders you run. A missing key just makes that folder's tests fail with 401.

To test one computer directly, not whichever one the public address picks, set `baseUrl` to its own address: `https://nh-internal.g-741studio.com` (main) or `https://oh-internal.g-741studio.com` (backup). See `INSTALL.md`.

### 4. Run it

1. Pick the environment in the drop-down at the top right.
2. Click the collection → **Run** (or the **⋯** menu → **Run collection**).
3. Leave every folder ticked, or untick the ones you don't need. Click **Run ArchViz Launcher API**.
4. Each request shows its tests passing or failing. Click a request to see what was sent and received.

You can also open any single request and press **Send**. Its results are in the **Test Results** tab under the response.

**What a good run against the live launcher looks like:** 54 requests, all green. Folders 7–12 send nothing, and the Postman console (bottom bar) shows `Skipped, allowWrites is not true` for each of their requests.

### 5. Run the writes against a test launcher (optional)

The local environment is for a launcher you can throw away, with its own keys and data. Port 3000 is fixed in `launcher-server.js`, so it can't run on the same PC as the real launcher. Use another computer with Node 18+:

```powershell
git clone https://github.com/ErickGalvez/archviz-launcher-infra.git launcher-test
```
```powershell
cd launcher-test
```
```powershell
node launcher-server.js
```

On its first start it creates its own `admin.key`, `qa.key` and `devconsole.key` in that folder. Put those into **ArchViz Launcher · local** (step 3), pick that environment and run the whole collection: 112 requests, 435 tests. Delete the folder when you're done.

## Running from the command line (Newman)

Newman is Postman's command-line runner. The same files work. Put the keys in with `--env-var` rather than saving them in a file:

```bash
npx newman@6 run postman/archviz-launcher.postman_collection.json -e postman/live.postman_environment.json --env-var adminKey=... --env-var qaKey=... --env-var devconsoleKey=...
```

For a test launcher, use `-e postman/local.postman_environment.json` instead.

For an HTML report, add the `htmlextra` reporter. The `skip` options keep the keys out of the report, which would otherwise show them in every request's headers:

```bash
npx -p newman@6 -p newman-reporter-htmlextra@1 newman run postman/archviz-launcher.postman_collection.json -e postman/live.postman_environment.json --env-var adminKey=... --env-var qaKey=... --env-var devconsoleKey=... -r cli,htmlextra --reporter-htmlextra-export api-report.html --reporter-htmlextra-skipHeaders "x-admin-key,x-qa-key,x-devconsole-key" --reporter-htmlextra-skipEnvironmentVars "adminKey,qaKey,devconsoleKey"
```

Newman exits with 1 when any test fails, so it can gate a script or a CI job.

## When something fails

| You see | It means |
|---|---|
| `No environment selected` | Pick an environment at the top right. |
| 401 on a whole folder | That key is missing or wrong. A key copied with a line break fails too: use the PowerShell line above. |
| 503 `no bridge key yet` on bridge, queue, routines or archive | That computer has no bridge set up. The tests accept this; it is only an error on PC-1. |
| `answers within … ms` fails on live | The tunnel was slow. Run it again. If it keeps happening, check the PC. |
| Cloudflare page (403, 1020) instead of JSON | Cloudflare blocked the request before it reached the launcher. Check the WAF rules for `api.g-741studio.com`. |
| A write folder fails halfway | Its test record may be left behind. They are all named `[Postman] …`, so they are easy to find and delete in the QA console or the Dev Console. |

## Changing the collection

The `.json` files are the source. Edit them in Postman, then **⋯ → Export** (Collection v2.1) over `archviz-launcher.postman_collection.json` and commit it. When a route changes in `launcher-server.js` or `bridge/index.js`, run the collection against a test launcher before merging.
