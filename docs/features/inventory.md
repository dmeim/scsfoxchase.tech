# Inventory lookup (`/inventory`)

Staff tool to look up a device by serial number / service tag, optionally via camera QR scan, and print a report. Prerendered page with client-side script; `robots` meta is `noindex,nofollow`.

## Routes

| Route | Source | Behavior |
|-------|--------|----------|
| `/inventory` | `src/pages/inventory.astro` | Lookup UI |
| `/inventory/` | `public/_redirects` | `301` → `/inventory` |

Title: “Inventory Lookup | St. Cecilia Technology”; `bodyClass="asset-lookup-page"`. Styles: `src/styles/inventory.css`. Logic: `src/scripts/inventory.ts`. QR decode library: `/vendor/jsQR.min.js` (inline script tag on the page).

## User-visible flow

1. Enter a serial in `#assetSerialInput` (input is forced uppercase on each keystroke), or use **Scan QR**, or open `/inventory?serial=…` (also accepts `serviceTag` / `tag` query params).
2. The page reads the shared public sitekey from `/api/forms/config`, then Turnstile issues a single-use `inventory_lookup` token without requiring Clerk sign-in.
3. **Lookup** POSTs the serial and token to the same-origin form proxy, which verifies Turnstile and forwards only the serial to n8n.
4. Successful lookup enables **Print Report** (`window.print()`); print chrome includes “St. Cecilia Inventory Report” and a timestamp.
5. On success, the URL is updated via `history.replaceState` to include `?serial=<SERIAL>`.

The field and camera scanner accept a plain serial (e.g. `ABC123XYZ`), a URL whose query includes `serial`, `serviceTag`, or `tag`, or text prefixed with `serial` / `serial:` / similar. Query parameter names are case-insensitive so URLs uppercased by keyboard-style scanners still work.

## Data source and matching

### Request

`src/scripts/inventory.ts` POSTs JSON to the same-origin Worker route:

```text
/api/forms/inventory
```

The same script first GETs `/api/forms/config`. That endpoint exposes only `PUBLIC_TURNSTILE_SITEKEY`, which is public by design; all secrets remain in Worker runtime bindings.

Browser body shape: `{ "serial": "<NORMALIZED_SERIAL>", "turnstileToken": "<TOKEN>" }` (`Content-Type: application/json`). Serial normalization: trim + uppercase.

The Worker enforces the production hostname and `inventory_lookup` action, limits submissions, validates an 8 KiB JSON body and serial shape, and then forwards `{ "serial": "<NORMALIZED_SERIAL>" }` to `${N8N_WEBHOOK_BASE_URL}/inventory`. The upstream request carries `X-SCS-Webhook-Key: <N8N_WEBHOOK_SECRET>`. Neither the n8n URL nor its credential is sent to the browser.

There is no inventory dataset in the Astro repo; matching happens on the webhook side (n8n / sheet workflow). The browser does not filter a local CSV or JSON file.

### Response handling

`normalizeLookupResponse` accepts flexible JSON:

- `{ found: false }` → treat as not found  
- Array → first element  
- Nested object under `asset`, `row`, `rows`, `result`, `results`, `items`, `data`, or `json` → unwrap recursively  
- Otherwise treat the object as the asset row  

Missing / empty result shows: “No device found for \<serial\>…”. The Turnstile widget is reset after every completed request so a spent token is never reused.

### Field mapping

Webhook row keys are matched case-insensitively via aliases, for example:

| Display / internal | Accepted keys (examples) |
|--------------------|---------------------------|
| Device Status | `Device Status`, `Overall Status`, `Status` |
| Assigned To | `Assigned To`, `Assigned`, `Assignee`, `User` |
| Device Number | `Device Number`, `Asset Number`, `Device #` |
| Serial | `Serial Number / Service Tag`, `Serial Number`, `Service Tag`, … |
| Express Service Code | `Express Service Code`, `Express Code` |
| Make / Model | `Make / Model`, `Make/Model`, `Model`, `Device Model` |
| Year Purchased | `Year Purchased`, `Purchase Year`, `Year` |
| Grant | `Grant` |
| Notes | `Notes`, `Note`, `Repair Notes` |

Component condition cards (Case, Chassis, Hinges, Display, Keyboard / Buttons, Trackpad / Mouse, Battery / Charging, Ports, Camera / Audio) read similarly aliased keys. Status chips use exact color maps from Google Sheet validation values (`Ok`, `Damaged`, `Warranty`, etc.) in `PART_STATUS_COLORS` / `DEVICE_STATUS_COLORS`.

### Device images

Known models map to fixed assets (e.g. Dell Chromebook 3100 → `/images/dell-chromebook-3100-1.jpg`). Otherwise the UI tries `/images/inventory/<slugified-model>.png`, then `/images/inventory/fallback-device.svg`.

## QR scanner

**Scan QR** opens a modal, requests `getUserMedia` (prefer `facingMode: environment`), draws frames to a canvas, and runs `jsQR`. On a successful decode, the serial fills the input, the scanner closes, and lookup runs automatically. Escape, Cancel, backdrop click, or tab hide stop the camera.

## Key files

| File | Role |
|------|------|
| `src/pages/inventory.astro` | Markup, modal, script imports |
| `src/scripts/inventory.ts` | Lookup, QR, print, field aliases |
| `src/worker/formRoutes.ts` | Public form allowlist, rate limit, validation, n8n forwarding |
| `src/worker/turnstile.ts` | Bounded Siteverify contract |
| `src/styles/inventory.css` | Layout + print styles |
| `public/vendor/jsQR.min.js` | QR decode |
| `public/_redirects` | `/inventory/` → `/inventory` |
| `src/scripts/icons.ts` | Search / QR / print / close icons |
