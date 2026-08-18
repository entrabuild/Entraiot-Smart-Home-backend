// Netlify Scheduled Function — runs hourly at :00 UTC (see ../../../
// Entraiot_Smart_Home_Dashboard/netlify.toml). Free plan, no card required.
//
// Reimplements the original aggregateTelemetry Cloud Function (see
// functions/src/index.ts's retirement notice). Rolls up everything under
// homes/{homeId}/_raw/{sensor} (now written DIRECTLY by the ESP32 firmware
// itself — see Entraiot_ESP32_IoT.ino's syncToCloud() — since there is no
// longer a bufferSensorReading database-write-trigger function to do it)
// into homes/{homeId}/telemetry/{sensor}/{date}/{hh} as { min, max, avg, n }.
//
// Rolls up the just-completed IST hour (not the in-progress one), which
// keeps this idempotent: a finished hour's readings never change, so
// re-running this finds the same raw data and writes the same result.
//
// Also deletes _raw entries older than 3 hours so that node never grows
// without bound between runs.

import { db } from "./_firebaseAdmin.mjs";

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

function getPreviousISTHourRange(nowUtcMs) {
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

export default async () => {
  const database = db();
  const homesSnap = await database.ref("homes").get();
  const homes = homesSnap.val() || {};
  const { hourStartUTC, hourEndUTC, date, hour } = getPreviousISTHourRange(Date.now());

  for (const homeId of Object.keys(homes)) {
    const rawSnap = await database.ref(`homes/${homeId}/_raw`).get();
    const rawData = rawSnap.val() || {};

    for (const sensor of Object.keys(rawData)) {
      const entries = rawData[sensor] || {};
      const values = [];

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

      if (values.length === 0) continue; // nothing new for this hour — idempotent no-op

      const min = Math.min(...values);
      const max = Math.max(...values);
      const avg = values.reduce((a, b) => a + b, 0) / values.length;
      const n = values.length;

      await database.ref(`homes/${homeId}/telemetry/${sensor}/${date}/${hour}`).set({ min, max, avg, n });
      console.log(`[telemetry] ${homeId}/${sensor} ${date} ${hour}:00 -> n=${n} avg=${avg.toFixed(2)}`);
    }

    // Housekeeping: clear raw entries older than 3 hours.
    const cleanupCutoff = Date.now() - 3 * 3600 * 1000;
    const updates = {};
    for (const sensor of Object.keys(rawData)) {
      const entries = rawData[sensor] || {};
      for (const key of Object.keys(entries)) {
        if (entries[key] && entries[key].ts < cleanupCutoff) {
          updates[`homes/${homeId}/_raw/${sensor}/${key}`] = null;
        }
      }
    }
    if (Object.keys(updates).length > 0) {
      await database.ref().update(updates);
      console.log(`[telemetry] ${homeId}: pruned ${Object.keys(updates).length} stale _raw entries`);
    }
  }

  return new Response("ok");
};
