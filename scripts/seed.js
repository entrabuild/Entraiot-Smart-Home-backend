/**
 * EntraIoT — Emulator Seed Script
 *
 * This fills your LOCAL emulator database with realistic fake data:
 * - 1 home, 1 controller (ESP32), 3 users (owner + 2 members)
 * - 24 hours of fake sensor readings
 * - a few devices with states
 * - one sample "gas" alert
 *
 * IMPORTANT: This script is hardcoded to talk to the EMULATOR only
 * (127.0.0.1), never the real cloud. That's what the
 * FIREBASE_DATABASE_EMULATOR_HOST line below does.
 *
 * Run it with:  node seed.js
 * (make sure the emulator is already running in another terminal!)
 */

process.env.FIREBASE_DATABASE_EMULATOR_HOST = "127.0.0.1:9000";
process.env.FIREBASE_AUTH_EMULATOR_HOST = "127.0.0.1:9099";

const { initializeApp } = require("firebase-admin/app");
const { getDatabase } = require("firebase-admin/database");

const app = initializeApp({
  projectId: "entraiot-dev",
  databaseURL: "http://127.0.0.1:9000/?ns=entraiot-dev-default-rtdb",
});

const db = getDatabase(app);

// Fixed IDs so it's easy to find things while testing
const HOME_ID = "home_demo1";
const DEVICE_ID = "controller_demo1";
const OWNER_UID = "user_owner_demo";
const MEMBER_UID = "user_member_demo";
const CONTROLLER_UID = "user_controller_demo";

function now() {
  return Date.now();
}

// Generates one fake hourly value with a bit of random wobble
function wobble(base, spread) {
  return Math.round((base + (Math.random() - 0.5) * spread) * 10) / 10;
}

async function seed() {
  console.log("Seeding users...");
  await db.ref(`users/${OWNER_UID}`).set({
    profile: {
      name: "Priya (Owner)",
      email: "owner@entraiot.test",
      createdAt: now(),
    },
    fcmTokens: {
      demo_token_owner: true,
    },
  });

  await db.ref(`users/${MEMBER_UID}`).set({
    profile: {
      name: "Demo Family Member",
      email: "member@entraiot.test",
      createdAt: now(),
    },
    fcmTokens: {
      demo_token_member: true,
    },
  });

  console.log("Seeding home meta + members...");
  await db.ref(`homes/${HOME_ID}/meta`).set({
    name: "Demo Villa",
    schemaVersion: 1,
    createdAt: now(),
  });

  await db.ref(`homes/${HOME_ID}/members`).set({
    [OWNER_UID]: "owner",
    [MEMBER_UID]: "member",
    [CONTROLLER_UID]: "controller",
  });

  console.log("Seeding controller info + heartbeat...");
  await db.ref(`homes/${HOME_ID}/controllers/${DEVICE_ID}`).set({
    info: { model: "esp32-devkit-30pin", fw: "1.0.0" },
    heartbeat: { ts: now(), rssi: -55, uptimeS: 3600 },
    status: "online",
  });

  console.log("Seeding current sensor snapshot...");
  await db.ref(`homes/${HOME_ID}/sensors`).set({
    temperature: { v: 28.4, ts: now() },
    humidity: { v: 61, ts: now() },
    gas: { v: 12, raw: 512, ts: now() },
    flame: { v: false, ts: now() },
    rain: { v: false, raw: 1890, ts: now() },
    soil: { v: 43, raw: 2100, ts: now() },
    motion: { v: false, ts: now() },
    vibration: { v: false, ts: now() },
    doorContact: { v: "closed", ts: now() },
    distance: { v: 87, ts: now() },
  });

  console.log("Seeding devices...");
  await db.ref(`homes/${HOME_ID}/devices`).set({
    bedroomLight: { state: "off", ts: now(), by: OWNER_UID },
    hallLight: { state: "on", ts: now(), by: MEMBER_UID },
    hallFan: { state: "off", ts: now(), by: OWNER_UID },
    irrigation: { state: "off", ts: now(), by: OWNER_UID },
    doorLock: { state: "locked", ts: now(), by: OWNER_UID },
  });

  console.log("Seeding config (thresholds + rules)...");
  await db.ref(`homes/${HOME_ID}/config`).set({
    thresholds: {
      gasAlertPct: 70,
      tempFanOnC: 30,
      tempFanOffC: 26,
      soilDryPct: 30,
      soilWetPct: 70,
      motionTimeoutS: 120,
      nightStart: "18:30",
      nightEnd: "06:00",
    },
    rules: {
      autoLight: true,
      autoFan: true,
      autoIrrigation: true,
    },
  });

  console.log("Seeding one sample alert...");
  const alertRef = db.ref(`homes/${HOME_ID}/alerts`).push();
  await alertRef.set({
    type: "gas",
    severity: "warning",
    msg: "Kitchen gas level 45% of threshold — monitoring.",
    ts: now(),
    ack: null,
  });

  console.log("Seeding 24 hours of fake telemetry (temperature + humidity)...");
  const today = new Date().toISOString().slice(0, 10); // yyyy-mm-dd
  const updates = {};
  for (let hh = 0; hh < 24; hh++) {
    const hour = String(hh).padStart(2, "0");
    updates[`homes/${HOME_ID}/telemetry/temperature/${today}/${hour}`] = {
      min: wobble(24, 4),
      max: wobble(30, 4),
      avg: wobble(27, 3),
      n: 60,
    };
    updates[`homes/${HOME_ID}/telemetry/humidity/${today}/${hour}`] = {
      min: wobble(50, 10),
      max: wobble(70, 10),
      avg: wobble(60, 8),
      n: 60,
    };
  }
  await db.ref().update(updates);

  console.log("\n✅ Seed complete!");
  console.log(`Home ID: ${HOME_ID}`);
  console.log(`Owner UID: ${OWNER_UID}`);
  console.log(`Member UID: ${MEMBER_UID}`);
  console.log(`Controller UID: ${CONTROLLER_UID}`);
  console.log("\nOpen http://127.0.0.1:4000/database to see the data.");

  process.exit(0);
}

seed().catch((err) => {
  console.error("Seed failed:", err);
  process.exit(1);
});