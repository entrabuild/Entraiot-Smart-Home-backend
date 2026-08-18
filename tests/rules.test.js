/**
 * EntraIoT — Security Rules Tests
 *
 * These tests connect to your LOCAL emulator (never real cloud) and try
 * a bunch of "should this be allowed?" scenarios against database.rules.json
 * for the devices/{deviceId} schema (ESP32 -> Firebase -> Dashboard,
 * secured by a `deviceId` custom claim on each controller's Auth account —
 * see scripts/provision-production.js for how that claim gets set).
 *
 * Every rule needs BOTH an allow-case and a deny-case tested.
 *
 * HOW TO RUN:
 *   1. Make sure the emulator is running (firebase emulators:start)
 *      in another terminal — leave it running.
 *   2. In this "tests" folder, run:  node rules.test.js
 *
 * If everything passes you'll see a row of ✅ and "ALL TESTS PASSED".
 * If something fails, it tells you exactly which scenario broke.
 */

const {
  initializeTestEnvironment,
  assertSucceeds,
  assertFails,
} = require("@firebase/rules-unit-testing");
const fs = require("fs");
const path = require("path");

const DEVICE_A = "esp32_001";
const DEVICE_B = "esp32_002";

const USER_UID = "user_uid"; // a signed-in dashboard viewer, no device claim
const CONTROLLER_A_UID = "controller_a_uid"; // deviceId claim == DEVICE_A
const CONTROLLER_B_UID = "controller_b_uid"; // deviceId claim == DEVICE_B

let testEnv;
let passed = 0;
let failed = 0;

async function check(label, fn) {
  try {
    await fn();
    console.log(`✅  ${label}`);
    passed++;
  } catch (err) {
    console.log(`❌  ${label}`);
    console.log(`    → ${err.message}`);
    failed++;
  }
}

async function main() {
  testEnv = await initializeTestEnvironment({
    projectId: "entraiot-dev-rules-test",
    database: {
      host: "127.0.0.1",
      port: 9000,
      rules: fs.readFileSync(
        path.join(__dirname, "..", "database.rules.json"),
        "utf8"
      ),
    },
  });

  // --- Seed baseline data as an admin (rules don't apply to this) ---
  await testEnv.withSecurityRulesDisabled(async (context) => {
    const db = context.database();
    await db.ref(`devices/${DEVICE_A}/sensors/temperature`).set(25.0);
    await db.ref(`devices/${DEVICE_A}/status`).set({ lastSeen: Date.now(), wifiRSSI: -60 });
    await db.ref(`users/${USER_UID}/profile`).set({ name: "Test User" });
  });

  // Helpers to get a database client "as" a specific identity. Custom
  // claims (like deviceId) are injected via the second argument to
  // authenticatedContext — this is what makes the emulator behave as if
  // that user's real ID token carried the claim provision-production.js
  // sets in production.
  function asAnon(uid) {
    return testEnv.authenticatedContext(uid).database();
  }
  function asController(uid, deviceId) {
    return testEnv.authenticatedContext(uid, { deviceId }).database();
  }
  function asStranger() {
    return testEnv.unauthenticatedContext().database();
  }

  // ---------- users/{uid} ----------
  await check("A user CAN read their own profile", async () => {
    await assertSucceeds(asAnon(USER_UID).ref(`users/${USER_UID}`).get());
  });

  await check("A user CANNOT read someone else's profile", async () => {
    await assertFails(asAnon(CONTROLLER_A_UID).ref(`users/${USER_UID}`).get());
  });

  await check("A user CAN write their own profile", async () => {
    await assertSucceeds(asAnon(USER_UID).ref(`users/${USER_UID}/profile/name`).set("New Name"));
  });

  await check("A user CANNOT write someone else's profile", async () => {
    await assertFails(asAnon(CONTROLLER_A_UID).ref(`users/${USER_UID}/profile/name`).set("Hacked"));
  });

  // ---------- devices/{deviceId}: read — any signed-in session, no stranger ----------
  await check("Any authenticated (even claim-less) user CAN read a device", async () => {
    await assertSucceeds(asAnon(USER_UID).ref(`devices/${DEVICE_A}`).get());
  });

  await check("An unauthenticated stranger CANNOT read a device", async () => {
    await assertFails(asStranger().ref(`devices/${DEVICE_A}`).get());
  });

  // ---------- devices/{deviceId}: write — only the matching deviceId claim ----------
  await check("The device's own controller CAN write its sensors", async () => {
    await assertSucceeds(
      asController(CONTROLLER_A_UID, DEVICE_A)
        .ref(`devices/${DEVICE_A}/sensors/temperature`)
        .set(26.4)
    );
  });

  await check("The device's own controller CAN write its status (server timestamp)", async () => {
    await assertSucceeds(
      asController(CONTROLLER_A_UID, DEVICE_A)
        .ref(`devices/${DEVICE_A}/status/lastSeen`)
        .set({ ".sv": "timestamp" })
    );
  });

  await check("The device's own controller CAN write its heartbeat", async () => {
    await assertSucceeds(
      asController(CONTROLLER_A_UID, DEVICE_A)
        .ref(`devices/${DEVICE_A}/heartbeat`)
        .set({ uptimeS: 120, freeHeap: 180, rssi: -58, ip: "192.168.1.50", mac: "AA:BB:CC:DD:EE:FF", fw: "1.1.0" })
    );
  });

  await check("The device's own controller CAN push an alert", async () => {
    await assertSucceeds(
      asController(CONTROLLER_A_UID, DEVICE_A)
        .ref(`devices/${DEVICE_A}/alerts`)
        .push({ type: "fire", message: "Flame detected", ts: { ".sv": "timestamp" } })
    );
  });

  await check("A user with NO deviceId claim CANNOT write a device's sensors", async () => {
    await assertFails(
      asAnon(USER_UID).ref(`devices/${DEVICE_A}/sensors/temperature`).set(99)
    );
  });

  await check("Device B's controller CANNOT write to Device A's path (claim must match)", async () => {
    await assertFails(
      asController(CONTROLLER_B_UID, DEVICE_B)
        .ref(`devices/${DEVICE_A}/sensors/temperature`)
        .set(99)
    );
  });

  await check("Device B's controller CAN write to its own path", async () => {
    await assertSucceeds(
      asController(CONTROLLER_B_UID, DEVICE_B)
        .ref(`devices/${DEVICE_B}/sensors/temperature`)
        .set(21.0)
    );
  });

  await check("An unauthenticated stranger CANNOT write to any device", async () => {
    await assertFails(asStranger().ref(`devices/${DEVICE_A}/sensors/temperature`).set(1));
  });

  // ---------- default-deny root ----------
  await check("Nobody can read the database root directly (default-deny)", async () => {
    await assertFails(asAnon(USER_UID).ref(`/`).get());
  });

  console.log(`\n${passed} passed, ${failed} failed.`);
  if (failed === 0) {
    console.log("🎉 ALL TESTS PASSED");
  } else {
    console.log("⚠️  Some tests failed — see above.");
  }

  await testEnv.cleanup();
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("Test run crashed:", err);
  process.exit(1);
});
