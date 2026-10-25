# Audit: Server monitoring   2026-10-24

Scope:        Backend check pipeline, alerting and incidents, server CRUD / plan limits / API. Repo `Ping-Pilott-Backend`.
              Web (`PingPilot2`) and mobile (`PingPilot-Mobile`) were read only to see how they consume monitoring data.
Reason:       Tech debt / rebuild check, no code changes requested.
Method:       Full pass over 11 lenses, code and local logs only. Browser walkthrough: no. Read-only data checks: no (see Not covered).
Baseline:     No spec, plan or earlier audit exists (`docs/` did not exist). Compared against in-code comments and `.env.example`.

Note on guardrails: the shared `pms-guardrails.md` describes PowerMySport. It does not apply to Ping Pilott and was ignored on the owner's say. The read-only rule was kept.

## Summary

The pipeline is better built than most at this size: scheduling is idempotent per minute, status writes are compare-and-set, incidents have a uniqueness guarantee, and the SSRF guard works at three layers. The weak point is what happens when something goes wrong. An alert is a one-shot event that gives up after about 6 seconds of retries, the health endpoint cannot tell whether checks are actually running, and the logger throws away the error details that would show either problem. Separately, `.env` was tracked in 11 commits on a GitHub remote.

Fix first: F1, F2, F3, F4.

| Severity | Count |
|---|---|
| S1 | 0 |
| S2 | 3 |
| S3 | 9 |
| S4 | 3 |
| Questions | 8 |

## Fix first
1. F3 Secrets were committed to git history (S2, M). Rotate before anything else; cost is low, exposure is open-ended.
2. F1 Alert delivery is one-shot and gives up after about 6 seconds (S2, M)
3. F2 Health and the watchdog prove the dispatcher runs, not that checks run (S2, M)
4. F4 Logger drops every error detail and floods on Redis loss (S3, S). Small change, and it makes F1 and F2 visible.

## Feature map

**Flow (user).** Create a server (`POST /api/servers`, Zod plus express-validator, plan limits, SSRF pre-check, duplicate-URL check, 2-day trial stamp for the free plan) -> scheduler queues checks -> worker checks and records -> status change opens or closes an incident and queues an alert -> email, webhook, in-app feed (`alert:new` socket event) and live status (`server:update`). Users can also check by hand (`POST /:id/check`, `/batch-check`), read history (`/history`) and incidents (`/api/incidents`) and alerts (`/api/alerts`).

**Pipeline.**
- `tasks/index.js`: node-cron every minute (or every 3 minutes when `SMART_MONITORING_ENABLED` is not `true`) runs `smartCheckServers` through `utils/jobQueue.js` (single-flight lock, 2 minute timeout) and `tasks/schedulerWatchdog.js` (stall detector).
- `tasks/checkServers.js`: loads servers with `nextCheckAt` null or past, filters by trial and day/hour window in memory, adds one BullMQ job per server with id `check-<id>-<tick>`, then books `nextCheckAt = tick + frequency`.
- `workers/monitorWorker.js`: concurrency 50, 100 jobs per second, skips jobs older than 10 minutes, re-checks a first up->down failure after 10 s, applies the result, buffers history in batches of 100 / 5 s.
- `services/monitoringService.js`: HEAD then GET (headers only) for http/website/api, TCP connect for tcp/database, 10 s timeout, certificates not validated, private addresses blocked.
- `services/checkRecorder.js` is the single place a result is applied (worker, manual, batch). Compare-and-set on `status`, then incident, then alert queue, then Redis publish.
- `queues/alertQueue.js` + `workers/alertWorker.js`: 3 attempts, email then webhook then `AlertEvent` row then Redis publish to the API process's sockets.

**API.** All `/api/servers` routes behind `protect`; every by-id handler compares `uploadedBy` to the caller (admin exempt). `/api/incidents` and `/api/alerts` always filter by the session user. Sockets authenticate the JWT and join `user:<id>` rooms only.

**Data.** `Server` (schedule, status, `nextCheckAt`, `slowAlerted`, contacts), `ServerCheck` (time-series, TTL index 30 days, nightly job deletes older than `CHECK_DATA_RETENTION_DAYS`, default 7), `Incident` (partial unique index on open, 90 day TTL), `AlertEvent` (90 day TTL), `CronJob` (14 day TTL).

**Background work.** Midnight retention job (selective by default), 15 minute system health log, startup incident reconcile. Deployed as API + monitor-worker + alert-worker (compose, PM2) or all in one process (`RUN_WORKERS` default true).

**Surfaces.** Web dashboard (socket plus 60 s polling), admin analytics (uptime is `null` with no data), mobile (socket, Android foreground service, local notifications through notifee).

**Neighbour.** No sibling feature. The incidents and alert-feed code is the newest and best-tested part, so it was used as the baseline for "how this repo does it well".

## Drift from spec

No spec exists, so this compares code with its own comments and `.env.example`.
- `.env.example` and `tasks/index.js` describe "smart" adaptive monitoring with peak, normal and quiet intervals. The interval is computed and never used; the real cadence is each server's own frequency (F6).
- `getCleanupRecommendations` says selective "keeps last 24 hours" (`tasks/dataRetention.js:249`); the code keeps 7 days by default.
- `ServerCheck` model comment promises a 30 day TTL; the nightly job deletes at 7 days by default (F11).
- `incidentAction` comment says an incident ends when status becomes `unknown` "when checking stops". Nothing ever sets `unknown` after creation (F5).
- UI offers a phone-call alert channel; the form text says calls are not sent yet. Honest, but the numbers are stored and the `phone` flag is validated for nothing (F13).

## Findings

### F1. Alert delivery is one-shot and gives up after about 6 seconds   [S2 | M | Confirmed]

Where:     `queues/alertQueue.js:12-18`, `workers/alertWorker.js:90-95`, `services/checkRecorder.js:55-68`, `services/alertService.js:44-75,104-118`
Lens:      Correctness; Observability and operations
Scenario:  A server goes down while SMTP is slow or refusing for more than about 30 seconds. The status is already saved as `down`, the alert job fails 3 times and is dropped, and every later check is down->down, which never alerts. The owner is never told. The same happens if Redis blips between the status write and `addAlertToQueue`.
Evidence:
- Queue default backoff is `{ type: 'exponential', delay: 2000 }` with 3 attempts: waits of 2 s and 4 s. The custom `backoffStrategy` in the worker (`alertWorker.js:90-95`) is dead: in BullMQ 5.67.1 `lookupStrategy` returns the built-in when the type is `exponential` (`node_modules/bullmq/dist/cjs/classes/backoffs.js`).
- `checkRecorder.js:65-67`: a failed `addAlertToQueue` only logs. The status update at line 46 is already committed.
- Failed jobs are kept 24 h (`removeOnFail`) but nothing reads them and nothing raises an alarm.
- Webhook failures are swallowed (`alertService.js:71-74`) and `handleAlerts` still returns `delivered = true`. There is no retry and no payload signature.
- Alert job id is `alert-<server>-<Date.now()>`, so the same event queued twice is two emails.
Impact:    Any customer, any outage that coincides with an email provider or Redis problem. Silent, so it will not be reported by users until it has cost one of them an outage.
Fix:       Make "owner has been told about this incident" durable state (for example `alertedAt` on the open `Incident`) and have the alert job set it only after a channel succeeds. Use the built-in exponential backoff with a longer base and more attempts (minutes, not seconds), retry the webhook inside the job with per-channel done flags so a retry does not resend the email, use an idempotent job id (`alert-<incidentId>-<type>`), and log an error with ids when the last attempt fails. Delete the dead `backoffStrategy`.
Test:      `checkRecorder`: queue add rejects -> alert is marked pending and retried. `alertWorker`: email fails twice then succeeds -> one email, one `AlertEvent`.
Risk:      Duplicate emails if the job id and per-channel flags are not done together. Adds one field on `Incident`; no migration needed (missing means not alerted).

### F2. Health and the watchdog prove the dispatcher runs, not that checks run   [S2 | M | Confirmed]

Where:     `index.js:124-157`, `tasks/schedulerWatchdog.js`, `tasks/checkServers.js:55-58`, `utils/jobQueue.js:114`, `docker-compose.yml:28-32`
Lens:      Observability and operations
Scenario (a): The monitor worker is dead, crash-looping, or cannot reach Mongo. The scheduler keeps queueing jobs, `/health` returns 200 `healthy`, the compose healthcheck is green, nobody is checked and nobody is alerted.
Scenario (b): Mongo or Redis is down. `checkAllServersIntelligently` catches the error and returns `{ error }`; `jobQueue.execute` treats that as success and sets `lastRun`, so the watchdog reports `ok` for as long as the process is up. `dispatched < total` (queue adds failing) is also invisible.
Evidence:
- `/health` checks Mongo ping, Redis ping and scheduler state only. The worker has no heartbeat, no queue depth and no age of the oldest waiting job; `monitor-worker` and `alert-worker` services have no healthcheck.
- The repo's own history describes this failure: commit `8c196e8` ("workers died on start... the scheduler still queued checks, so logs looked healthy while nothing ever ran them").
- Local `logs/combined.log`: 81 worker failures `The uri parameter to openUri() must be a string, got "undefined"` (2026-01-26) retried and forgotten; 126 "Skipping stale check job" lines, one set for jobs queued 75 days earlier. Both were visible only by reading the log.
- Nothing outside the process watches the monitor. If the host dies, no one is told.
Impact:    All customers at once, for as long as it takes someone to notice. This is the failure a monitoring product cannot have quietly.
Fix:       Record the time the last check completed (a Redis key set by the worker) and report it, plus `monitorQueue.getJobCounts()` and the age of the oldest waiting job, in `/health`; go `degraded` when no check has completed for about twice the shortest due frequency or the oldest job is over the stale limit. Let the scheduler throw (or return a failure the queue treats as failed) when the whole cycle fails. Add a worker healthcheck. Send a heartbeat to an outside dead-man's-switch service on each successful cycle.
Test:      `evaluateScheduler`-style pure function for the new health rule; scheduler cycle that fails must not update `lastRun`.
Risk:      Health going `degraded` makes the load balancer drop the API; keep worker staleness separate from API readiness (report it, do not 503 on it) unless that is wanted.

### F3. Secrets were committed to git history   [S2 | M | Confirmed that they were tracked; impact depends on repo visibility]

Where:     `git log --all -- .env` (11 commits, ended by `6fafbec`); remote `origin` is a GitHub URL (`Jatin-1111/Ping-Pilott-Backend`); `Jenkinsfile` clones the same URL.
Lens:      Security and privacy
Scenario:  Anyone with read access to the repository can check out an old commit and read the `.env` of that time. Untracking the file does not remove it from history.
Evidence:  The last tracked `.env` (`6fafbec^`) contains these keys: `MONGO_URI`, `JWT_SECRET`, `JWT_REFRESH_SECRET`, `SMTP_USER`, `SMTP_PASSWORD`, `ADMIN_SETUP_TOKEN`. Values were deliberately not read. Whether the values are real production ones, and whether the repo is public, was not checked.
Impact:    If any value is live, a forged JWT, mailbox abuse, database access and admin bootstrap are possible. S1 if the repository is public and the values are current.
Fix:       Check the repo's visibility. Rotate all six values (new JWT secrets sign everyone out; plan for that). Then decide whether to rewrite history; rotation matters more than the rewrite.
Test:      None; operational.
Risk:      Rotating `JWT_SECRET` invalidates sessions for web and mobile. `ADMIN_SETUP_TOKEN` is used by `scripts/createAdmin.js`.

### F4. The logger drops every error detail and floods on Redis loss   [S3 | S | Confirmed]

Where:     `utils/logger.js:37-43`; callers such as `config/redis.js:14`, `queues/monitorQueue.js:58`, `workers/alertWorker.js:79,105,109`, `tasks/index.js:228-231,124-128`
Lens:      Observability and operations
Scenario:  Redis goes away. The log fills with `❌ Redis connection error:` and nothing after the colon, so the cause (refused, auth, DNS, TLS) is not in the log. A health warning reads `System health issues detected:` and the issues list is not printed.
Evidence:
- The `printf` prints `timestamp level: message` and ignores extra arguments and metadata; there is no `format.splat()` and no `format.errors({ stack: true })`.
- `logs/combined.log`: `Redis connection error:` 2,440 times and `Monitor Queue Error:` 466 times, all blank; `System health issues detected:` 4 times, issues missing; midnight cleanup stats are also never printed.
- Each 5 MB file rotates (`maxFiles: 5`), so a Redis outage of a few hours rotates the useful lines away.
- `colorize({ all: true })` sits in the shared format, so ANSI codes are written into the files (24,611 lines in `combined.log`). Anything that parses or greps those files has to strip them.
Impact:    Every incident investigation, including the ones F1 and F2 would otherwise make visible.
Fix:       Add `format.errors({ stack: true })`, `format.splat()` and print metadata (JSON is simplest); colourise the console transport only; log repeated Redis errors at most once per interval.
Test:      A logger unit test that `logger.error('x', new Error('boom'))` contains `boom`.
Risk:      Metadata can carry PII or secrets (see F8). Do the F8 clean-up in the same slice.

### F5. Servers that stop being checked keep their last status and an open incident, and are re-read every minute   [S3 (arguably S2) | M | Confirmed]

Where:     `tasks/checkServers.js:65-105`, `services/incidentService.js:12-22`, `models/Incident.js:36-45`, `services/planService.js:46-52`
Lens:      Correctness; Data and scale
Scenario:  A free-plan server goes down on the last day of its 2-day trial. Checking stops (trial gate). Status stays `down`, the incident stays `open` for ever (no TTL applies without `endedAt`), the Incidents page shows it as ongoing with growing downtime, and the dashboard shows red for a server nobody checks. A server that was `up` shows green for ever. The same holds for servers outside their day/hour window, overnight.
Evidence:
- Nothing sets `status: 'unknown'` after creation (searched; only the schema default and the create call). The `incidentAction` comment describes it.
- `getDueServers` returns every server whose `nextCheckAt` is null or past, then drops expired and out-of-window ones in memory. For those, `nextCheckAt` never advances, so each of them is loaded every minute for ever. Expired free-trial servers only accumulate.
- The web has `TrialNotice.js`; the mobile app has no trial handling (only the type field); there is no email or push when monitoring stops.
Impact:    Wrong data shown as live, misleading incident totals, and a scheduler read that grows with signups.
Fix:       When a server is skipped by the trial gate, set status `unknown`, close its incident, and move `nextCheckAt` out (or filter trial-expired servers in the query). For window gaps decide the display (show "paused" rather than the old status). Tell the owner when the trial ends.
Test:      `shouldMonitorServer` expired trial -> status transitions to `unknown` and incident closes; due query excludes expired trials.
Risk:      Needs the product answer in Q4. A status migration for servers already stuck (count first; see Not covered).

### F6. Check frequency silently falls back to 3 minutes, and the "smart" code is dead   [S3 | S | Confirmed in code; production value Plausible]

Where:     `tasks/index.js:32,183-217,254-265`
Lens:      Correctness; Dead code
Scenario:  `SMART_MONITORING_ENABLED` is unset or anything other than `true`. The scheduler runs every 3 minutes, so a paid user's 1-minute and 2-minute monitors are checked every 3 minutes with no sign of it.
Evidence:  `SMART_MONITORING_ENABLED: process.env.SMART_MONITORING_ENABLED === 'true'`. In the adaptive branch the peak/normal/quiet value is only logged; `shouldRunAdaptiveCheck` (line 254) has no caller; `PEAK_HOURS_*` therefore do nothing; the hour logic reads the host's local time. The local `.env` has the key set; the production value was not seen.
Impact:    Plan promise (`minCheckFrequency`) not met if the production env lacks the key.
Fix:       Always run the 1-minute cron. Delete the basic and adaptive branches, `shouldRunAdaptiveCheck`, `logCleanupRecommendations`, and the `PEAK_HOURS_*` / `SMART_MONITORING_ENABLED` / `MAX_CONCURRENT_CHECKS` variables.
Test:      A scheduler test that a 1-minute server is due every tick.
Risk:      More load if production was on the 3 minute path; check worker capacity first (F10).

### F7. Manual, batch and first-ever checks skip the down confirmation, and all of them count in uptime   [S3 | S | Confirmed]

Where:     `controllers/serverController.js:869-882,1751-1763`, `workers/monitorWorker.js:83-86`, history aggregate `serverController.js:1052-1100`
Lens:      Correctness
Scenario:  A user presses "Check now" during a one-packet loss. `applyCheckResult` flips the server to down and queues a DOWN email at once; the worker's 10 s confirmation exists only on the scheduled path. A brand-new server has status `unknown`, so its first scheduled failure also skips confirmation (the worker confirms only when `server.status === 'up'`).
Evidence:  As cited. Uptime is `upChecks / totalChecks` over all rows, including `manual` and `batch` types, with no `checkType` filter, so repeated manual checks during an outage move the percentage.
Impact:    False DOWN emails and a skewed uptime figure.
Fix:       One shared `runCheck(server)` used by the worker and the controllers, with the confirmation, and confirm on any `previous !== 'down'` result. Compute uptime from `automated` checks only.
Test:      Controller check with a failing target on an `up` server does not alert until the second failure.
Risk:      Manual check responses take 10 s longer when the first attempt fails.

### F8. Secrets in webhook URLs and connection strings are logged, stored and emailed   [S3 | S | Confirmed]

Where:     `services/alertService.js:49`, `services/monitoringService.js:72-84`, `controllers/serverController.js:1589-1605`, `services/emailService.js:136`, `workers/alertWorker.js:58`
Lens:      Security and privacy
Scenario (a): Slack, Discord and Teams webhook URLs are bearer secrets. `logger.info('Sending webhook ... to ${webhookUrl}')` writes the full URL to `combined.log` on every alert.
Scenario (b): A user adds a `database` monitor and pastes `postgres://app:password@db.example.com:5432/prod`. `parseTcpTarget` accepts the scheme form on purpose. `normalizeUrl` only strips `https://` and a trailing slash, so the credentials are stored in `Server.url`, then appear in every alert email to up to 5 recipients, in `AlertEvent.serverUrl`, in the webhook payload, in the mobile feed and in the admin list.
Evidence:  As cited; no code strips userinfo. Local logs contain no webhook lines (the dev setup never used one), so (a) is proven from code only.
Impact:    Credential exposure for any user who does this, and a secret in plain logs for every webhook user.
Fix:       Reject any monitored address that contains userinfo (Zod `refine` on create and update), and log only the webhook host.
Test:      Create with `postgres://u:p@host:5432/db` -> 400; webhook log line contains no path or query.
Risk:      Existing rows may already hold credentials; count them before and tell those users (needs your decision).

### F9. Alert emails go to unconfirmed addresses, with no unsubscribe, and expose all recipients to each other   [S3 | M | Confirmed; needs legal review]

Where:     `controllers/serverController.js:1660-1668`, `services/emailService.js:86-97`, templates `emailService.js:127-205`
Lens:      Security and privacy; Legal and consent
Scenario:  A user lists a third party's address as a contact on a server they control and makes it flap. That person receives repeated DOWN/RESOLVED mail from the platform's sender, with no way to opt out. Separately, when a server has several contacts, one message is sent with all of them in `to:`, so each recipient sees the others' addresses.
Evidence:  `to: toEmails` joins up to 5 addresses; templates have no unsubscribe or "why am I getting this" line; no step confirms the contact owns the address.
Impact:    Abuse of the platform's sending reputation; a consent and privacy question.
Fix:       Send one message per recipient (or use BCC), add a line saying who set up the monitor, and confirm a new contact address before it can receive alerts.
Test:      Two contacts -> two sends, each with one `to`.
Risk:      Confirmation flow is new work (see Q-level scope); per-recipient sends multiply SMTP volume by up to 5.

### F10. Mass failure: one vantage point and a worker that collapses under many slow targets   [S3 | M | Plausible]

Where:     `workers/monitorWorker.js:55-112`, `workers/alertWorker.js:83-96`
Lens:      Data and scale; Correctness
Scenario:  The worker host loses its own outbound network for two minutes. Every due server is judged down; the 10 s confirmation fails too; hundreds of DOWN alerts are queued at once and a matching set of recoveries follows. Separately, with many dead targets each check can hold one of the 50 slots for 10 s (or 30 s with confirmation), so per instance throughput can fall to roughly 100 to 300 checks per minute. Jobs older than 10 minutes are then skipped, leaving gaps.
Evidence:  Arithmetic from the constants (50 slots, 10 s HTTP timeout, 10 s confirmation sleep inside the slot, 10 minute stale limit). Not measured.
Impact:    A burst of false alerts, and silent gaps under load. Becomes real when customers or dead targets grow.
Fix:       Hold alerts when a large share of one cycle fails together and recheck from a control target; do the confirmation as a delayed job instead of sleeping in a slot; export a "skipped as stale" counter. This is partly a design call (Q1).
Test:      Worker with a stubbed checker: 90% failures in one cycle -> no per-server alert.
Risk:      Delays real mass outages slightly.

### F11. Retention: default 7 days against a 30 day history, and a TTL index on a time-series field   [S3 | M | Confirmed defaults; TTL behaviour Plausible]

Where:     `models/ServerCheck.js:35-50`, `tasks/dataRetention.js:114,132-135,249`, `controllers/serverController.js:1712`
Lens:      Data and scale
Scenario:  The UI offers `30d`; `CHECK_DATA_RETENTION_DAYS` defaults to 7, so a 30-day uptime figure is the last 7 days. If the deployed server does not set it, users read a wrong number.
Evidence:  Two retention mechanisms with different lengths (TTL 30 days on the model, 7 days in the nightly job) and the model's TTL is declared as a secondary index on `timestamp`, which is the time-series `timeField`. Whether MongoDB accepted or ignored it was not checked. The nightly job uses `deleteMany` with a `timestamp` filter on the same collection. Two destructive modes (`aggressive`, `emergency`) remain as options and `aggressive` ran locally on 2026-01-26.
Impact:    Wrong long-range uptime, or unbounded growth if the TTL does not exist. Unknown without the database.
Fix:       Pick one mechanism (collection-level `expireAfterSeconds` for time-series) and one number; make the UI periods match it.
Test:      Not unit-testable; verify with `listCollections` options and `getIndexes` (see Not covered).
Risk:      Changing a time-series TTL may require recreating the collection.

### F12. The riskiest monitoring code has no tests, and CI never runs any   [S3 | M | Confirmed]

Where:     `tests/` (5 files, about 55 tests), `Jenkinsfile:23-39`
Lens:      Tests
Covered:   Job lock and timeout, watchdog, retention mode, incident rules, alert-feed formatting and controllers, Redis options.
Not covered: `checkRecorder` (compare-and-set and alert decision), `monitorWorker` (confirmation, stale skip, batching), `alertWorker`, `monitoringService` (HEAD to GET fallback, scheme fallback), `ssrfGuard` (a security boundary with many hand-written ranges), `schedule.js` (time zone and overnight windows), `getDueServers`, `planLimits`, permission-denied paths of the server controller.
Evidence:  Past runtime-only failures are in the logs: `serverId is not defined` at `serverController.js:24` and `mongoose is not defined` at `index.js:78`. The pipeline installs and builds an image but never runs `npm test` and builds on Node 18 while the Dockerfile uses Node 20.
Impact:    Regressions in alerting and SSRF protection would ship unnoticed.
Fix:       Add the tests above in the order F1, F7, `ssrfGuard`, `schedule`; run `npm test` in the pipeline on Node 20.
Test:      This is the test finding.
Risk:      None.

### F13. Dead code and misleading leftovers   [S4 | S | Confirmed]

Where and what (ask before deleting; each was checked for importers):
- `models/Server.js:209-213`: `uptime24h` virtual returns a hard-coded `99.8` ("for demonstration"). It leaks into create and update responses (they use `toObject`). No client reads it. A fake metric under your own standing ban: remove.
- `config/cron.js`, `getPerformanceConfig` (`config/performance.js`), `trackMetrics` (`middleware/performanceMonitoring.js:57`): no importers.
- `workers/alertWorker.js:34` selects `alertSettings`, a field the schema does not have.
- `GET /api/servers/:id/stats` (`serverController.js:1324-1542`): no consumer in web or mobile. It also returns 100% uptime when there is no data and groups daily and hourly buckets in UTC even though the server has a time zone.
- `migrations/001_create_indexes.js`: creates indexes on `localDate` and `localHour`, fields that no longer exist, on a time-series collection. Running it would add useless indexes.
- `scripts/migrate_monitoring_24_7.js`: rewrites every server's schedule to 24/7 and would erase custom windows if run again.
- Phone alerts: `alerts.phone` and `contactPhones` are validated and stored, nothing sends them. The UI says so; personal data is kept for a feature that does not exist.
- Two validators with different rules: route-level `express-validator` (`serverRoutes.js:32,36`) and Zod (`utils/validations.js`) disagree on phone format and the minimum `responseThreshold` (100 against 10).

### F14. Small correctness gaps in history and server edits   [S4 | S | Confirmed]

Where and what:
- `GET /:id/history?limit=-5` passes a negative `$limit` and returns 500 (`serverController.js:951`).
- `GET /api/incidents?serverId=abc` puts the raw value in the query; Mongoose throws a cast error and it surfaces as 500 (`incidentController.js:27`). Authorization is still safe because `userId` is always in the filter.
- Changing a server's URL keeps its old status and open incident until the next check.
- `getNextCheckEstimate` says "Due now" for ever for paused servers (trial or window).
- Duplicate-URL and server-limit checks read then write; two quick requests can both pass.
- `priority` is user-settable with no plan gate, so one tenant can mark everything `high` and take the top BullMQ and alert priority.
- URLs are not lower-cased before the duplicate check.

### F15. Tests write to the real log files   [S4 | S | Confirmed]

Where:     `utils/logger.js` (no silent mode), `tests/scheduler.test.js`, `tests/incidentService.test.js`
Scenario:  Running `npm test` appends test lines to `logs/combined.log` and `error.log`. The four `SCHEDULER STALLED` errors at 15:29 to 15:53 on 2026-10-24 and the `Northwind API: connection lost` lines are from tests, not from a real stall. Anyone reading those logs to judge health is misled.
Fix:       Make the logger silent when `NODE_ENV=test` or when run by the test runner.
Risk:      None.

## Questions for the owner

1. **Flapping and escalation.** There is no flap suppression, no "still down" reminder and no escalation. Is one DOWN email and then silence the intended contract?
2. **Alert hours.** An alert outside the user's alert window is dropped, not held, and no `AlertEvent` row is written (`alertService.js:25-36`, `alertWorker.js:51`). A recovery inside the window can arrive without its DOWN. Drop or defer?
3. **TCP and database checks.** Any signed-up user can make timed TCP connects to any port on any public host from your IP. The error text separates refused, timeout and reset. Should these types need a verified domain or a paid plan?
4. **Trial end.** Free monitoring stops silently after 2 days. Is that intended, and should the user be told by email and push?
5. **Mobile alerts.** Mobile has no push token and no server-side push; alerts come from a socket kept alive by an Android foreground service and raised as local notifications (`notifications.ts`, `realtime.ts`). Is iOS in scope? An iOS app that is closed cannot receive these.
6. **Subscription end.** Nothing in `tasks/` downgrades a user after `subscription.endDate` passes. Is that handled somewhere outside this repo?
7. **Retention modes.** Keep `aggressive` and `emergency` (they delete all history), or remove them and rely on one number of days?
8. **Content of checks.** Certificates are not validated by design, there is no SSL-expiry alert, no keyword check, and a 401 or 403 is "down". Are these product gaps or deliberate?

## What is solid

- Scheduling is idempotent: `check-<id>-<tick>` job ids, `nextCheckAt` booked at dispatch, and jobs over 10 minutes old are skipped (`checkServers.js`, `monitorQueue.js:32-47`, `monitorWorker.js:19-22`). This is what prevents a storm after downtime.
- One place applies a result (`checkRecorder.js`) with a compare-and-set on status, so racing checks cannot double-alert; used by worker, manual and batch.
- Incidents: partial unique index on open, duplicate-key handled, startup reconcile.
- SSRF: `safeLookup` on the connection (defeats DNS rebinding), pre-flight for IP literals, redirect hook, and the webhook client follows no redirects.
- Redis outage handling: timeouts on queue adds and cache calls, a time-limited scheduler lock, a watchdog that can release it.
- Time zone logic uses `Intl` with overnight windows and per-server zones (`schedule.js`).
- Ownership is checked on every by-id server route; incidents and alerts always filter by the session user; sockets authenticate and use per-user rooms.
- Plan limits are enforced on the server, not only in the UI.
- Alert email content is HTML-escaped. `/health` leaks no internals. Retention defaults to the safe mode and a failed cleanup no longer escalates to deleting everything.
- History batches are flushed on shutdown.

## Not covered

- **Production database and Redis.** The owner chose read-only data checks but no connection was supplied, so none were run. Checks that would settle Plausible findings: `listCollections` options and `getIndexes` on `serverchecks` (F11); oldest and newest `ServerCheck` timestamp (F11); count of free-plan servers with `monitoring.trialEndsAt` in the past, of servers with `status: 'down'` and an open incident older than 3 days (F5); count of `Server.url` values containing `@` (F8); count of `AlertEvent` rows per day against `Incident` rows per day (F1); Redis `monitor-server-queue` and `alerts` job counts and failed set (F1, F2).
- **Production env values.** `SMART_MONITORING_ENABLED`, `CHECK_DATA_RETENTION_DAYS`, `RUN_WORKERS`, `DOWN_CONFIRM_DELAY_MS` and the deployment host were not read (F6, F11).
- **Runtime.** The server, workers and any endpoint were not started or called; no email or webhook was sent; `npm test` was not run (it appends to the real log files, see F15). Throughput numbers in F10 are arithmetic, not measurements.
- **Frontends.** Web and mobile were searched for how they use monitoring data, not walked in a browser. The visual and copy lens, the `ux-heuristics` pass and `redesign-existing-projects` were not run, because the request was about server monitoring.
- **Other backend areas.** Auth, user and admin controllers, support tickets, payments, and the email verification flow were not audited. Nginx TLS settings and certificate renewal were glanced at only.
- **Security review.** A full `security-review` pass was not run (there is no diff); the security lens was done by reading the monitoring paths.

## Status log

| Finding | Status | Slice or note | Date |
|---|---|---|---|
| F1 | Fixed | Slice 3: alerts kept in a PendingAlert collection until delivered, 5 attempts over about 7 minutes then re-queued for 24 hours, per-channel retry, queue add timeout (not committed). Webhook signing not done | 2026-10-24 |
| F2 | Fixed | Slice 5: failed scheduler cycles throw, worker heartbeats and completion marker, /health shows monitoring state and /health/monitoring answers 503 when the pipeline is broken, compose worker healthchecks, optional HEARTBEAT_URL ping, /health no longer hangs when Redis is down (not committed, not run against real Redis) | 2026-10-24 |
| F3 | Open | Owner action, not code | 2026-10-24 |
| F4 | Fixed | Slice 1: logger prints errors and metadata, plain files, Redis errors throttled (not committed) | 2026-10-24 |
| F5 | Fixed | Pause and tell: expired free trials are paused every 5 minutes (status unknown, incident closed, next check moved out of the scheduler query), the owner gets one email, upgrading to a paid plan resumes them. Servers outside their day/hour window keep their last status (not committed) | 2026-10-24 |
| F6 | Fixed | Slice 2: scheduler always runs every minute, adaptive and basic branches and PEAK_HOURS_*, SMART_MONITORING_ENABLED, MAX_CONCURRENT_CHECKS removed (not committed) | 2026-10-24 |
| F7 | Fixed | Slice 4: worker, manual and batch checks share runCheck with the down confirmation (also for never-checked servers); uptime counts scheduled checks only (not committed). Manual checks now take up to 10 s longer when the first attempt fails | 2026-10-24 |
| F8 | Fixed | Slice 6: addresses with a username or password are rejected on create and update, alerts and the feed carry the masked address, the webhook log line names only the host (not committed). Rows saved earlier are not changed and were not counted | 2026-10-24 |
| F9 | Deferred | Needs legal review | 2026-10-24 |
| F10 | Fixed (partly) | A failed check is believed only while control targets answer (TCP to 1.1.1.1 and 8.8.8.8 and a DNS lookup); otherwise nothing is recorded or alerted and /health/monitoring shows egress-down. MONITOR_CONCURRENCY added, stale skips summarised once a minute. Not done: holding alerts on a mass failure (not chosen), delayed-job confirmation (not chosen) (not committed) | 2026-10-24 |
| F11 | Fixed (partly) | One rule: [update: the TTL index on the time field never existed (not accepted on a time-series collection); the model now sets a collection-level expireAfterSeconds and scripts/setRetentionTtl.js applies it to an existing collection with collMod, dry run by default. Applied and verified on the local database, and on the Atlas database (MongoDB 8.0.34, database "test", oldest check 0.4 days old, so nothing was deleted) on 2026-10-24]  checks older than CHECK_DATA_RETENTION_DAYS (default 30, at most 30) are deleted each midnight, the TTL stays as a backstop, aggressive and emergency modes removed, read-only retention check added (scripts/checkRetention.js and a start-up log line). Production state not yet seen: run the script (not committed) | 2026-10-24 |
| F12 | Accepted risk | Not chosen; each slice adds its own tests | 2026-10-24 |
| F13 | Fixed (partly) | Slice 7, each deletion confirmed: uptime24h, config/cron.js, unused performance config and trackMetrics, /stats endpoint, 001_create_indexes.js, migrate_monitoring_24_7.js removed (alertSettings went in slice 3). Left open: phone alerts still stored but never sent, and the route and Zod validators still disagree on phone format and minimum responseThreshold (not committed) | 2026-10-24 |
| F14 | Fixed (partly) | Slice 7: history limit clamped, incidents serverId validated, URL change resets status and closes the open incident, estimate says why a server is paused, host lower-cased before the duplicate check. Left open: duplicate-URL and server-limit races (a unique index needs a data check) and user-settable priority (needs a product call) (not committed) | 2026-10-24 |
| F15 | Fixed | Slice 1: logger silent under the test runner (not committed) | 2026-10-24 |
