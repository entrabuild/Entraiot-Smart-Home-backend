# EntraIoT Realtime Database Schema — v2.0 (direct ESP32 <-> Firebase)

> This is the single source of truth for the database structure. If
> anything here changes, update `database.rules.json`, the ESP32's
> `syncToCloud()`, and `firebase-client.js` together — all three must agree
> on paths and shapes.
>
> **v2.0 supersedes the old `homes/{homeId}/...` multi-tenant schema.**
> This version is deliberately simpler: one flat `devices/{deviceId}` tree,
> no home/membership concept, no Cloud Functions in the write path, and no
> historical data unless you explicitly add it back (see SETUP.md's
> storage/bandwidth section for why).

## Design principles

- **Direct connection, no server in the data path.** The ESP32 writes
  straight to Firebase Realtime Database via the REST API; the dashboard
  reads via live listeners on the Firebase Web SDK. Neither talks to the
  other, and no backend/Cloud Function sits between them for basic sensor
  data delivery.
- **Only the device writes its own device state.** A write to
  `devices/{deviceId}` is only accepted from a session whose ID token
  carries a `deviceId` custom claim equal to `{deviceId}` (see
  `database.rules.json` and `scripts/provision-production.js`). No client
  (dashboard, browser, app) can write sensor/status/heartbeat data.
- **Current values only, not history.** Every field under `sensors`,
  `status`, `heartbeat`, and `info` is a scalar that gets **overwritten**
  on every write — there is no per-reading log. `alerts` is the one
  append-only list, and it's bounded by the optional `cleanup-alerts`
  Netlify function (see SETUP.md Part 4).
- **Safety never depends on the cloud.** Fire/gas/vibration/rain
  conditions are detected locally by the ESP32 regardless of Firebase
  reachability; a cloud alert write is best-effort on top of that, not a
  requirement for the physical safety response.

---

## Tree overview

```
/ (Realtime Database root)
├── users/{uid}/
│   └── profile: { name, email, createdAt }        (reserved for future use — not written by anything today)
│
└── devices/{deviceId}/
    ├── info/          { model, fw }                     — written rarely (first sync, or by provision-production.js)
    ├── status/        { lastSeen, wifiRSSI }             — written on every sync (every 3-5s)
    ├── sensors/       { temperature, humidity, gas,
    │                    fire, vibration, rain, soil,
    │                    motion, distance }               — bare scalars, written on every sync
    ├── heartbeat/     { uptimeS, freeHeap, ip, mac,
    │                    fw, rssi }                        — written periodically (every HEARTBEAT_EVERY_N_SYNCS ticks)
    └── alerts/{pushId}: { type, message, ts }             — written immediately on a meaningful state change
```

That's the entire schema. There is no `commands`, `devices` (actuator
states), `config`, `members`, `telemetry`, or `_raw` node in v2.0 — this
hardware build is sensors-only (see the ESP32 README's hardware table), so
there's nothing to actuate and no per-user config to store yet. Add those
back deliberately, with matching rules, if you wire up relays or build a
settings screen later.

---

## Field-by-field reference

### `users/{uid}` (reserved, unused by the current pipeline)
| Field | Type | Notes |
|---|---|---|
| `profile.name` | string | Display name |
| `profile.email` | string | Matches Auth email |
| `profile.createdAt` | number (ms) | Account creation time |

Rules already protect this path (`auth.uid == $uid` for both read and
write) so it's ready to use once something actually writes to it.

### `devices/{deviceId}/info`
| Field | Type | Notes |
|---|---|---|
| `model` | string | e.g. `"esp32-devkit-30pin"` |
| `fw` | string | Firmware version, e.g. `"1.1.0"` |

### `devices/{deviceId}/status`
| Field | Type | Notes |
|---|---|---|
| `lastSeen` | number (Firebase server timestamp, via `{".sv":"timestamp"}`) | Written on **every** sync. This — not a stored boolean — is what the dashboard uses to decide online/offline: if `Date.now() - lastSeen` exceeds a threshold (15s in the dashboard's own live check), the device is shown offline. There is intentionally no `online`/`offline` boolean stored here: a device that crashes or loses power can't reliably write "I'm now offline" on its way out, so a client-side staleness check is more trustworthy than trusting the device to self-report its own failure. |
| `wifiRSSI` | number | WiFi signal strength (dBm), refreshed every sync |

### `devices/{deviceId}/sensors`
Every field is a **bare scalar** — no `{v, raw, ts}` wrapper. Written by
the ESP32 only, every `CLOUD_SYNC_INTERVAL_MS` (3-5s per the firmware
default). Read live by the dashboard.

| Sensor | Type | Meaning |
|---|---|---|
| `temperature` | number | Degrees Celsius |
| `humidity` | number | Percent |
| `gas` | number (0-1000) | Normalized MQ-2 reading — see `rawToGasCloudPct()` in the firmware. The dashboard's Poor/Moderate/Good and smoke-alert thresholds are hardcoded against this 0-1000 scale. |
| `fire` | boolean | true = flame detected |
| `vibration` | boolean | true = vibration detected |
| `rain` | number (0-100) | Rain intensity percent, already normalized on-device |
| `soil` | number (0-100) | Soil moisture percent |
| `motion` | boolean | true = motion detected (PIR) |
| `distance` | number | Centimeters (HC-SR04), omitted from the write if the sensor read failed that tick |

### `devices/{deviceId}/heartbeat`
Written less often than `sensors`/`status` — every `HEARTBEAT_EVERY_N_SYNCS`
sync ticks (and always on the first successful sync after boot).

| Field | Type | Notes |
|---|---|---|
| `uptimeS` | number | Seconds since the device last rebooted |
| `freeHeap` | number | Free heap memory, in KB |
| `ip` | string | Current local IP address, e.g. `"192.168.1.147"` |
| `mac` | string | Device MAC address |
| `fw` | string | Firmware version as currently running (self-reported) |
| `rssi` | number | WiFi signal strength (dBm) at write time — `status/wifiRSSI` is the fresher copy of this since it's written every sync, not just every heartbeat |

### `devices/{deviceId}/alerts/{pushId}`
| Field | Type | Notes |
|---|---|---|
| `type` | string | `"fire"`, `"gas"`, `"vibration"`, `"rain"`, or `"offline"` (the last one only from the optional `check-offline-devices` Netlify function, not the ESP32) |
| `message` | string | Human-readable description |
| `ts` | number (Firebase server timestamp) | When it happened, per Firebase's clock — not the device's local clock, which may not have NTP synced yet at boot |

Pushed immediately by the ESP32 on a debounced state change — not batched
into the regular sensor sync — so alerts show up on the dashboard within
about a second, independent of the normal 3-5s cadence.

---

## Write cadence (who writes what, how often)

| Path | Writer | Cadence |
|---|---|---|
| `sensors/*`, `status/*` | ESP32 | Every `CLOUD_SYNC_INTERVAL_MS` (3-5s), one multi-path PATCH |
| `heartbeat/*` | ESP32 | Every `HEARTBEAT_EVERY_N_SYNCS` sync ticks, folded into the same PATCH |
| `info/*` | ESP32 (first successful sync only) or `provision-production.js` (optional pre-seed) | Rare |
| `alerts/*` | ESP32 (fire/gas/vibration/rain) or the optional `check-offline-devices` Netlify function (offline) | Immediately on a debounced state change |

No path in this schema is written by the dashboard/frontend. The frontend
is read-only against Firebase.
