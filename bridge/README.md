# G741 bridge — two PCs, one pool

Lets the PCs on your network work as one pool. It coordinates **two kinds of work**:

1. **Client rendering** — the live UE5 walkthrough a visitor is streaming (this always wins).
2. **AI role work** — the nightly routines and the "ask a role" tasks, run on local models.

A PC does one or the other, never both. A PC that is rendering a client (or that you reserved for rendering) does no AI
work and its model is unloaded; the other PC takes **all** the AI work, in either direction. The turn system serves one
client at a time, so one PC is always free and the pool can't be overloaded. If every PC is busy, tasks wait in the queue —
nothing is dropped and nothing falls back to the cloud.

```
 PC-1 (launcher host)            PC-2
 ┌──────────────────────┐        ┌──────────────────────┐
 │ launcher-server.js   │        │ node-agent.js :7411  │◄─┐
 │  └ bridge/ (hub,     │        │  └ model-supervisor  │  │ signed requests (HMAC), LAN only
 │    dispatcher,       ├─ HTTP ─►                      │  │
 │    routines, Task-IO)│◄───────┼── UDP beacons :7412 ──┼──┘ discovery
 │ node-agent.js :7411  │        │ llama-server :8097   │
 │ llama-server :8097   │        └──────────────────────┘
 └─────────▲────────────┘
           │ https (Cloudflare tunnel, Dev Console key)
      hub apps: Devices · Task-IO · Virtual Team
```

* **Node agent** (`node-agent.js`) runs on **every** PC, including the launcher host. It reports CPU / RAM / GPU / VRAM,
  detects whether this PC is rendering, runs jobs, and its **model supervisor** loads/unloads this PC's one local model.
* **Hub + dispatcher** (`hub.js`, `dispatcher.js`, inside the launcher) poll the agents and hand each queued task to a PC
  that is free for AI work: one job per PC at a time, a task on a PC that starts rendering moves to the other PC.
* **Routines** (`routines.js`) are what the roles do on their own each night (below).
* **Task-IO** (`taskio.js`) keeps each day's tasks (explicit + derived from real activity), results, proposals and EOD reports.

## What runs when

| | Night (00:00–07:00 Mexico City) | Day |
|---|---|---|
| **Local model** | Kept loaded on every PC that isn't rendering | Loaded on demand, unloaded after 15 idle minutes |
| **Routine tasks** | Run (each routine once per night, weekly ones once a week) | Wait for the night |
| **Tasks you ask for** (Task-IO → *Ask a role*) | Run | Run (model loads first if needed) |
| **A client starts a session on a PC** | That PC unloads its model before UE5 starts; the other PC carries on | same |

The window is `nightly` in each PC's `bridge-node.json` (when its model stays loaded) and in `bridge.json` next to `launcher-server.js` (when routines are written); both default to 00:00–07:00 Mexico City (`start`, `end`, `tz` minutes from UTC, `enabled`), crossing midnight is fine. Change both if you change one.

### The routines

| Routine | Role | Where | Produces |
|---|---|---|---|
| Pipeline review | Nadia (sales) | local | draft in Task-IO |
| Campaign ideas | Talia (marketing) | local | draft |
| Security digest | Ward | local | draft |
| Daily brief | Morgan (management) | local | draft |
| Strategy questions | Orion | local | draft |
| Compliance checklist | Ximena | local | advisory draft |
| Policy watch | Justine (legal) | local | advisory draft |
| Bug regression tests | Priya (QA) | cloud | **proposal** — waits for you |
| Website backlog | Dex (Dev) | cloud | **proposal** — waits for you |

Local routines only receive data the launcher already holds, with leads reduced to field names (no names, e-mails or
phones in any prompt). **Dev and QA never run on a local model**: their routines only prepare a proposal; when you approve it
on the Task-IO page it goes through the existing Dev Console dispatch (issue → pull request) and you merge. Legal,
compliance, sales, strategy, security and management are **confidential** — forced local even if `policy.js` is edited.

## Security model (read this once)

* Every request to an agent must be signed with `bridge.key` (HMAC-SHA256 over method, path, timestamp, nonce and body).
  Wrong key, bad signature, a clock more than 60 s off, or a replayed request → a bare `401`.
* An agent runs **two job types only**: a prompt for the local model, and an echo. It never runs commands, reads files or
  takes code from the network. Its fixed processes are `nvidia-smi` and the **one** model command built from *this PC's own*
  `bridge-node.json`; the network can only say "start" or "stop" that model, and a stop only ever kills the process the
  agent started itself.
* The key is created once, **never printed** (only a short fingerprint is) and **never committed**. Move it between PCs by
  hand (USB stick or a direct share). Never paste it in chat, e-mail or a repo.
* The hub only follows **private LAN addresses**. Nothing here is exposed to the internet; the hub apps reach the data
  through the launcher's existing tunnel, behind the Dev Console key.
* The second-PC installer asks before each change, pins SHA-256 checksums for what it downloads, and opens the firewall for
  the private subnet only.

## Set up PC-1 (the launcher host) — once

```
node bridge/node-agent.js --init          # creates bridge.key + bridge-node.json, prints a fingerprint (never the key)
```

Then edit `bridge/bridge-node.json` on PC-1:

* `alias` — e.g. `"PC-1 · GPU Rig"`
* `llama.exe` — path to `llama-server.exe` (e.g. `Y:\ArchVizChallenge\LocalAgents\llama.cpp\b11537\llama-server.exe`)
* `llama.model` — path to the `.gguf` (e.g. `Y:\ArchVizChallenge\LocalAgents\_downloads\Qwen3-8B-Q4_K_M.gguf`)

Start it with `bridge\start-node.bat` (restarts the agent if it exits), allow **Private networks only** in the Windows
firewall prompt, and **restart the launcher** so it loads the hub, the dispatcher and the pre-render unload hook. The hub
finds the local agent at `127.0.0.1:7411` by itself. Until `llama.exe`/`llama.model` are set, the agent works but never loads a
model (the Devices page says why).

## Add PC-2, "Frankenstein" (or any other PC) — easy steps

On **PC-1**:

```
node bridge/node-agent.js --export-bundle D:\g741-bridge-pc2
```

That makes one folder with everything the other PC needs (agent, installer, a fresh identity, the shared key). Copy the
folder to a USB stick.

On **PC-2**:

1. Copy the folder anywhere (e.g. `C:\g741-bridge`) and **delete it from the USB stick** — it contains the key.
2. Double-click **`join.bat`** and answer the questions. It: checks Node.js (offers to install), shows the key fingerprint
   (it must match PC-1's), names the PC, checks the GPU driver, gets the model (copy it from PC-1, or download from the
   official sources with your OK — checksums verified), opens the firewall for private networks only, and starts the agent
   at every logon.
3. Open **Devices** on the hub: PC-2 appears within ~10 seconds and takes AI work whenever PC-1 renders (and the other way round).

To see what the installer would do without changing anything: `join.bat -DryRun`. To reuse files already on that PC:
`join.bat -LlamaExe <path> -ModelFile <path>`; to skip the model: `-NoModel`; to answer yes to every question: `-Yes`.

If the two PCs are on different subnets, or broadcast is blocked, add PC-2 by address on PC-1 in `bridge.json` (next to `launcher-server.js`):
`{ "local": "127.0.0.1:7411", "peers": ["192.168.100.45:7411"] }`.

PC-2 needs no UE5. To let PC-2 also host a *client session* it would additionally need the UE5 build, Wilbur and its own
tunnel — that is not part of this bridge; today PC-2 is the AI worker while PC-1 streams, and takes over all AI work if you
reserve PC-1 for rendering.

## Using it (Devices page)

* **Coordination banner** — says who is rendering and who carries the AI work.
* **Reserve for rendering** — keeps a PC free for a client (its model unloads and it gets no AI work) until you un-reserve it.
* **Load / unload model** — manual control; *Unload* is honoured for an hour even at night.
* **Queue** — what's waiting, running or done, and where. **Routines** — run one now, or switch one off.

## The local model on each PC

One `llama-server` per PC (default port **8097**), shared by all that PC's roles (one GPU = one inference at a time). The
supervisor starts it with `-m <model> --host 127.0.0.1 --port 8097 -c 16384 -ngl 99 --jinja -fa on`. It never starts a model
that something else already runs and never kills one it didn't start.

## A one-off nightly through the Claude / GitHub lane

`node bridge/nightly-once.js --date 2026-10-14` runs ONE night with the cloud roles only (QA and Dev) using what already exists, and logs it so the Virtual Team replay shows it:

* **00:05** Otto runs the automated checks (`devconsole/smoke-test.js --record`, written to `autotest-runs.jsonl`).
  Priya sends a QA brief and Dex a Dev brief through the Dev Console (`/api/devconsole/dispatch`: issue, then pull request). It only ever targets the `website` repo, the Dev Console's only target.
* It follows both issues until a pull request appears (every 10 min until 06:30) and records the links.
* **06:35** Otto runs the checks again. **07:00** Morgan closes the night with an EOD snapshot (`taskio-eod.jsonl`).

Nothing is merged, sent or deployed: the pull requests wait for you. It is safe to re-run (dispatches are remembered in `nightly-<date>.state.json`) and is logged to `nightly-<date>.log`, Task-IO and the EOD. The replay needs the launcher running the bridge (a restart) so it can serve `/api/taskio`.
It was scheduled with a self-deleting Task Scheduler entry (`G741-Nightly-Once-<date>`).

## Tests

```
node bridge/bridge.test.js        # 28 checks: signing, replay, routing, two agents + hub, Task-IO
node bridge/coordinator.test.js   # 33 checks: render awareness, nightly model, dispatcher, routines, hostile input, installer
node bridge/nightly.test.js       # 7 checks: the one-off cloud-lane nightly against a mock launcher
node bridge/bridge.mutation.js    # breaks 41 protections one at a time and requires the tests to notice (ONLY="text" runs a subset)
node bridge/demo-server.js        # two SIMULATED PCs + sample data on http://127.0.0.1:8791, to preview the pages
```

The same suites run in the ARCHVIZ infra map (`bridge-selftest`). The demo server is for previewing only. In the browser console of a
page served from `localhost`:
`localStorage.setItem('g741-api-override','http://127.0.0.1:8791'); localStorage.setItem('devconsole-key','demo-key')`
(simulate a render with `POST http://127.0.0.1:8791/demo/render?pc=1&on=1`).

## Files that must stay out of git (already in `.gitignore`)

`bridge/bridge.key` · `bridge/bridge-node.json` · `bridge.json` · `bridge/bridge.json` · `bridge/bridge-node-state.json` · `bridge-aliases.json` ·
`bridge-reserved.json` · `routines-state.json` · `taskio-tasks.jsonl` · `taskio-eod.jsonl` · `bridge/dl|llama|models/`
