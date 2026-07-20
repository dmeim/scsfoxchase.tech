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
2. **Lookup** POSTs the serial to the inventory webhook and renders a report, or shows an error if nothing matches / the request fails.
3. Successful lookup enables **Print Report** (`window.print()`); print chrome includes “St. Cecilia Inventory Report” and a timestamp.
4. On success, the URL is updated via `history.replaceState` to include `?serial=<SERIAL>`.

Page copy: QR tags should store **only the serial as plain text** (e.g. `ABC123XYZ`). The scanner also accepts a URL whose query includes `serial`, `serviceTag`, or `tag`, or text prefixed with `serial` / `serial:` / similar.

## Data source and matching

### Request

`src/scripts/inventory.ts` POSTs JSON to:

```text
import.meta.env.PUBLIC_INVENTORY_WEBHOOK
  || 'https://n8n.mlabz.io/webhook/scs-inventory'
```

Body shape: `{ "serial": "<NORMALIZED_SERIAL>" }` (`Content-Type: application/json`). Serial normalization: trim + uppercase.

There is no inventory dataset in the Astro repo; matching happens on the webhook side (n8n / sheet workflow). The browser does not filter a local CSV or JSON file.

### Response handling

`normalizeLookupResponse` accepts flexible JSON:

- `{ found: false }` → treat as not found  
- Array → first element  
- Nested object under `asset`, `row`, `rows`, `result`, `results`, `items`, `data`, or `json` → unwrap recursively  
- Otherwise treat the object as the asset row  

Missing / empty result shows: “No device found for \<serial\>…”.

If the webhook URL constant were empty and `USE_MOCK_WHEN_NO_WEBHOOK` is true, the script returns a hardcoded demo row keyed to the entered serial (and can show a config notice). With the built-in fallback URL above, live lookups go to that endpoint unless `PUBLIC_INVENTORY_WEBHOOK` overrides it.

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
| `src/styles/inventory.css` | Layout + print styles |
| `public/vendor/jsQR.min.js` | QR decode |
| `public/_redirects` | `/inventory/` → `/inventory` |
| `src/scripts/icons.ts` | Search / QR / print / close icons |
