# EntraIoT ESP32 Integration Guide (v2.0 — direct Firebase connection)

This is the contract the ESP32 firmware (`Entraiot_ESP32_IoT.ino`) actually
implements against Firebase Realtime Database. See also
`docs/architecture/rtdb-schema.md` for the database tree itself — this
document is the firmware-facing "how to talk to it" companion, describing
the REST calls, not just the shape of the data they produce.

There is no backend server anywhere in this path. The device talks
directly to Firebase's public REST API over HTTPS.

---

## 1. Firebase configuration

The ESP32 talks to the Firebase **Realtime Database REST API** and
**Identity Toolkit REST API** directly over HTTPS (`WiFiClientSecure` +
`HTTPClient`) — no Firebase C++ SDK needed. Configured in `secrets.h`:

| Value | Where to get it |
|---|---|
| `FIREBASE_API_KEY` | Firebase Console → Project settings → General → Your apps → Web app |
| `FIREBASE_DATABASE_URL` | Firebase Console → Realtime Database, e.g. `https://<project>-default-rtdb.asia-southeast1.firebasedatabase.app` |
| `FIREBASE_DEVICE_ID` | Chosen when you run `scripts/provision-production.js` — must match its `deviceId` custom claim exactly |
| `FIREBASE_CONTROLLER_EMAIL` / `FIREBASE_CONTROLLER_PASSWORD` | The Firebase Auth user `provision-production.js` creates/reuses for this device |

None of these are Admin SDK credentials — `FIREBASE_API_KEY` is a public
project identifier (safe in firmware/frontend by design), and the
controller email/password only grants what `database.rules.json` allows a
correctly-clamed session to do: write `devices/{FIREBASE_DEVICE_ID}` and
nothing else.

## 2. Authentication

The device signs in as a Firebase Auth **email/password** user (the
"controller" account) whose ID token carries a `deviceId` custom claim —
set once by `scripts/provision-production.js`, not by the firmware.
`database.rules.json` requires `auth.token.deviceId == $deviceId` to write
under `devices/{deviceId}`; the claim is what makes that check pass.

- **Sign in:** `POST https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=<FIREBASE_API_KEY>`
  with `{ "email": ..., "password": ..., "returnSecureToken": true }`.
  Returns `idToken` (valid ~1 hour) and `refreshToken`.
- **Refresh (proactive, before expiry — not just on a 401):**
  `POST https://securetoken.googleapis.com/v1/token?key=<FIREBASE_API_KEY>`
  with `grant_type=refresh_token&refresh_token=<refreshToken>`.
- See `signInFirebase()` / `refreshFirebaseToken()` / `ensureFirebaseAuth()`
  in the `.ino` for the exact implementation, including the
  `DynamicJsonDocument(2048)` sizing needed because ID tokens (JWTs) run
  ~900-1100 characters.

## 3. Database paths (device-writable)

Per `database.rules.json`, a session with the matching `deviceId` claim may
write anywhere under `devices/{deviceId}` — sub-paths listed here for
clarity, but note the rule is a single cascading `.write` at
`devices/$deviceId`, not one rule per child:

| Path | What |
|---|---|
| `devices/{deviceId}/sensors/*` | Current sensor readings (bare scalars) |
| `devices/{deviceId}/status/*` | `lastSeen` (server timestamp) + `wifiRSSI`, every sync |
| `devices/{deviceId}/heartbeat/*` | Liveness/health, every `HEARTBEAT_EVERY_N_SYNCS` ticks |
| `devices/{deviceId}/info/*` | Model/firmware — normally written once by `provision-production.js` or the firmware's first sync |
| `devices/{deviceId}/alerts` | Fire/gas/vibration/rain alerts (push-only; nothing acknowledges them in this schema) |

The device does not need to **read** anything from Firebase in this
version — there's no `commands` node to poll (this hardware build has no
relays/actuators; see the ESP32 README's hardware table). If you add
actuators later, that's a schema/rules addition, not something this
firmware does today.

## 4. Cloud sync request format

One HTTPS `PATCH` per sync tick, covering multiple paths at once via
Firebase's multi-path update format (slash-delimited keys in a flat JSON
object):

`PATCH https://<db-url>/devices/{deviceId}.json?auth=<idToken>`
```json
{
  "sensors/temperature": 24.6,
  "sensors/humidity": 55,
  "sensors/gas": 180,
  "sensors/fire": false,
  "sensors/rain": 12,
  "sensors/soil": 48,
  "sensors/motion": true,
  "sensors/vibration": false,
  "sensors/distance": 120,
  "status/lastSeen": { ".sv": "timestamp" },
  "status/wifiRSSI": -55
}
```
Every `CLOUD_SYNC_INTERVAL_MS` (3-5s by default). `{".sv": "timestamp"}` is
Firebase's server-value placeholder — the database replaces it with the
actual server time on write, so the device's own clock/NTP sync being
slightly off never matters for `lastSeen`.

Every `HEARTBEAT_EVERY_N_SYNCS` ticks (and always on the first successful
sync after boot), the same PATCH additionally includes:
```json
{
  "info/model": "esp32-devkit-30pin",
  "info/fw": "1.1.0",
  "heartbeat/uptimeS": 3600,
  "heartbeat/freeHeap": 210,
  "heartbeat/ip": "192.168.1.147",
  "heartbeat/mac": "A4:CF:12:8B:3E:9D",
  "heartbeat/fw": "1.1.0",
  "heartbeat/rssi": -55
}
```

Field notes:
- `sensors/gas` — normalized 0-1000 scale (`rawToGasCloudPct()`), not the
  raw ADC value. The dashboard's Poor/Moderate/Good and smoke-alert
  thresholds are hardcoded against this scale.
- `sensors/rain`, `sensors/soil` — already normalized to 0-100 percent
  on-device before sending; no separate `raw` field is sent to Firebase.
- `sensors/distance` — omitted from the PATCH entirely on a tick where the
  ultrasonic read failed, rather than sending a stale/garbage value.
- **Smoke:** there's no separate `smoke` field — the MQ-2 sensor already
  used for `gas` is the same physical sensor conventionally used for smoke
  detection. The dashboard derives "smoke detected" from `sensors/gas >
  750`. Add a real `smoke` field later if you wire a dedicated sensor;
  don't overload `gas` further.

See `syncToCloud()` in the `.ino` for the exact implementation
(`firebasePatchDevice()` does the actual HTTPS PATCH via
`http.sendRequest("PATCH", ...)`, used instead of the `.PATCH()`
convenience method for compatibility across ESP32 `HTTPClient` versions).

## 5. Alert format

Fire/gas/vibration/rain conditions push an entry immediately — not batched
into the regular sync — as soon as a debounced state change is detected:

`POST https://<db-url>/devices/{deviceId}/alerts.json?auth=<idToken>`
```json
{ "type": "fire", "message": "Flame detected", "ts": { ".sv": "timestamp" } }
```
`type` ∈ `fire | gas | vibration | rain`. See `maybePushAlert()` /
`checkAndPushAlerts()` in the `.ino`. Debounced on-device so a sustained
alarm condition doesn't spam a new entry every sync tick.

## 6. Error handling & reconnect logic (as implemented)

- **WiFi drop:** `syncToCloud()` returns immediately if
  `WiFi.status() != WL_CONNECTED` — no buffering/replay of stale readings.
  Local sensors, OLED, and the `/data` HTTP API keep working throughout;
  only the cloud PATCH is skipped. Reconnection is handled by the
  firmware's normal WiFi reconnect loop; once WiFi is back, the very next
  scheduled sync tick resumes cloud writes with fresh data, no special
  "catch-up" step needed since only current values are stored anyway.
- **Firebase/auth failure:** `ensureFirebaseAuth()` runs before every sync
  and proactively refreshes the token before it expires — writes don't
  wait for a 401 to trigger a refresh. On an actual 401 mid-write, the
  firmware retries the same PATCH once with a freshly refreshed token (see
  the 401-retry branch of `firebasePatchDevice()`).
- **Database write failure (5xx/network error):** `handleCloudSyncResult()`
  sets `cloudBackoffUntil` and the next `syncToCloud()` call is a no-op
  until that backoff window passes — exponential-ish backoff without
  hammering Firebase on a sustained outage.
- **4xx (rules rejection):** logged loudly with a hint to check
  `FIREBASE_DEVICE_ID` against the `deviceId` custom claim
  (`provision-production.js` / SETUP.md) rather than retried — a
  permissions mismatch won't fix itself by retrying.
- **Reboot:** on boot, the firmware signs in fresh (no cached token reused
  across a reboot) and the first successful `syncToCloud()` call always
  includes the `info`/`heartbeat` fields regardless of the
  `HEARTBEAT_EVERY_N_SYNCS` counter, so a freshly-booted device's identity
  shows up in Firebase immediately rather than waiting for the next
  periodic heartbeat tick.
