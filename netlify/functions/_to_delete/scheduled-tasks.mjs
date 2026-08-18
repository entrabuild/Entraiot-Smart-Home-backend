// Netlify Scheduled Function — runs every 2 minutes (see ../../../
// Entraiot_Smart_Home_Dashboard/netlify.toml). Free plan, no card required.
//
// Combines three of the original Cloud Functions (functions/src/index.ts,
// now retired — see its header comment) into one run so a single free
// scheduled invocation covers all of them:
//
//   1. presenceCheck    — flip controllers offline/online based on heartbeat age
//   2. onCommandCreated — mark stuck "pending" commands as "failed" after 10s
//   3. onAlertCreated   — push FCM notifications for new critical alerts
//
// Trade-off vs. the original real-time Cloud Functions: these now run on a
// 2-minute poll instead of firing instantly. Safety-critical alerts
// (fire/gas/vibration/rain) are NOT delayed by this — the ESP32 writes them
// straight to /alerts and the dashboard's live Firebase listener shows them
// on screen immediately, with zero dependency on this function. Only the
// *push notification* for a critical alert, and offline-detection, are
// delayed by up to ~2 minutes.

import { getMessaging } from "firebase-admin/messaging";
import { db } from "./_firebaseAdmin.mjs";

const OFFLINE_THRESHOLD_MS = 120 * 1000; // 120 seconds, same as the original presenceCheck
const COMMAND_TIMEOUT_MS = 10 * 1000; // same as the original onCommandCreated

function alertTitleFor(type) {
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

async function runPresenceCheck(database, homeId, home) {
  const controllers = home.controllers || {};
  const now = Date.now();

  for (const deviceId of Object.keys(controllers)) {
    const controller = controllers[deviceId];
    const heartbeatTs = controller.heartbeat?.ts || 0;
    const currentStatus = controller.status;
    const age = now - heartbeatTs;

    if (age > OFFLINE_THRESHOLD_MS && currentStatus === "online") {
      console.log(`[presence] ${homeId}/${deviceId} went offline (age=${age}ms)`);
      await database.ref(`homes/${homeId}/controllers/${deviceId}/status`).set("offline");
      await database.ref(`homes/${homeId}/alerts`).push({
        type: "offline",
        severity: "warning",
        msg: `Controller ${deviceId} has not checked in for over 2 minutes.`,
        ts: now,
        ack: null,
      });
    } else if (age <= OFFLINE_THRESHOLD_MS && currentStatus === "offline") {
      console.log(`[presence] ${homeId}/${deviceId} came back online (age=${age}ms)`);
      await database.ref(`homes/${homeId}/controllers/${deviceId}/status`).set("online");
    }
  }
}

async function runCommandTimeoutSweep(database, homeId, home) {
  const commands = home.commands || {};
  const now = Date.now();

  for (const commandId of Object.keys(commands)) {
    const cmd = commands[commandId];
    if (cmd && cmd.status === "pending" && typeof cmd.ts === "number" && now - cmd.ts > COMMAND_TIMEOUT_MS) {
      console.log(`[commands] ${homeId}/${commandId} timed out — marking failed`);
      await database.ref(`homes/${homeId}/commands/${commandId}/status`).set("failed");
    }
  }
}

async function runAlertPushSweep(database, homeId, home) {
  const alerts = home.alerts || {};
  const members = home.members || {};
  const memberUids = Object.keys(members);

  const pending = Object.entries(alerts).filter(
    ([, alert]) => alert && alert.severity === "critical" && !alert.notified
  );
  if (pending.length === 0) return;

  // Collect FCM tokens once per home, reused across all pending alerts in
  // this run.
  const tokens = [];
  for (const uid of memberUids) {
    const tokensSnap = await database.ref(`users/${uid}/fcmTokens`).get();
    const tokenMap = tokensSnap.val() || {};
    tokens.push(...Object.keys(tokenMap));
  }

  for (const [alertId, alert] of pending) {
    // Always mark notified, even with zero tokens, so we don't retry
    // forever against a home with no registered devices.
    await database.ref(`homes/${homeId}/alerts/${alertId}/notified`).set(true);

    if (tokens.length === 0) {
      console.log(`[alerts] ${homeId}/${alertId} critical, but no FCM tokens registered — skipping push`);
      continue;
    }

    const title = alertTitleFor(alert.type);
    const body = alert.msg || "Check the app for details.";
    let successCount = 0;
    let failureCount = 0;
    const invalidTokens = [];

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
        if (!r.success) invalidTokens.push(tokens[i]);
      });
    } catch (err) {
      console.error(`[alerts] push failed for ${homeId}/${alertId}`, err);
    }

    for (const badToken of invalidTokens) {
      for (const uid of memberUids) {
        await database.ref(`users/${uid}/fcmTokens/${badToken}`).remove().catch(() => {});
      }
    }

    const today = new Date().toISOString().slice(0, 10);
    await database.ref(`homes/${homeId}/events/${today}`).push({
      type: "alert_push_sent",
      detail: `Alert ${alertId}: ${successCount} sent, ${failureCount} failed`,
      ts: Date.now(),
    });

    console.log(`[alerts] ${homeId}/${alertId} push sent: ${successCount} ok, ${failureCount} failed`);
  }
}

export default async () => {
  const database = db();
  const homesSnap = await database.ref("homes").get();
  const homes = homesSnap.val() || {};

  for (const homeId of Object.keys(homes)) {
    const home = homes[homeId];
    await runPresenceCheck(database, homeId, home);
    await runCommandTimeoutSweep(database, homeId, home);
    await runAlertPushSweep(database, homeId, home);
  }

  return new Response("ok");
};

// Schedule is declared once, in netlify.toml, as the single source of
// truth (rather than duplicating it here too).
