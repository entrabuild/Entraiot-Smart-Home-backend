/**
 * ⚠️ SUPERSEDED — NOT DEPLOYED. Kept only as historical reference.
 *
 * Cloud Functions for Firebase (any generation) require the project to be
 * on the Blaze (pay-as-you-go) billing plan to deploy AT ALL, even if real
 * usage stays at zero cost — see backend/.github/workflows/deploy.yml's old
 * comment and https://firebase.google.com/docs/functions/quotas. Blaze
 * requires a credit card on file.
 *
 * To keep this project on Firebase's Spark (free, no card) plan, all five
 * functions below were reimplemented as Netlify Scheduled Functions in
 * ../../netlify/functions/ (same site that already hosts the dashboard —
 * also free, no card required). See SETUP.md Part 3 for the mapping:
 *
 *   onAlertCreated      -> netlify/functions/scheduled-tasks.mjs (poll-based)
 *   presenceCheck        -> netlify/functions/scheduled-tasks.mjs
 *   onCommandCreated     -> netlify/functions/scheduled-tasks.mjs
 *   bufferSensorReading   -> removed; the ESP32 firmware now writes directly
 *                            to homes/{homeId}/_raw/{sensor} itself (see
 *                            Entraiot_ESP32_IoT.ino's syncToCloud()) instead
 *                            of relying on a database-write trigger.
 *   aggregateTelemetry   -> netlify/functions/hourly-telemetry.mjs
 *   pruneOldData         -> netlify/functions/daily-prune.mjs
 *
 * firebase.json no longer lists a "functions" codebase, so `firebase
 * deploy` only touches database rules — it will not try to deploy this
 * file or require Blaze. This file is left in place purely so the original
 * design/logic is easy to diff against if you ever DO want to move back to
 * Cloud Functions (e.g. if you outgrow Netlify's free tier and are already
 * paying for Blaze anyway).
 */
import { initializeApp } from "firebase-admin/app";
import { getDatabase } from "firebase-admin/database";
import { getMessaging } from "firebase-admin/messaging";
import { onValueCreated, onValueWritten } from "firebase-functions/v2/database";
import { onSchedule } from "firebase-functions/v2/scheduler";
import { logger } from "firebase-functions/v2";

initializeApp();

// REGION NOTE (confirmed against Firebase docs, July 2026):
// Realtime Database only supports 3 regions ever: us-central1,
// europe-west1, asia-southeast1 (Singapore). Mumbai (asia-south1) is
// NOT and has never been a valid RTDB region — this isn't a plan
// limitation, it's a hard platform constraint. Flagged to Salvin as
// a PRD correction.
//
// Cloud Functions CAN run in Mumbai, but Google's own best practice
// is to co-locate functions with the RTDB instance they read/write
// to avoid cross-region latency + egress cost. So both functions
// below deploy to asia-southeast1 to match the RTDB instance.
//
// LOCAL EMULATOR: confirmed empirically — the emulator's database in
// "single project mode" doesn't run in a real region, so pinning a
// region blocks triggers from firing locally ("function region is
// defined outside the database region, will not trigger"). Firebase
// sets FUNCTIONS_EMULATOR=true automatically when running under the
// emulator, so we use that to skip the region locally and only apply
// it for the real cloud deploy.
const FUNCTIONS_REGION =
  process.env.FUNCTIONS_EMULATOR === "true" ? undefined : "asia-southeast1";

/**
 * onAlertCreated
 *
 * Trigger: a new alert appears at /homes/{homeId}/alerts/{alertId}
 *
 * If it's a "critical" alert:
 *  - find every member of that home
 *  - collect their FCM push tokens
 *  - send them a push notification
 *  - write a record of the delivery into /homes/{homeId}/events
 *
 * If it's "warning" or "info", we just log it quietly for now
 * (no push, to avoid spamming people with non-urgent stuff).
 */
export const onAlertCreated = onValueCreated(
  {
    ref: "/homes/{homeId}/alerts/{alertId}",
    region: FUNCTIONS_REGION,
  },
  async (event) => {
    const { homeId, alertId } = event.params;
    const alert = event.data.val();
    const db = getDatabase();

    logger.info("New alert created", { homeId, alertId, alert });

    if (alert.severity !== "critical") {
      logger.info("Non-critical alert — skipping push notification", {
        homeId,
        alertId,
        severity: alert.severity,
      });
      return;
    }

    // 1. Find every member of this home
    const membersSnap = await db.ref(`homes/${homeId}/members`).get();
    const members = membersSnap.val() || {};
    const memberUids = Object.keys(members);

    // 2. Collect their FCM tokens
    const tokens: string[] = [];
    for (const uid of memberUids) {
      const tokensSnap = await db.ref(`users/${uid}/fcmTokens`).get();
      const tokenMap = tokensSnap.val() || {};
      tokens.push(...Object.keys(tokenMap));
    }

    if (tokens.length === 0) {
      logger.warn("No FCM tokens found for any member — cannot send push", {
        homeId,
        alertId,
      });
      return;
    }

    // 3. Build and send the push notification
    const title = alertTitleFor(alert.type);
    const body = alert.msg || "Check the app for details.";

    let successCount = 0;
    let failureCount = 0;
    const invalidTokens: string[] = [];

    try {
      const response = await getMessaging().sendEachForMulticast({
        tokens,
        notification: { title, body },
        data: {
          homeId,
          alertId,
          type: String(alert.type),
          severity: String(alert.severity),
          ts: String(alert.ts),
        },
        android: { priority: "high" },
      });

      successCount = response.successCount;
      failureCount = response.failureCount;

      response.responses.forEach((r, i) => {
        if (!r.success) {
          invalidTokens.push(tokens[i]);
        }
      });
    } catch (err) {
      logger.error("Failed to send push notification", { homeId, alertId, err });
    }

    // 4. Clean up any tokens that failed (likely expired/uninstalled)
    for (const badToken of invalidTokens) {
      for (const uid of memberUids) {
        await db.ref(`users/${uid}/fcmTokens/${badToken}`).remove().catch(() => {});
      }
    }

    // 5. Record what happened
    const today = new Date().toISOString().slice(0, 10);
    await db.ref(`homes/${homeId}/events/${today}`).push({
      type: "alert_push_sent",
      detail: `Alert ${alertId}: ${successCount} sent, ${failureCount} failed`,
      ts: Date.now(),
    });

    logger.info("Push notification result", {
      homeId,
      alertId,
      successCount,
      failureCount,
    });
  }
);

function alertTitleFor(type: string): string {
  switch (type) {
    case "gas":
      return "GAS LEAK DETECTED";
    case "fire":
      return "FIRE ALERT";
    case "vibration":
      return "VIBRATION DETECTED";
    case "rain":
      return "RAIN DETECTED";
    case "offline":
      return "DEVICE OFFLINE";
    default:
      return "EntraIoT Alert";
  }
}

/**
 * presenceCheck
 *
 * Runs every 1 minute. For every home, for every controller (ESP32):
 *  - if the last heartbeat was more than 120 seconds ago AND it's
 *    currently marked "online" → flip it to "offline" and create a
 *    warning alert.
 *  - if the heartbeat is recent again AND it's currently marked
 *    "offline" → flip it back to "online" (no alert needed for that,
 *    the app can just show it came back).
 *
 * This is what lets the app tell the difference between "the fan is
 * off" (normal) and "we haven't heard from the house in 5 minutes"
 * (something's wrong).
 */
const OFFLINE_THRESHOLD_MS = 120 * 1000; // 120 seconds

export const presenceCheck = onSchedule(
  { schedule: "every 1 minutes", region: FUNCTIONS_REGION },
  async () => {
    const db = getDatabase();
    const homesSnap = await db.ref("homes").get();
    const homes = homesSnap.val() || {};

    for (const homeId of Object.keys(homes)) {
      const controllers = homes[homeId].controllers || {};

      for (const deviceId of Object.keys(controllers)) {
        const controller = controllers[deviceId];
        const heartbeatTs = controller.heartbeat?.ts || 0;
        const currentStatus = controller.status;
        const age = Date.now() - heartbeatTs;

        if (age > OFFLINE_THRESHOLD_MS && currentStatus === "online") {
          logger.info("Controller went offline", { homeId, deviceId, age });

          await db
            .ref(`homes/${homeId}/controllers/${deviceId}/status`)
            .set("offline");

          await db.ref(`homes/${homeId}/alerts`).push({
            type: "offline",
            severity: "warning",
            msg: `Controller ${deviceId} has not checked in for over 2 minutes.`,
            ts: Date.now(),
            ack: null,
          });
        } else if (
          age <= OFFLINE_THRESHOLD_MS &&
          currentStatus === "offline"
        ) {
          logger.info("Controller came back online", { homeId, deviceId, age });

          await db
            .ref(`homes/${homeId}/controllers/${deviceId}/status`)
            .set("online");
        }
      }
    }
  }
);

/**
 * bufferSensorReading
 *
 * WHY THIS EXISTS: aggregateTelemetry (below) needs to compute
 * min/max/avg/n over the past hour, but /sensors/{sensor} only ever
 * holds the LATEST reading — the ESP32 overwrites it on every
 * change, so by the time an hourly job runs, every reading except
 * the last one is already gone. This trigger fixes that gap by
 * copying every numeric sensor write into a staging path
 * (homes/{homeId}/_raw/{sensor}/{pushId}) so there's real history
 * to roll up later. This isn't one of the 5 named PRD functions —
 * it's plumbing that makes aggregateTelemetry possible. Documented
 * in rtdb-schema.md as an internal-only path (not part of the
 * frontend/firmware contract).
 *
 * Trigger: any write to /homes/{homeId}/sensors/{sensor}
 */
export const bufferSensorReading = onValueWritten(
  {
    ref: "/homes/{homeId}/sensors/{sensor}",
    region: FUNCTIONS_REGION,
  },
  async (event) => {
    const { homeId, sensor } = event.params;
    const after = event.data.after.val();

    // Only buffer numeric sensors (gas, temperature, humidity, soil,
    // distance) — booleans (flame, motion, vibration, rain) and
    // strings (doorContact) aren't aggregatable and the PRD only
    // asks for "each numeric sensor" anyway.
    if (!after || typeof after.v !== "number") {
      return;
    }

    const db = getDatabase();
    await db.ref(`homes/${homeId}/_raw/${sensor}`).push({
      v: after.v,
      ts: after.ts || Date.now(),
    });
  }
);

// IST = UTC+5:30. Hour/date buckets in telemetry are in IST (matching
// pruneOldData's "daily 03:00 IST" schedule elsewhere in the PRD), but
// raw timestamps stay as real epoch ms — only the bucket LABEL is
// shifted to IST wall-clock time.
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

function getPreviousISTHourRange(nowUtcMs: number) {
  const istNow = nowUtcMs + IST_OFFSET_MS;
  const istHourStart = Math.floor(istNow / 3600000) * 3600000;
  const istPrevHourStart = istHourStart - 3600000;

  const hourStartUTC = istPrevHourStart - IST_OFFSET_MS;
  const hourEndUTC = istHourStart - IST_OFFSET_MS;

  const d = new Date(istPrevHourStart);
  const date = [
    d.getUTCFullYear(),
    String(d.getUTCMonth() + 1).padStart(2, "0"),
    String(d.getUTCDate()).padStart(2, "0"),
  ].join("-");
  const hour = String(d.getUTCHours()).padStart(2, "0");

  return { hourStartUTC, hourEndUTC, date, hour };
}

/**
 * aggregateTelemetry
 *
 * Runs hourly. For each home and each numeric sensor, rolls up
 * everything bufferSensorReading collected during the PREVIOUS
 * (now-completed) hour into telemetry/{sensor}/{date}/{hh} as
 * { min, max, avg, n }. Rolling up the completed hour (not the
 * in-progress one) is what makes this idempotent, per the PRD:
 * a finished hour's readings don't change, so re-running this
 * produces the same result every time.
 *
 * If a rerun finds no raw readings left for that hour (e.g. they
 * were already cleaned up), it skips writing rather than overwriting
 * a good rollup with a zero-reading one — that's the idempotency
 * safety net.
 *
 * Also does light housekeeping: deletes raw buffer entries older
 * than 3 hours, well past any reasonable rerun window, so /_raw
 * doesn't grow without bound between now and when pruneOldData
 * exists.
 */
export const aggregateTelemetry = onSchedule(
  { schedule: "every 60 minutes", region: FUNCTIONS_REGION },
  async () => {
    const db = getDatabase();
    const homesSnap = await db.ref("homes").get();
    const homes = homesSnap.val() || {};
    const { hourStartUTC, hourEndUTC, date, hour } = getPreviousISTHourRange(
      Date.now()
    );

    for (const homeId of Object.keys(homes)) {
      const rawSnap = await db.ref(`homes/${homeId}/_raw`).get();
      const rawData = rawSnap.val() || {};

      for (const sensor of Object.keys(rawData)) {
        const entries = rawData[sensor] || {};
        const values: number[] = [];

        for (const key of Object.keys(entries)) {
          const entry = entries[key];
          if (
            entry &&
            typeof entry.ts === "number" &&
            typeof entry.v === "number" &&
            entry.ts >= hourStartUTC &&
            entry.ts < hourEndUTC
          ) {
            values.push(entry.v);
          }
        }

        if (values.length === 0) {
          continue; // nothing new for this hour — idempotent no-op
        }

        const min = Math.min(...values);
        const max = Math.max(...values);
        const avg = values.reduce((a, b) => a + b, 0) / values.length;
        const n = values.length;

        await db
          .ref(`homes/${homeId}/telemetry/${sensor}/${date}/${hour}`)
          .set({ min, max, avg, n });

        logger.info("Telemetry rollup written", {
          homeId,
          sensor,
          date,
          hour,
          min,
          max,
          avg,
          n,
        });
      }

      // Housekeeping: clear raw entries older than 3 hours.
      const cleanupCutoff = Date.now() - 3 * 3600 * 1000;
      const updates: Record<string, null> = {};
      for (const sensor of Object.keys(rawData)) {
        const entries = rawData[sensor] || {};
        for (const key of Object.keys(entries)) {
          if (entries[key] && entries[key].ts < cleanupCutoff) {
            updates[`homes/${homeId}/_raw/${sensor}/${key}`] = null;
          }
        }
      }
      if (Object.keys(updates).length > 0) {
        await db.ref().update(updates);
      }
    }
  }
);

/**
 * pruneOldData
 *
 * Runs once a day at 3:00 AM IST. Keeps the database from growing
 * without bound (PRD B-NFR-03: DB should stay under 100 MB) by
 * deleting:
 *  - events/{date}/* older than 30 days (date is a "yyyy-mm-dd" key,
 *    so a plain string comparison against a cutoff date works)
 *  - telemetry/{sensor}/{date}/* older than 30 days (same idea)
 *  - commands/{pushId} older than 7 days, but ONLY if status is
 *    "done" or "failed" — a still-"pending" command is never
 *    deleted no matter how old, since that would hide a stuck
 *    command instead of surfacing it as a problem.
 *
 * Safe to re-run: everything it deletes is deleted by an exact
 * date/age check, so running it twice in a row (or being retried
 * after a crash) just finds nothing left to delete the second time.
 */
function dateStringDaysAgo(days: number): string {
  const d = new Date(Date.now() - days * 24 * 3600 * 1000);
  return [
    d.getUTCFullYear(),
    String(d.getUTCMonth() + 1).padStart(2, "0"),
    String(d.getUTCDate()).padStart(2, "0"),
  ].join("-");
}

export const pruneOldData = onSchedule(
  {
    schedule: "0 3 * * *",
    timeZone: "Asia/Kolkata",
    region: FUNCTIONS_REGION,
  },
  async () => {
    const db = getDatabase();
    const homesSnap = await db.ref("homes").get();
    const homes = homesSnap.val() || {};

    const eventsCutoff = dateStringDaysAgo(30);
    const telemetryCutoff = dateStringDaysAgo(30);
    const commandsCutoffMs = Date.now() - 7 * 24 * 3600 * 1000;

    for (const homeId of Object.keys(homes)) {
      const updates: Record<string, null> = {};

      // --- events older than 30 days ---
      const eventsSnap = await db.ref(`homes/${homeId}/events`).get();
      const events = eventsSnap.val() || {};
      for (const date of Object.keys(events)) {
        if (date < eventsCutoff) {
          updates[`homes/${homeId}/events/${date}`] = null;
        }
      }

      // --- telemetry older than 30 days (per sensor, per date) ---
      const telemetrySnap = await db.ref(`homes/${homeId}/telemetry`).get();
      const telemetry = telemetrySnap.val() || {};
      for (const sensor of Object.keys(telemetry)) {
        const dates = telemetry[sensor] || {};
        for (const date of Object.keys(dates)) {
          if (date < telemetryCutoff) {
            updates[`homes/${homeId}/telemetry/${sensor}/${date}`] = null;
          }
        }
      }

      // --- commands: done/failed AND older than 7 days ---
      const commandsSnap = await db.ref(`homes/${homeId}/commands`).get();
      const commands = commandsSnap.val() || {};
      for (const pushId of Object.keys(commands)) {
        const cmd = commands[pushId];
        const isFinished = cmd && (cmd.status === "done" || cmd.status === "failed");
        const isOldEnough = cmd && typeof cmd.ts === "number" && cmd.ts < commandsCutoffMs;
        if (isFinished && isOldEnough) {
          updates[`homes/${homeId}/commands/${pushId}`] = null;
        }
      }

      if (Object.keys(updates).length > 0) {
        await db.ref().update(updates);
        logger.info("pruneOldData cleaned up home", {
          homeId,
          deletedPaths: Object.keys(updates).length,
        });
      } else {
        logger.info("pruneOldData found nothing to clean up for home", { homeId });
      }
    }
  }
);

/**
 * onCommandCreated (nice-to-have, per PRD §6)
 *
 * Trigger: a new command appears at /homes/{homeId}/commands/{commandId}
 * (a client just asked the device to do something, e.g. turn on a light).
 *
 * Waits 10 seconds, then checks: is this command STILL "pending"?
 *  - If yes, the device never picked it up (most likely offline) — mark
 *    it "failed" so the app can show the user an honest result instead
 *    of a spinner that never resolves.
 *  - If it's already "done" (or "failed" for some other reason), this
 *    does nothing — the device beat us to it, which is the normal,
 *    expected case.
 *
 * Note: this function intentionally stays "alive" and waiting for 10
 * seconds — that's the PRD's literal design ("schedule a check"), not
 * a mistake. At demo scale (occasional user taps) this is cheap; if
 * command volume ever grows a lot, revisit with a proper delayed task
 * queue instead of an in-function wait.
 */
export const onCommandCreated = onValueCreated(
  {
    ref: "/homes/{homeId}/commands/{commandId}",
    region: FUNCTIONS_REGION,
  },
  async (event) => {
    const { homeId, commandId } = event.params;
    const db = getDatabase();

    await new Promise((resolve) => setTimeout(resolve, 10000));

    const statusSnap = await db
      .ref(`homes/${homeId}/commands/${commandId}/status`)
      .get();
    const status = statusSnap.val();

    if (status === "pending") {
      await db
        .ref(`homes/${homeId}/commands/${commandId}/status`)
        .set("failed");
      logger.info("Command timed out — marked failed", { homeId, commandId });
    } else {
      logger.info("Command already resolved — no action needed", {
        homeId,
        commandId,
        status,
      });
    }
  }
);