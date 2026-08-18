// Netlify Scheduled Function — runs once a day at 21:30 UTC == 3:00 AM IST
// (see ../../../Entraiot_Smart_Home_Dashboard/netlify.toml). Free plan, no
// card required.
//
// Reimplements the original pruneOldData Cloud Function (see
// functions/src/index.ts's retirement notice). Keeps the database under
// the PRD's 100 MB target by deleting:
//   - events/{date}/*      older than 30 days
//   - telemetry/{sensor}/{date}/*  older than 30 days
//   - commands/{pushId}    older than 7 days, but ONLY if status is
//                          "done" or "failed" (a still-"pending" command is
//                          never deleted, so a stuck command stays visible
//                          as a problem instead of silently vanishing)
//
// Safe to re-run: every deletion is an exact date/age check, so running it
// twice (or retrying after a crash) just finds nothing left the second time.

import { db } from "./_firebaseAdmin.mjs";

function dateStringDaysAgo(days) {
  const d = new Date(Date.now() - days * 24 * 3600 * 1000);
  return [d.getUTCFullYear(), String(d.getUTCMonth() + 1).padStart(2, "0"), String(d.getUTCDate()).padStart(2, "0")].join(
    "-"
  );
}

export default async () => {
  const database = db();
  const homesSnap = await database.ref("homes").get();
  const homes = homesSnap.val() || {};

  const eventsCutoff = dateStringDaysAgo(30);
  const telemetryCutoff = dateStringDaysAgo(30);
  const commandsCutoffMs = Date.now() - 7 * 24 * 3600 * 1000;

  for (const homeId of Object.keys(homes)) {
    const updates = {};

    const eventsSnap = await database.ref(`homes/${homeId}/events`).get();
    const events = eventsSnap.val() || {};
    for (const date of Object.keys(events)) {
      if (date < eventsCutoff) updates[`homes/${homeId}/events/${date}`] = null;
    }

    const telemetrySnap = await database.ref(`homes/${homeId}/telemetry`).get();
    const telemetry = telemetrySnap.val() || {};
    for (const sensor of Object.keys(telemetry)) {
      const dates = telemetry[sensor] || {};
      for (const date of Object.keys(dates)) {
        if (date < telemetryCutoff) updates[`homes/${homeId}/telemetry/${sensor}/${date}`] = null;
      }
    }

    const commandsSnap = await database.ref(`homes/${homeId}/commands`).get();
    const commands = commandsSnap.val() || {};
    for (const pushId of Object.keys(commands)) {
      const cmd = commands[pushId];
      const isFinished = cmd && (cmd.status === "done" || cmd.status === "failed");
      const isOldEnough = cmd && typeof cmd.ts === "number" && cmd.ts < commandsCutoffMs;
      if (isFinished && isOldEnough) updates[`homes/${homeId}/commands/${pushId}`] = null;
    }

    if (Object.keys(updates).length > 0) {
      await database.ref().update(updates);
      console.log(`[prune] ${homeId}: cleaned up ${Object.keys(updates).length} paths`);
    } else {
      console.log(`[prune] ${homeId}: nothing to clean up`);
    }
  }

  return new Response("ok");
};
