# Hex, the red team

Hex is the studio's pen tester. Every day he attacks a **throwaway, contained copy** of the launcher with a different attack, keeps what he finds
classified, and gives you one cybersecurity lesson, basics first. He sits on the engineering bench in the 3D office, next to Ward (who audits
the real configuration). Ward watches the doors; Hex tries them.

## Containment (why he cannot hurt anything)

| Wall | Where | What it does |
|---|---|---|
| A copy, not the real thing | `sandbox.js` | Copies only `launcher-server.js` and the modules it `require`s (plus the admin page) into a temp folder. Never a `.key`, a `.json`/`.jsonl` data file, a log, the owner's tasks or the sales data. The copy makes its own throwaway keys. |
| Its own address | `sandbox.js` | Loopback only, on a random port. Refuses port 3000 (the live launcher) and refuses to build inside the launcher folder. |
| No processes | `sandbox.js` + `guard.js` | The copy's `child_process` line is replaced with a stub (as the test harness does), and the guard replaces `child_process` and `worker_threads` again. |
| Files stay in the folder | `guard.js` | Every read and write outside the temp folder is refused, so a path-traversal bug cannot reach the real launcher, a key or anything else. |
| Nothing leaves the machine | `guard.js` | No connection except loopback, no DNS, no UDP. A server-side request forgery bug cannot leave the PC. |
| Budgets | `range.js` | At most 3,000 requests and 8 minutes per run. Every request goes through one function that refuses any address but the range's own. |
| Nothing left behind | `sandbox.js` | The copy is killed and its folder deleted after each run. |
| Not during a walkthrough | `range.js` | A scheduled run is skipped while `ArchVizProject3.exe` is running. |
| Classified results | `store.js`, `bridge/index.js` | Results stay in `redteam-data/` (gitignored: this repo is public). The launcher serves them only with the Dev Console key, with `Cache-Control: no-store`. They never go to Task-IO, GitHub or a cloud model. |
| Autopilot | `bridge/agents.js` | When Hex's autopilot is off, the scheduled run does nothing. `--now` still runs. |

Every refusal by the guard is reported. If the copy **tried** to reach the network or a file outside its folder during an attack, that is a
finding, even though the guard stopped it.

## Run it

```
node redteam/range.js                 # today's attack
node redteam/range.js --now           # even if autopilot is off or a walkthrough is streaming
node redteam/range.js --attack ssrf   # a chosen attack
node redteam/range.js --list          # the 15 attacks, in the order the days follow
```

Schedule it once on PC-1, after this is merged and the launcher folder has it (daily at 04:30, as you, no elevation):

```
schtasks /Create /TN "G741-RedTeam-Range" /SC DAILY /ST 04:30 /TR "\"C:\Program Files\nodejs\node.exe\" \"Y:\ArchVizChallenge\UE5ProjectV2\ProjectFiles\redteam\range.js\"" /F
```

## The attacks (one a day, in this order)

auth-sweep · key-confusion · brute-force · path-traversal · stored-injection · proto-pollution · ssrf · body-limits · method-tamper · cors ·
info-leak · sessions · idor · prompt-injection · secret-scan. Each is in `attacks.js` with a one-line summary. Each run is compared with the
last run of the same attack, so every finding is marked **new**, **still open** or **fixed**.

A route that answers without a key **on purpose** goes in `PUBLIC` (no mention) or `BY_DESIGN` (mentioned, with why) in `attacks.js`.
Anything else that answers without a key is a finding.

## The course

28 lessons in four weeks (`lessons.js`): how attackers think, web attacks, identity, then infrastructure and AI. A new lesson opens each day,
but never more than one ahead of what you have read, so they do not pile up. Each lesson is tied to the attack that shows it, and shows what
happened the last time Hex ran it against our own code. The quiz answer is revealed once you answer.

## Routes (Dev Console key)

| Route | |
|---|---|
| `GET /api/redteam/status` | the last run, today's attack and lesson, the attack list |
| `GET /api/redteam/runs?limit=` · `GET /api/redteam/run?id=` | run summaries · one run in full |
| `GET /api/redteam/lessons` · `GET /api/redteam/lesson?n=` | the course · one open lesson |
| `POST /api/redteam/lesson/read {n, answer}` | answer the quiz and mark it read |

## Tests

`node redteam/redteam.test.js` (53 checks: the guard, the sandbox, the course, the routes, a whole run) and `node redteam/redteam.mutation.js`
(breaks each protection on purpose and requires the tests to notice).
