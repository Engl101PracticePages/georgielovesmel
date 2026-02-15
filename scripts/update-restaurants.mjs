// scripts/update-restaurants.mjs
// GitHub Action script:
// - Reads your Google Sheet (published CSV)
// - For each row with a place_id, calls Place Details (Legacy)
// - Writes restaurants.json to repo root
//
// Uses GOOGLE_MAPS_API_KEY from GitHub Secrets.

import fs from "node:fs/promises";

const SHEET_CSV_URL =
  "https://docs.google.com/spreadsheets/d/e/2PACX-1vQ9pFuDf9lpudF0_WfUJ2cJlbowZMmtV9VYxnTDeSq4uFMRUnm3yMZzro982N_C9WrDoXYf9GH_5VM5/pub?output=csv";

const API_KEY = process.env.GOOGLE_MAPS_API_KEY;

if (!API_KEY) {
  console.error("Missing GOOGLE_MAPS_API_KEY env var.");
  process.exit(1);
}

// --- CSV parsing (handles quotes) ---
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const next = text[i + 1];

    if (inQuotes) {
      if (c === '"' && next === '"') {
        field += '"';
        i++;
      } else if (c === '"') {
        inQuotes = false;
      } else {
        field += c;
      }
    } else {
      if (c === '"') {
        inQuotes = true;
      } else if (c === ",") {
        row.push(field);
        field = "";
      } else if (c === "\n") {
        row.push(field);
        rows.push(row);
        row = [];
        field = "";
      } else if (c === "\r") {
        // ignore
      } else {
        field += c;
      }
    }
  }

  // last field/row
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  return rows;
}

function normalize(s) {
  return (s ?? "").toString().trim();
}

function lower(s) {
  return normalize(s).toLowerCase();
}

function toNumberOrNull(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// --- Time helpers for "closing soon" ---
function computeNextCloseIso(openingHours, utcOffsetMinutes) {
  // Based on opening_hours.periods and utc_offset (minutes) from Place Details (Legacy).
  // We'll compute the next upcoming "close" moment in UTC ISO string.
  if (!openingHours || !Array.isArray(openingHours.periods)) return null;
  if (!Number.isFinite(utcOffsetMinutes)) return null;

  const nowUtcMs = Date.now();
  const offsetMs = utcOffsetMinutes * 60 * 1000;

  // Convert "now" into a shifted timeline so we can use UTC getters as "local" getters
  const nowLocalMs = nowUtcMs + offsetMs;
  const nowLocal = new Date(nowLocalMs);

  const nowLocalDay = nowLocal.getUTCDay(); // 0-6 (Sunday=0)
  const y = nowLocal.getUTCFullYear();
  const m = nowLocal.getUTCMonth();
  const d = nowLocal.getUTCDate();

  // local midnight (in the shifted timeline)
  const localMidnightMs = Date.UTC(y, m, d);

  let bestCloseUtcMs = null;

  for (const p of openingHours.periods) {
    if (!p || !p.close || !p.close.time || typeof p.close.day !== "number") {
      continue; // no close (possibly 24h) or malformed
    }

    const closeDay = p.close.day; // 0-6
    const t = p.close.time; // "HHMM"
    if (typeof t !== "string" || t.length < 3) continue;

    const hh = Number(t.slice(0, 2));
    const mm = Number(t.slice(2, 4));
    if (!Number.isFinite(hh) || !Number.isFinite(mm)) continue;

    const minutes = hh * 60 + mm;

    const deltaDays = (closeDay - nowLocalDay + 7) % 7;
    const closeLocalShiftedMs = localMidnightMs + deltaDays * 86400000 + minutes * 60000;

    // Convert back to UTC timeline
    const closeUtcMs = closeLocalShiftedMs - offsetMs;

    if (closeUtcMs > nowUtcMs) {
      if (bestCloseUtcMs === null || closeUtcMs < bestCloseUtcMs) {
        bestCloseUtcMs = closeUtcMs;
      }
    }
  }

  return bestCloseUtcMs ? new Date(bestCloseUtcMs).toISOString() : null;
}

// --- Places Details (Legacy) ---
async function fetchPlaceDetails(placeId) {
  const fields = [
    "name",
    "formatted_address",
    "geometry/location",
    "opening_hours",
    "utc_offset",
    "website",
    "formatted_phone_number",
    "url",
    "business_status"
  ].join(",");

  const url =
    "https://maps.googleapis.com/maps/api/place/details/json" +
    `?place_id=${encodeURIComponent(placeId)}` +
    `&fields=${encodeURIComponent(fields)}` +
    `&key=${encodeURIComponent(API_KEY)}`;

  const res = await fetch(url);
  const data = await res.json();

  if (data.status !== "OK") {
    return { ok: false, status: data.status, error_message: data.error_message || null, result: null };
  }

  return { ok: true, status: data.status, error_message: null, result: data.result };
}

async function main() {
  console.log("Fetching sheet CSV...");
  const csvRes = await fetch(SHEET_CSV_URL);
  if (!csvRes.ok) {
    throw new Error(`Failed to fetch CSV: ${csvRes.status} ${csvRes.statusText}`);
  }
  const csvText = await csvRes.text();
  const rows = parseCsv(csvText);

  if (rows.length < 1) {
    throw new Error("CSV appears empty.");
  }

  const header = rows[0].map(h => lower(h));
  const idx = (name) => header.indexOf(name);

  const col = {
    name: idx("name"),
    category: idx("category"),
    google_maps_url: idx("google_maps_url"),
    place_id: idx("place_id"),
    notes: idx("notes"),
    speed: idx("speed"),
    price: idx("price"),
  };

  for (const [k, v] of Object.entries(col)) {
    if (v === -1) {
      throw new Error(`Missing required column header: ${k}`);
    }
  }

  const out = [];
  let okCount = 0;
  let failCount = 0;

  // Process data rows
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    if (!row || row.length === 0) continue;

    const base = {
      name: normalize(row[col.name]),
      category: lower(row[col.category]),
      google_maps_url: normalize(row[col.google_maps_url]),
      place_id: normalize(row[col.place_id]),
      notes: normalize(row[col.notes]),
      speed: lower(row[col.speed]),
      price: normalize(row[col.price]),
    };

    // Skip totally blank lines
    const anyData = Object.values(base).some(v => normalize(v).length > 0);
    if (!anyData) continue;

    // If no place_id, we still keep the row but without hours/geo
    if (!base.place_id) {
      out.push({
        ...base,
        address: null,
        lat: null,
        lng: null,
        open_now: null,
        weekday_text: [],
        website: null,
        phone: null,
        url: base.google_maps_url || null,
        next_close_iso: null,
        business_status: null,
      });
      continue;
    }

    const details = await fetchPlaceDetails(base.place_id);

    if (!details.ok) {
      failCount++;
      console.log(`Place details failed (${base.place_id}): ${details.status} ${details.error_message || ""}`.trim());
      out.push({
        ...base,
        address: null,
        lat: null,
        lng: null,
        open_now: null,
        weekday_text: [],
        website: null,
        phone: null,
        url: base.google_maps_url || null,
        next_close_iso: null,
        business_status: null,
        _error: { status: details.status, message: details.error_message }
      });
      continue;
    }

    okCount++;

    const pr = details.result || {};
    const loc = pr.geometry && pr.geometry.location ? pr.geometry.location : null;
    const opening = pr.opening_hours || null;
    const utcOffset = toNumberOrNull(pr.utc_offset);
    const nextCloseIso = computeNextCloseIso(opening, utcOffset);

    out.push({
      ...base,
      name: base.name || pr.name || "",
      address: pr.formatted_address || null,
      lat: loc ? toNumberOrNull(loc.lat) : null,
      lng: loc ? toNumberOrNull(loc.lng) : null,
      open_now: opening ? (opening.open_now === true) : null,
      weekday_text: opening && Array.isArray(opening.weekday_text) ? opening.weekday_text : [],
      website: pr.website || null,
      phone: pr.formatted_phone_number || null,
      url: pr.url || base.google_maps_url || null,
      next_close_iso: nextCloseIso,
      business_status: pr.business_status || null,
      utc_offset: utcOffset,
    });
  }

  const payload = {
    generated_at: new Date().toISOString(),
    source_csv: SHEET_CSV_URL,
    counts: {
      total_rows: out.length,
      places_ok: okCount,
      places_failed: failCount,
    },
    restaurants: out
  };

  await fs.writeFile("restaurants.json", JSON.stringify(payload, null, 2), "utf8");
  console.log(`Wrote restaurants.json with ${out.length} places.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
