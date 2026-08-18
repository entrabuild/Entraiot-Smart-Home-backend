/**
 * EntraIoT — Production Provisioning Script
 *
 * One-time setup for a REAL Firebase project (Spark plan — no card needed).
 * This script talks to your real cloud project and does the two things a
 * fresh ESP32 needs before it can write anywhere:
 *
 *   1. Creates (or reuses) a Firebase Auth "controller" user — this is the
 *      ESP32's own login, set in secrets.h as FIREBASE_CONTROLLER_EMAIL /
 *      FIREBASE_CONTROLLER_PASSWORD.
 *   2. Sets a `deviceId` CUSTOM CLAIM on that user, equal to DEVICE_ID.
 *      database.rules.json requires auth.token.deviceId == $deviceId to
 *      write under devices/{deviceId} — this claim IS that authorization.
 *      Give each physical ESP32 its own controller account (one claim per
 *      account) rather than sharing logins across devices.
 *
 * It optionally pre-seeds devices/{deviceId}/info so the path exists before
 * the device's first sync (purely cosmetic — the firmware writes this same
 * info itself on its first successful sync anyway, so this step is skipped
 * automatically if it's already there).
 *
 * No "owner" account is created here: the dashboard reads with anonymous
 * Firebase Auth by default (see firebase-client.js), which already
 * satisfies database.rules.json's `auth != null` read check. If you later
 * tighten the read rule to specific people, provision those users the same
 * way `ensureUser()` below does.
 *
 * Safe to re-run: every step checks "does this already exist?" first.
 *
 * IMPORTANT — custom claims and existing tokens: a custom claim only shows
 * up in a NEW ID token. If the ESP32 (or anything else) already has a
 * cached/valid token from before you ran this script, it won't see the new
 * claim until it signs in again. The firmware always calls signInFirebase()
 * fresh on boot, so simply power-cycling (or re-flashing) the ESP32 after
 * running this script is enough.
 *
 * USAGE
 * -----
 *   1. Firebase Console -> Project settings -> Service accounts ->
 *      "Generate new private key". Save the JSON somewhere OUTSIDE this
 *      repo (never commit it).
 *   2. Copy .env.production.example to .env.production and fill it in
 *      (or just export the same variables in your shell).
 *   3. cd backend/scripts && npm install
 *   4. GOOGLE_APPLICATION_CREDENTIALS=/path/to/serviceAccountKey.json \
 *        node -r dotenv/config provision-production.js dotenv_config_path=../../.env.production
 *      (or simpler: export every variable below yourself, then
 *        `node provision-production.js`)
 */

const { initializeApp, applicationDefault } = require("firebase-admin/app");
const { getAuth } = require("firebase-admin/auth");
const { getDatabase } = require("firebase-admin/database");

function requireEnv(name) {
  const v = process.env[name];
  if (!v) {
    console.error(`Missing required environment variable: ${name}`);
    console.error("See the USAGE comment at the top of this script.");
    process.exit(1);
  }
  return v;
}

const PROJECT_ID = requireEnv("FIREBASE_PROJECT_ID");
const DATABASE_URL = requireEnv("FIREBASE_DATABASE_URL");
const DEVICE_ID = process.env.DEVICE_ID || "esp32_001";
const DEVICE_MODEL = process.env.DEVICE_MODEL || "esp32-devkit-30pin";
const FIRMWARE_VERSION = process.env.FIRMWARE_VERSION || "1.1.0";

const CONTROLLER_EMAIL = requireEnv("FIREBASE_CONTROLLER_EMAIL");
const CONTROLLER_PASSWORD = requireEnv("FIREBASE_CONTROLLER_PASSWORD");

if (!process.env.GOOGLE_APPLICATION_CREDENTIALS) {
  console.error("Missing GOOGLE_APPLICATION_CREDENTIALS (path to your downloaded service account JSON key).");
  console.error("See the USAGE comment at the top of this script.");
  process.exit(1);
}

const app = initializeApp({
  projectId: PROJECT_ID,
  databaseURL: DATABASE_URL,
  credential: applicationDefault(), // reads GOOGLE_APPLICATION_CREDENTIALS
});

const auth = getAuth(app);
const db = getDatabase(app);

async function ensureUser(email, password, displayLabel) {
  try {
    const existing = await auth.getUserByEmail(email);
    console.log(`${displayLabel} user already exists: ${existing.uid}`);
    return existing.uid;
  } catch (e) {
    if (e.code !== "auth/user-not-found") throw e;
  }
  const created = await auth.createUser({ email, password, emailVerified: false });
  console.log(`Created ${displayLabel} user: ${created.uid}`);
  return created.uid;
}

async function main() {
  console.log(`Provisioning device "${DEVICE_ID}" on project "${PROJECT_ID}"...`);

  const controllerUid = await ensureUser(CONTROLLER_EMAIL, CONTROLLER_PASSWORD, "controller");

  const existingUser = await auth.getUser(controllerUid);
  const existingClaims = existingUser.customClaims || {};
  if (existingClaims.deviceId === DEVICE_ID) {
    console.log(`Custom claim deviceId="${DEVICE_ID}" already set on controller user — leaving it alone.`);
  } else {
    await auth.setCustomUserClaims(controllerUid, { ...existingClaims, deviceId: DEVICE_ID });
    console.log(`Set custom claim deviceId="${DEVICE_ID}" on controller user.`);
  }

  const infoSnap = await db.ref(`devices/${DEVICE_ID}/info`).get();
  if (!infoSnap.exists()) {
    await db.ref(`devices/${DEVICE_ID}/info`).set({
      model: DEVICE_MODEL,
      fw: FIRMWARE_VERSION,
    });
    console.log("Wrote initial devices/{deviceId}/info.");
  } else {
    console.log("devices/{deviceId}/info already exists — leaving it alone.");
  }

  console.log("\n✅ Provisioning complete!\n");
  console.log(`Device ID:      ${DEVICE_ID}`);
  console.log(`Controller UID: ${controllerUid}`);
  console.log("\nNext steps:");
  console.log(`  1. secrets.h on the ESP32: set FIREBASE_DEVICE_ID="${DEVICE_ID}",`);
  console.log(`     FIREBASE_CONTROLLER_EMAIL/PASSWORD to the values you just used here.`);
  console.log(`  2. Dashboard config (Entraiot Dashboard.dc.html): set deviceId: "${DEVICE_ID}".`);
  console.log(`  3. Power-cycle (or (re)flash) the ESP32 so it signs in fresh and picks up the new claim.`);
  console.log(`  4. Open the dashboard — no dashboard login is required by default (anonymous auth).`);

  process.exit(0);
}

main().catch((err) => {
  console.error("Provisioning failed:", err);
  process.exit(1);
});
