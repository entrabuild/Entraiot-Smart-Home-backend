/**
 * EntraIoT — ESP32 Emulator
 *
 * Stands in for a real ESP32 controller while the physical hardware isn't
 * available yet (Part 10 of the spec). It writes to exactly the same paths,
 * with exactly the same shapes, on exactly the same cadence, that
 * docs/ESP32_API.md specifies for the real firmware:
 *
 *   - homes/{homeId}/sensors/*        (per-sensor cadence, see below)
 *   - homes/{homeId}/controllers/{deviceId}/heartbeat   (every 30s)
 *   - homes/{homeId}/devices/*        (on command actuation)
 *   - homes/{homeId}/alerts           (fire/gas/vibration/rain events —
 *                                      matches "ESP32 writes these" in
 *                                      rtdb-schema.md; `offline` alerts are
 *                                      left to the real presenceCheck
 *                                      Cloud Function, which also fires
 *                                      correctly if you just stop this
 *                                      script)
 *   - homes/{homeId}/commands/{id}/status  (flips pending -> done, simulating
 *                                            the device picking up a command)
 *
 * WHEN THE REAL ESP32 IS READY: stop running this script (or set
 * EMULATOR_DISABLED=true). Nothing on the dashboard or backend needs to
 * change — the real device will write to the same paths and the frontend's
 * Firebase listeners pick it up automatically.
 *
 * Uses firebase-admin (like the Cloud Functions and scripts/seed.js do),
 * which bypasses database.rules.json — appropriate here since this script
 * plays the role of a fully-trusted device, the same trust level the rules
 * grant to a real authenticated "controller" member.
 */

const { initializeApp, cert, applicationDefault } = require("firebase-admin/app");
const { getDatabase } = require("firebase-admin/database");

const env = (key, fallback) => (process.env[key] !== undefined ? process.env[key] : fallback);
const envBool = (key, fallback) => {
  const v = process.env[key];
  if (v === undefined) return fallback;
  return v.toLowerCase() === "true";
};
const envNum = (key, fallback) => {
  const v = process.env[key];
  return v === undefined ? fallback : Number(v);
};

const CONFIG = {
  homeId: env("HOME_ID", "home_demo1"),
  deviceId: env("DEVICE_ID", "controller_demo1"),
  model: env("DEVICE_MODEL", "esp32-devkit-30pin"),
  firmware: env("FIRMWARE_VERSION", "1.0.0-emulated"),
  useEmulator: envBool("USE_EMULATOR", true),
  projectId: env("FIREBASE_PROJECT_ID", "entraiot-dev"),
  databaseURL: env("FIREBASE_DATABASE_URL", "http://127.0.0.1:9000/?ns=entraiot-dev-default-rtdb"),
  tempHumidityIntervalMs: envNum("TEMP_HUMIDITY_INTERVAL_MS", 5000),
  heartbeatIntervalMs: envNum("HEARTBEAT_INTERVAL_MS", 30000),
  tickIntervalMs: envNum("TICK_INTERVAL_MS", 3000),
  disabled: envBool("EMULATOR_DISABLED", false),
};

if (CONFIG.disabled) {
  console.log("EMULATOR_DISABLED=true — exiting without writing anything. Flip it back to run again.");
  process.exit(0);
}

if (CONFIG.useEmulator) {
  process.env.FIREBASE_DATABASE_EMULATOR_HOST = env("FIREBASE_DATABASE_EMULATOR_HOST", "127.0.0.1:9000");
  process.env.FIREBASE_AUTH_EMULATOR_HOST = env("FIREBASE_AUTH_EMULATOR_HOST", "127.0.0.1:9099");
}

const app = initializeApp({
  projectId: CONFIG.projectId,
  databaseURL: CONFIG.databaseURL,
  credential: CONFIG.useEmulator
    ? undefined
    : process.env.GOOGLE_APPLICATION_CREDENTIALS
    ? applicationDefault()
    : undefined,
});
const db = getDatabase(app);
const homeRef = (...segments) => db.ref(`homes/${CONFIG.homeId}/${segments.join("/")}`);

// ---- simple bounded random walk, same shape of assumption a real analog
// sensor's noise would have ----
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const walk = (v, step, lo, hi) => clamp(v + (Math.random() - 0.5) * step, lo, hi);

const sim = {
  temperature: 24.6,
  humidity: 55,
  gasRaw: 1800, // higher raw = cleaner air, matches MQ-2 module wiring assumption in ESP32_API.md
  rainRaw: 3800, // higher raw = dry, per ESP32_API.md rain-sensor wiring note
  soilRaw: 2200,
  distance: 120,
  flame: false,
  motion: false,
  vibration: false,
  doorContact: "closed",
  freeHeap: 210, // KB
  rssi: -55,
  cpuLoadPct: 24,
  bootedAt: Date.now(),
  ip: "192.168.1.147",
  mac: "A4:CF:12:8B:3E:9D",
};

function rawToGasPct(raw) {
  // Lower raw analog reading = more combustible gas / smoke present.
  // Mirrors the same normalization documented in ESP32_API.md and used by
  // firebase-client.js on the dashboard side.
  return clamp(Math.round((1 - raw / 4095) * 1000), 0, 1000);
}
function rawToRainPct(raw) {
  return clamp(Math.round((1 - raw / 4095) * 100), 0, 100);
}
function rawToSoilPct(raw) {
  return clamp(Math.round((1 - raw / 4095) * 100), 0, 100);
}

async function writeSensor(name, fields) {
  await homeRef("sensors", name).set({ ...fields, ts: Date.now() });
}

async function writeTempHumidity() {
  sim.temperature = Number(walk(sim.temperature, 0.6, 15, 38).toFixed(1));
  sim.humidity = Math.round(walk(sim.humidity, 4, 20, 95));
  await writeSensor("temperature", { v: sim.temperature });
  await writeSensor("humidity", { v: sim.humidity });
}

async function writeFastSensors() {
  sim.gasRaw = Math.round(walk(sim.gasRaw, 250, 200, 4000));
  sim.rainRaw = Math.round(walk(sim.rainRaw, 300, 200, 4000));
  sim.soilRaw = Math.round(walk(sim.soilRaw, 200, 200, 4000));
  sim.distance = Math.round(walk(sim.distance, 15, 2, 400));

  // Occasional discrete events, each with its own low probability per tick.
  const wasFlame = sim.flame;
  sim.flame = Math.random() < 0.01 ? true : sim.flame && Math.random() < 0.5;
  sim.motion = Math.random() < 0.3;
  const wasVibration = sim.vibration;
  sim.vibration = Math.random() < 0.04;
  const smokeLikely = rawToGasPct(sim.gasRaw) > 750;

  await writeSensor("gas", { v: rawToGasPct(sim.gasRaw), raw: sim.gasRaw });
  await writeSensor("rain", { v: rawToRainPct(sim.rainRaw) > 60, raw: sim.rainRaw });
  await writeSensor("soil", { v: rawToSoilPct(sim.soilRaw), raw: sim.soilRaw });
  await writeSensor("distance", { v: sim.distance });
  await writeSensor("flame", { v: sim.flame });
  await writeSensor("motion", { v: sim.motion });
  await writeSensor("vibration", { v: sim.vibration });
  await writeSensor("doorContact", { v: sim.doorContact });

  // ESP32-side alerting: the schema says fire/gas/vibration/rain alerts are
  // written by the device itself (not a Cloud Function), so the emulator
  // does the same thing a real firmware build would.
  if (sim.flame && !wasFlame) await pushAlert("fire", "critical", "Fire detected by flame sensor");
  if (smokeLikely) await pushAlert("gas", "critical", "Gas leak suspected — high concentration", 30000);
  if (sim.vibration && !wasVibration) await pushAlert("vibration", "warning", "High vibration detected", 30000);
  if (rawToRainPct(sim.rainRaw) > 80) await pushAlert("rain", "warning", "Heavy rain intensity recorded", 40000);
}

const lastAlertAt = {};
async function pushAlert(type, severity, msg, cooldownMs = 25000) {
  const now = Date.now();
  if (lastAlertAt[type] && now - lastAlertAt[type] < cooldownMs) return;
  lastAlertAt[type] = now;
  await homeRef("alerts").push({ type, severity, msg, ts: now, ack: null });
}

async function writeHeartbeat() {
  const uptimeS = Math.floor((Date.now() - sim.bootedAt) / 1000);
  sim.freeHeap = Math.round(walk(sim.freeHeap, 8, 140, 260));
  sim.rssi = Math.round(walk(sim.rssi, 4, -90, -35));
  sim.cpuLoadPct = Math.round(walk(sim.cpuLoadPct, 6, 8, 72));

  await homeRef("controllers", CONFIG.deviceId, "heartbeat").set({
    ts: Date.now(),
    rssi: sim.rssi,
    uptimeS,
    freeHeap: sim.freeHeap,
    cpuLoadPct: sim.cpuLoadPct,
    ip: sim.ip,
    mac: sim.mac,
    fw: CONFIG.firmware,
  });
}

async function ensureProvisioned() {
  // Real firmware relies on an admin-run provisioning step to create
  // controllers/{deviceId}/info and homes/{homeId}/devices/* the first time
  // — the device itself never writes `info` (see rtdb-schema.md: only
  // heartbeat/status are device-writable). The emulator does the same
  // one-time setup here using firebase-admin, purely so this script is
  // runnable standalone against a fresh database.
  const infoSnap = await homeRef("controllers", CONFIG.deviceId, "info").get();
  if (!infoSnap.exists()) {
    await homeRef("controllers", CONFIG.deviceId, "info").set({ model: CONFIG.model, fw: CONFIG.firmware });
  }
  const devicesSnap = await homeRef("devices").get();
  if (!devicesSnap.exists()) {
    const now = Date.now();
    await homeRef("devices").set({
      bedroomLight: { state: "off", ts: now, by: "emulator" },
      hallLight: { state: "off", ts: now, by: "emulator" },
      hallFan: { state: "off", ts: now, by: "emulator" },
      irrigation: { state: "off", ts: now, by: "emulator" },
      doorLock: { state: "locked", ts: now, by: "emulator" },
    });
  }
}

// ---- Two-way command handling (Part 8) ----
// Watches homes/{homeId}/commands for new "pending" entries and simulates
// the device actuating them after a short realistic delay, then writes the
// resulting device state and marks the command "done" — exactly the
// contract onCommandCreated (backend) expects a real device to fulfill.
function watchCommands() {
  homeRef("commands").on("child_added", async (snap) => {
    const cmd = snap.val();
    if (!cmd || cmd.status !== "pending") return;
    const commandId = snap.key;

    setTimeout(async () => {
      try {
        const target = cmd.target;
        const validDevices = ["bedroomLight", "hallLight", "hallFan", "irrigation", "doorLock"];
        if (!validDevices.includes(target)) {
          await homeRef("commands", commandId, "status").set("failed");
          return;
        }
        const state = target === "doorLock" ? (cmd.action === "unlock" ? "unlocked" : "locked") : cmd.action === "on" ? "on" : "off";
        await homeRef("devices", target).set({ state, ts: Date.now(), by: cmd.by || "unknown" });
        await homeRef("commands", commandId, "status").set("done");
      } catch (e) {
        console.error("Failed to actuate command", commandId, e);
        await homeRef("commands", commandId, "status").set("failed").catch(() => {});
      }
    }, 400 + Math.random() * 800); // simulated actuation latency
  });
}

async function main() {
  console.log(`EntraIoT ESP32 emulator starting — home=${CONFIG.homeId} device=${CONFIG.deviceId} target=${CONFIG.useEmulator ? "LOCAL EMULATOR" : CONFIG.databaseURL}`);
  await ensureProvisioned();
  await homeRef("controllers", CONFIG.deviceId, "status").set("online");
  watchCommands();

  await writeTempHumidity();
  await writeFastSensors();
  await writeHeartbeat();

  setInterval(() => writeTempHumidity().catch((e) => console.error("temp/humidity write failed", e)), CONFIG.tempHumidityIntervalMs);
  setInterval(() => writeFastSensors().catch((e) => console.error("sensor write failed", e)), CONFIG.tickIntervalMs);
  setInterval(() => writeHeartbeat().catch((e) => console.error("heartbeat write failed", e)), CONFIG.heartbeatIntervalMs);

  console.log("Emulator running. Ctrl+C to stop (the real presenceCheck Cloud Function will mark the device offline ~2 minutes after you do).");
}

main().catch((err) => {
  console.error("Emulator failed to start:", err);
  process.exit(1);
});
