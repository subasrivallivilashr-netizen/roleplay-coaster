/**
 * ============================================================================
 *  ROLEPLAY COASTER — Cloudflare Worker (all backend logic lives in this file)
 * ============================================================================
 *
 *  What this file does, in plain English:
 *
 *   1. Holds the Google "service account" login. It builds a signed JWT with the
 *      Web Crypto API, swaps it for an access token, and remembers the token
 *      until shortly before it expires. (The "googleapis" npm package does not
 *      work on Workers, so we talk to the REST API with fetch ourselves.)
 *   2. Reads and writes the Google Sheet. Rarely-changing tabs are cached in
 *      memory for 5 minutes so we stay well under the Sheets API quota.
 *   3. Answers the /api/* routes that public/index.html calls.
 *
 *  Nothing here is sent to the browser except the JSON the routes return.
 *  Secrets live in Cloudflare (wrangler secret put) and in .dev.vars locally.
 *
 *  Read the numbered sections below top to bottom. They are in the order the
 *  code runs.
 * ============================================================================
 */

/* ==========================================================================
   0. SMALL HELPERS used everywhere
   ========================================================================== */

// Set once at the start of every request. All requests in the same Worker
// instance share the same secret values, so this is safe and keeps the helpers
// short and readable.
let ENV = null;

const JSON_HEADERS = {
  "Content-Type": "application/json; charset=utf-8",
  // Never let a browser or proxy keep a copy of API answers.
  "Cache-Control": "no-store",
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: JSON_HEADERS });
}

/** An error we deliberately created, with a friendly Tamil + English message. */
class ApiError extends Error {
  constructor(status, code, messageTa, messageEn, hint = "") {
    super(messageEn);
    this.status = status;
    this.code = code;
    this.ta = messageTa;
    this.en = messageEn;
    this.hint = hint;
  }
}

function errorResponse(err) {
  if (err instanceof ApiError) {
    return json(
      {
        error: {
          code: err.code,
          message_ta: err.ta,
          message_en: err.en,
          hint: err.hint || undefined,
        },
      },
      err.status
    );
  }
  // Something unexpected. Log it so it appears in `wrangler tail` / the dashboard.
  console.error("Unexpected error:", err);
  return json(
    {
      error: {
        code: "UNEXPECTED",
        message_ta: "எதிர்பாராத பிழை. மீண்டும் முயற்சிக்கவும்.",
        message_en: "Unexpected error: " + (err && err.message ? err.message : String(err)),
      },
    },
    500
  );
}

/** Trim any sheet value into a clean string. */
function txt(value) {
  return value === undefined || value === null ? "" : String(value).trim();
}

/** Sheet value -> number (0 when it is blank or not a number). */
function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

/** "Y" / "y" / "yes" -> true */
function yes(value) {
  const v = txt(value).toUpperCase();
  return v === "Y" || v === "YES";
}

/** Base64url for one string of text (no padding — that is what JWT needs). */
function textToBase64Url(text) {
  return bytesToBase64Url(new TextEncoder().encode(text));
}

/** Base64url for raw bytes (used for the RSA signature). */
function bytesToBase64Url(bytes) {
  let binary = "";
  const chunkSize = 0x8000; // feed String.fromCharCode in chunks, not one huge string
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/* ---------- randomness (crypto, never Math.random) ---------- */

/**
 * A random whole number from 0 to maxExclusive-1.
 * Rejection sampling so every value is equally likely (no modulo bias).
 */
function cryptoRandomInt(maxExclusive) {
  if (maxExclusive <= 1) return 0;
  const range = 0x100000000; // 2^32
  const limit = Math.floor(range / maxExclusive) * maxExclusive;
  const buffer = new Uint32Array(1);
  let value;
  do {
    crypto.getRandomValues(buffer);
    value = buffer[0];
  } while (value >= limit);
  return value % maxExclusive;
}

/** Pick one item from a non-empty list, fairly. */
function pickOne(list) {
  return list[cryptoRandomInt(list.length)];
}

/* ---------- dates in India Standard Time ---------- */

/**
 * Today's date and time in Asia/Kolkata, as text: "2026-11-12" and "09:30".
 * The sheet expects dates written as text (YYYY-MM-DD), so we never send a
 * JavaScript Date object to Google.
 */
function istNow() {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date());

  const get = (type) => {
    const found = parts.find((p) => p.type === type);
    return found ? found.value : "";
  };

  const date = get("year") + "-" + get("month") + "-" + get("day");
  const time = get("hour") + ":" + get("minute");
  return { date, time, stamp: date + " " + time };
}

/** Read a JSON body without exploding when it is empty. */
async function readJsonBody(request) {
  try {
    const text = await request.text();
    return text ? JSON.parse(text) : {};
  } catch (e) {
    return {};
  }
}

/* ==========================================================================
   1. CONFIGURATION
   ========================================================================== */

// The tabs and columns we use. Change nothing here unless the sheet changes.
const SHEET = {
  employees: "Employees",
  attributes: "Attributes",
  cards: "Customer_Cards",
  concepts: "Concepts",
  settings: "Settings",
  schedule: "Schedule",
  discovery: "Discovery_Marks",
  ratings: "Concept_Ratings",
  scores: "Scores",
  rotations: "Rotations",
};

const REQUIRED_SECRETS = [
  "GOOGLE_SERVICE_ACCOUNT_EMAIL",
  "GOOGLE_PRIVATE_KEY",
  "SHEET_ID",
];

/** Fail early with a clear message if a secret is missing. */
function assertConfig() {
  const missing = REQUIRED_SECRETS.filter((key) => !ENV[key]);
  if (missing.length > 0) {
    throw new ApiError(
      500,
      "CONFIG_MISSING",
      "Worker அமைப்பில் ரகசியங்கள் இல்லை. README படியுங்கள்.",
      "These Worker secrets are missing: " + missing.join(", "),
      "Run: wrangler secret put NAME   (or add them to .dev.vars locally), then reload."
    );
  }
}

/* ==========================================================================
   2. GOOGLE LOGIN (service account JWT -> access token)
   ========================================================================== */

// Remember the token for this Worker instance: { token, expiresAt }.
let googleToken = { token: null, expiresAt: 0 };

/**
 * Google stores the private key as a PEM block. When it is pasted into a
 * terminal or a secret, real line breaks often turn into the two characters
 * "\" and "n". This puts real line breaks back.
 */
function normalizePrivateKey(pem) {
  return String(pem).replace(/\\n/g, "\n").trim();
}

/** Turn the PEM text into the raw key bytes Web Crypto understands (PKCS#8). */
function pemToPkcs8Bytes(pem) {
  const base64 = normalizePrivateKey(pem)
    .replace("-----BEGIN PRIVATE KEY-----", "")
    .replace("-----END PRIVATE KEY-----", "")
    .replace(/\s+/g, "");

  let raw;
  try {
    raw = atob(base64);
  } catch (e) {
    throw new ApiError(
      500,
      "GOOGLE_KEY_FORMAT",
      "Google private key படிக்க முடியவில்லை.",
      "GOOGLE_PRIVATE_KEY is not valid base64. Make sure you pasted the whole key.",
      "Copy private_key from the downloaded JSON key file, including BEGIN and END lines."
    );
  }

  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

/**
 * Returns a valid Google access token, reusing the cached one while possible.
 * Steps: build header + claims -> sign with RS256 -> POST to oauth2 -> token.
 */
async function getGoogleAccessToken() {
  const nowSec = Math.floor(Date.now() / 1000);

  // Still valid with 2 minutes to spare? Reuse it.
  if (googleToken.token && googleToken.expiresAt - 120 > nowSec) {
    return googleToken.token;
  }

  const email = txt(ENV.GOOGLE_SERVICE_ACCOUNT_EMAIL);
  const privateKeyPem = ENV.GOOGLE_PRIVATE_KEY;

  const header = { alg: "RS256", typ: "JWT" };
  const claims = {
    iss: email,
    scope: "https://www.googleapis.com/auth/spreadsheets",
    aud: "https://oauth2.googleapis.com/token",
    iat: nowSec,
    exp: nowSec + 3600, // Google allows at most 1 hour
  };

  const signingInput =
    textToBase64Url(JSON.stringify(header)) + "." + textToBase64Url(JSON.stringify(claims));

  let cryptoKey;
  try {
    cryptoKey = await crypto.subtle.importKey(
      "pkcs8",
      pemToPkcs8Bytes(privateKeyPem),
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["sign"]
    );
  } catch (e) {
    // If it is already one of our friendly errors (e.g. bad base64), keep it.
    if (e instanceof ApiError) throw e;
    throw new ApiError(
      500,
      "GOOGLE_KEY_INVALID",
      "Google private key தவறானது.",
      "Google rejected the private key format: " + e.message,
      "Re-set GOOGLE_PRIVATE_KEY with the full private_key value from the JSON key file."
    );
  }

  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    cryptoKey,
    new TextEncoder().encode(signingInput)
  );

  const jwt = signingInput + "." + bytesToBase64Url(new Uint8Array(signature));

  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: jwt,
    }),
  });

  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch (e) {
    data = null;
  }

  if (!response.ok || !data || !data.access_token) {
    const googleMsg = (data && data.error_description) || (data && data.error) || text.slice(0, 300);
    throw new ApiError(
      502,
      "GOOGLE_AUTH_FAILED",
      "Google உள்நுழைவு தோல்வி. சேவை கணக்கைச் சரிபார்க்கவும்.",
      "Google login failed: " + googleMsg,
      "Check that the service account email in the secret matches the JSON key, and that the clock is correct."
    );
  }

  googleToken = {
    token: data.access_token,
    expiresAt: nowSec + num(data.expires_in || 3600),
  };
  return googleToken.token;
}

/* ==========================================================================
   3. GOOGLE SHEETS API (read + write helpers)
   ========================================================================== */

const SHEETS_BASE = "https://sheets.googleapis.com/v4/spreadsheets";

/** Every Sheets call goes through here so auth + error handling live in one place. */
async function sheetsRequest(pathAndQuery, init = {}) {
  const token = await getGoogleAccessToken();
  const url = `${SHEETS_BASE}/${encodeURIComponent(ENV.SHEET_ID)}${pathAndQuery}`;

  const response = await fetch(url, {
    ...init,
    headers: {
      Authorization: "Bearer " + token,
      ...(init.headers || {}),
    },
  });

  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch (e) {
    data = null;
  }

  if (!response.ok) {
    const googleMsg = (data && data.error && data.error.message) || text.slice(0, 300);
    const isPermission = response.status === 403 || response.status === 404;
    throw new ApiError(
      502,
      "SHEETS_API",
      isPermission
        ? "Google Sheet அனுமதி இல்லை. சேவை கணக்கு மின்னஞ்சலுடன் Editor ஆகப் பங்கிடுங்கள்."
        : "Google Sheet படிக்க முடியவில்லை.",
      "Google Sheets error (" + response.status + "): " + googleMsg,
      isPermission
        ? "Share the spreadsheet with the service account email as Editor. Also check SHEET_ID."
        : "Try again. If it keeps failing, check the Google Cloud quotas."
    );
  }

  return data;
}

/**
 * Read one range, e.g. "Employees!A:E".
 * UNFORMATTED_VALUE gives us real numbers for score cells instead of text.
 */
async function readRange(range) {
  const data = await sheetsRequest(
    `/values/${encodeURIComponent(range)}?majorDimension=ROWS&valueRenderOption=UNFORMATTED_VALUE`
  );
  return (data && data.values) || [];
}

/** Read several ranges in ONE request (saves quota). Returns { range: rows }. */
async function readRanges(ranges) {
  if (!ranges.length) return {};
  const query = ranges.map((r) => `ranges=${encodeURIComponent(r)}`).join("&");
  const data = await sheetsRequest(
    `/values:batchGet?${query}&majorDimension=ROWS&valueRenderOption=UNFORMATTED_VALUE`
  );
  const out = {};
  const valueRanges = (data && data.valueRanges) || [];
  valueRanges.forEach((vr, index) => {
    out[ranges[index]] = vr.values || [];
  });
  return out;
}

/**
 * Append rows at the end of a tab.
 * USER_ENTERED makes Sheets read "3" as a number and "2026-11-12" as text/date
 * exactly like a person typing it, which is what the sheet formulas expect.
 */
async function appendRows(range, rows) {
  if (!rows.length) return null;
  return sheetsRequest(
    `/values/${encodeURIComponent(range)}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ majorDimension: "ROWS", values: rows }),
    }
  );
}

/**
 * Write many ranges at once, e.g. update 50 rating rows in a single call.
 * data = [{ range: "Concept_Ratings!E2:G3", values: [[...],[...]] }]
 */
async function batchUpdateValues(data) {
  if (!data.length) return null;
  return sheetsRequest(`/values:batchUpdate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ valueInputOption: "USER_ENTERED", data }),
  });
}

/* ==========================================================================
   4. TURNING SHEET ROWS INTO USEFUL OBJECTS
   ========================================================================== */

// Every parser gets the raw rows (row 1 = headers) and returns plain objects.
// Column positions are fixed by the sheet, so we read by index.

function parseEmployees(rows) {
  // A Employee ID | B Name | C Floor | D Active | (E is a formula, we ignore it)
  const list = [];
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i] || [];
    const id = txt(row[0]);
    if (!id) continue;
    list.push({
      id,
      name: txt(row[1]) || id,
      floor: txt(row[2]),
      active: yes(row[3]),
    });
  }
  return list;
}

function parseSettings(rows) {
  // Settings!B2..B10. rows[1] is row 2, column B is index 1.
  const value = (sheetRow) => (rows[sheetRow - 1] || [])[1];
  return {
    discoveryWeight: num(value(2)) || 30,
    conceptWeight: num(value(3)) || 70,
    maxRating: num(value(4)) || 5,
    attributesPerCard: num(value(5)) || 12,
    employeesPerRotation: num(value(6)),
    currentRotation: num(value(7)),
    prizes: [txt(value(8)), txt(value(9)), txt(value(10))],
  };
}

function parseAttributes(rows) {
  // A ID | B Tamil | C English | D Suggested question | E Source
  const list = [];
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i] || [];
    const id = txt(row[0]);
    if (!id) continue;
    list.push({
      id,                       // "A01"
      tamil: txt(row[1]),
      english: txt(row[2]),
      question: txt(row[3]),
      source: txt(row[4]),
    });
  }
  list.sort((a, b) => a.id.localeCompare(b.id)); // A01, A02, ... A12
  return list;
}

function parseCards(rows) {
  // A ID | B Persona | C..N = the 12 attribute answers | O objection type
  // P what the customer says | Q behaviour tip
  const list = [];
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i] || [];
    const id = txt(row[0]);
    if (!id) continue;
    const values = [];
    for (let c = 2; c <= 13; c++) values.push(txt(row[c])); // C..N
    list.push({
      id,                                     // "C01"
      persona: txt(row[1]),
      values,                                 // 12 strings, index 0 = A01
      objectionType: txt(row[14]),            // O
      objection: txt(row[15]),                // P
      behaviourTip: txt(row[16]),             // Q
    });
  }
  return list;
}

function parseConcepts(rows) {
  // A ID | B Module No | C Module Tamil | D Module English
  // E Concept Tamil | F Concept English | G Applies To | H Max Rating
  const list = [];
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i] || [];
    const id = txt(row[0]);
    if (!id) continue;
    list.push({
      id,                                     // "K01"
      moduleNo: num(row[1]),
      moduleTamil: txt(row[2]),
      moduleEnglish: txt(row[3]),
      tamil: txt(row[4]),
      english: txt(row[5]),
      appliesTo: txt(row[6]),                 // "ALL" or "C04,C05"
      maxRating: num(row[7]) || 5,
    });
  }
  return list;
}

/**
 * "ALL" applies to every card. Otherwise the cell lists card IDs, possibly with
 * spaces or different casing ("C04, C05"). Returns true/false.
 */
function conceptAppliesToCard(concept, cardId) {
  const rule = concept.appliesTo.trim().toUpperCase();
  if (!rule || rule === "ALL") return true;
  const ids = rule.split(/[,;]/).map((s) => s.trim()).filter(Boolean);
  return ids.includes(cardId.trim().toUpperCase());
}

function parseSchedule(rows) {
  // A Session ID | B Date | C Rotation | D Salesperson ID | E Salesperson Name
  // F Customer ID | G Customer Name | H Card ID | I Status | J Created At
  const list = [];
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i] || [];
    const sessionId = txt(row[0]);
    if (!sessionId) continue;
    list.push({
      sessionId,
      date: txt(row[1]),
      rotation: num(row[2]),
      salespersonId: txt(row[3]),
      salespersonName: txt(row[4]),
      customerId: txt(row[5]),
      customerName: txt(row[6]),
      cardId: txt(row[7]),
      status: txt(row[8]),
      createdAt: txt(row[9]),
    });
  }
  return list;
}

function parseScores(rows) {
  // A Session | B Rotation | C Date | D Salesperson ID | E Salesperson | F Customer
  // G Card | H Attributes found | I Discovery /30 | J Applicable | K Rated
  // L Rating total | M Concept /70 | N Final /100 | O Status
  const list = [];
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i] || [];
    const sessionId = txt(row[0]);
    if (!sessionId) continue;
    list.push({
      sessionId,
      rotation: num(row[1]),
      date: txt(row[2]),
      salespersonId: txt(row[3]),
      salespersonName: txt(row[4]),
      customerName: txt(row[5]),
      cardId: txt(row[6]),
      attributesFound: num(row[7]),
      discoveryScore: num(row[8]),
      applicableConcepts: num(row[9]),
      conceptsRated: num(row[10]),
      ratingTotal: num(row[11]),
      conceptScore: num(row[12]),
      finalScore: num(row[13]),
      status: txt(row[14]),      // "Complete" / "Waiting: customer ticks" / ...
    });
  }
  return list;
}

function parseRotations(rows) {
  // A No | B Start | C End | D Status | E/F/G formulas | H 1st | I 2nd | J 3rd | K Prizes
  const list = [];
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i] || [];
    const number = num(row[0]);
    if (!number) continue;
    list.push({
      number,
      startDate: txt(row[1]),
      endDate: txt(row[2]),
      status: txt(row[3]),
      first: txt(row[7]),
      second: txt(row[8]),
      third: txt(row[9]),
    });
  }
  return list;
}

/**
 * Discovery_Marks has one row per session:
 * A Session ID | B..M A01..A12 (Y or blank) | N Marked By | O Marked At
 * Columns B..M follow the Attributes tab order, so the attribute list is passed
 * in rather than assumed.
 */
function parseDiscoveryMarks(rows, attributes) {
  const bySession = new Map();
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i] || [];
    const sessionId = txt(row[0]);
    if (!sessionId) continue;

    const ticks = [];
    attributes.slice(0, 12).forEach((attribute, column) => {
      if (yes(row[1 + column])) ticks.push(attribute.id);
    });

    bySession.set(sessionId.toUpperCase(), {
      sessionId,
      ticks,
      markedBy: txt(row[13]),
      markedAt: txt(row[14]),
      rowNumber: i + 1, // 1-based sheet row (row 1 is the header)
    });
  }
  return bySession;
}

function findSessionById(sessions, sessionId) {
  const wanted = txt(sessionId).toUpperCase();
  return sessions.find((s) => s.sessionId.toUpperCase() === wanted) || null;
}

/* ==========================================================================
   5. CACHING (keeps us under the Google quota)
   ========================================================================== */

// A tiny in-memory cache. Cloudflare may keep this Worker instance alive between
// requests, so a 5 minute cache saves a lot of Google calls.
// Schedule / Scores / Discovery_Marks / Concept_Ratings are NEVER cached here.
const memoryCache = new Map(); // key -> { expiresAt, value }

async function cached(key, ttlMs, producer) {
  const hit = memoryCache.get(key);
  const now = Date.now();
  if (hit && hit.expiresAt > now) return hit.value;

  const value = await producer();
  memoryCache.set(key, { expiresAt: now + ttlMs, value });
  return value;
}

const REFERENCE_TTL_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Employees, Settings, Attributes, Customer_Cards and Concepts change only when
 * the manager edits the sheet, so one batchGet every 5 minutes is plenty.
 */
function getReferenceData() {
  return cached("reference", REFERENCE_TTL_MS, async () => {
    const ranges = {
      employees: `${SHEET.employees}!A:E`,
      settings: `${SHEET.settings}!A:D`,
      attributes: `${SHEET.attributes}!A:E`,
      cards: `${SHEET.cards}!A:Q`,
      concepts: `${SHEET.concepts}!A:H`,
    };

    const data = await readRanges(Object.values(ranges));

    return {
      employees: parseEmployees(data[ranges.employees] || []),
      settings: parseSettings(data[ranges.settings] || []),
      attributes: parseAttributes(data[ranges.attributes] || []),
      cards: parseCards(data[ranges.cards] || []),
      concepts: parseConcepts(data[ranges.concepts] || []),
      loadedAt: new Date().toISOString(),
    };
  });
}

/* ==========================================================================
   6. SESSIONS (Schedule + Scores joined together)
   ========================================================================== */

/**
 * Reads the live tabs. Never cached: these are the rows that change while the
 * team is using the app.
 *
 * Scores has one formula row per Schedule row, so we only read as far as the
 * Schedule goes. That keeps the payload small.
 */
async function getSessions(scheduleRowsAlreadyRead = null) {
  const scheduleRows = scheduleRowsAlreadyRead || (await readRange(`${SHEET.schedule}!A:J`));
  const lastRow = Math.max(2, scheduleRows.length);
  const scoresRows = await readRange(`${SHEET.scores}!A1:O${lastRow}`);

  const schedule = parseSchedule(scheduleRows);
  const scores = parseScores(scoresRows);

  const scoresById = new Map(scores.map((s) => [s.sessionId, s]));

  // Merge. "status" is the Scores status (the source of truth for "Complete").
  return schedule.map((session) => {
    const score = scoresById.get(session.sessionId) || null;
    return {
      ...session,
      score,
      scoreStatus: score ? score.status : "",
      complete: score ? score.status === "Complete" : false,
      finalScore: score ? score.finalScore : 0,
      conceptScore: score ? score.conceptScore : 0,
      discoveryScore: score ? score.discoveryScore : 0,
      attributesFound: score ? score.attributesFound : 0,
      applicableConcepts: score ? score.applicableConcepts : 0,
      conceptsRated: score ? score.conceptsRated : 0,
    };
  });
}

/** The rotation row whose Status is "Active" (there should be exactly one). */
function findActiveRotation(rotations) {
  return rotations.find((r) => r.status.toLowerCase() === "active") || null;
}

/**
 * A session is "in progress" when its Score status is not "Complete".
 * We only look at the current rotation so an old half-finished row can never
 * block the team forever.
 */
function findInProgressSession(sessions, rotationNumber) {
  const inRotation = sessions.filter((s) => s.rotation === rotationNumber);
  for (let i = inRotation.length - 1; i >= 0; i--) {
    if (!inRotation[i].complete) return inRotation[i];
  }
  return null;
}

/* ==========================================================================
   6b. SHUFFLE ENGINE (picking the pair and the card)
   ========================================================================== */

function nextSessionNumber(sessions) {
  let highest = 0;
  for (const session of sessions) {
    const match = /^S(\d+)$/i.exec(session.sessionId);
    if (match) highest = Math.max(highest, Number(match[1]));
  }
  return highest + 1;
}

/**
 * Deal a card from a shuffled deck.
 *
 * "All cards must be used once before any card repeats."
 * If 10 cards exist, the deck cycle is 10 long. After 3 sessions, 3 cards are
 * gone from the current cycle, so we pick from the other 7. Because every card
 * appears exactly once per cycle, "the cards already used" are simply the card
 * IDs of the last (totalSessions % 10) sessions.
 */
function dealCard(cards, sessions) {
  if (!cards.length) {
    throw new ApiError(
      409,
      "NO_CARDS",
      "வாடிக்கையாளர் கார்டுகள் இல்லை.",
      "The Customer_Cards tab has no cards. Add at least one card."
    );
  }

  const deckSize = cards.length;
  const usedCount = sessions.length % deckSize;
  const recent = sessions.slice(Math.max(0, sessions.length - usedCount));

  const usedIds = new Set(
    recent.map((s) => txt(s.cardId).toUpperCase()).filter(Boolean)
  );

  let pool = cards.filter((card) => !usedIds.has(card.id.toUpperCase()));
  if (!pool.length) pool = cards; // safety net if the sheet was edited by hand

  return pickOne(pool);
}

/* ==========================================================================
   7. API ROUTES
   ========================================================================== */

/**
 * GET /api/health
 * A friendly "is everything wired up?" check. Reads Employees + Settings from
 * the real sheet, so a green result proves: secrets, Google login, sheet access.
 */
async function handleHealth(request) {
  const startedAt = Date.now();
  const fresh = new URL(request.url).searchParams.get("fresh") === "1";
  if (fresh) memoryCache.clear();

  assertConfig();

  const ref = await getReferenceData();
  const activeEmployees = ref.employees.filter((e) => e.active);

  return json({
    ok: true,
    message_ta: "இணைப்பு சரியாக வேலை செய்கிறது.",
    message_en: "Connected to Google Sheets successfully.",
    sheet: {
      idPreview: maskSheetId(ENV.SHEET_ID),
      tabsRead: Object.keys(SHEET).length,
    },
    counts: {
      employees: ref.employees.length,
      activeEmployees: activeEmployees.length,
      attributes: ref.attributes.length,
      customerCards: ref.cards.length,
      concepts: ref.concepts.length,
    },
    settings: ref.settings,
    timings: {
      milliseconds: Date.now() - startedAt,
      referenceLoadedAt: ref.loadedAt,
      cacheCleared: fresh,
    },
  });
}

/** GET /api/employees — the list the Shuffle screen will use. */
async function handleEmployees() {
  assertConfig();
  const ref = await getReferenceData();
  return json({
    employees: ref.employees,
    activeCount: ref.employees.filter((e) => e.active).length,
  });
}

/**
 * GET /api/state — everything the home screen needs.
 * rotation + who has performed + who is left + any session in progress.
 */
async function handleState() {
  assertConfig();

  const [ref, scheduleRows, rotationRows] = await Promise.all([
    getReferenceData(),
    readRange(`${SHEET.schedule}!A:J`),
    readRange(`${SHEET.rotations}!A:K`),
  ]);

  const sessions = await getSessions(scheduleRows);
  const rotations = parseRotations(rotationRows);
  const active = findActiveRotation(rotations);

  const rotationNumber = active ? active.number : (ref.settings.currentRotation || 1);

  const activeEmployees = ref.employees.filter((e) => e.active);
  const performedIds = new Set(
    sessions.filter((s) => s.rotation === rotationNumber).map((s) => s.salespersonId)
  );
  const remaining = activeEmployees.filter((e) => !performedIds.has(e.id));

  const inProgress = findInProgressSession(sessions, rotationNumber);

  return json({
    rotation: {
      number: rotationNumber,
      status: active ? active.status : "",
      startDate: active ? active.startDate : "",
      totalActiveEmployees: activeEmployees.length,
      performed: activeEmployees.length - remaining.length,
      remaining: remaining.map((e) => ({ id: e.id, name: e.name, floor: e.floor })),
    },
    rotations: rotations.map((r) => ({ number: r.number, status: r.status })),
    session: inProgress ? publicSession(inProgress) : null,
    staff: activeEmployees.map((e) => ({ id: e.id, name: e.name })),
    canShuffle: !inProgress && remaining.length > 0 && activeEmployees.length >= 2,
    rotationComplete: remaining.length === 0,
    prizes: ref.settings.prizes,
    settings: {
      discoveryWeight: ref.settings.discoveryWeight,
      conceptWeight: ref.settings.conceptWeight,
      maxRating: ref.settings.maxRating,
      attributesPerCard: ref.settings.attributesPerCard,
    },
    generatedAt: new Date().toISOString(),
  });
}

/** The safe, public shape of a session (no persona card in here — ever). */
function publicSession(session) {
  return {
    sessionId: session.sessionId,
    date: session.date,
    rotation: session.rotation,
    salespersonId: session.salespersonId,
    salespersonName: session.salespersonName,
    customerId: session.customerId,
    customerName: session.customerName,
    cardId: session.cardId,
    status: session.status,
    scoreStatus: session.scoreStatus,
    complete: session.complete,
  };
}

/**
 * POST /api/shuffle
 * Picks the pair, deals a card, writes ONE Schedule row and all
 * Concept_Ratings rows for that session in a single batch.
 */
async function handleShuffle() {
  assertConfig();

  const [ref, rotationRows, scheduleRows] = await Promise.all([
    getReferenceData(),
    readRange(`${SHEET.rotations}!A:K`),
    readRange(`${SHEET.schedule}!A:J`),
  ]);

  const rotations = parseRotations(rotationRows);
  const activeRotations = rotations.filter((r) => r.status.toLowerCase() === "active");

  if (activeRotations.length === 0) {
    throw new ApiError(
      409,
      "NO_ACTIVE_ROTATION",
      "செயலில் உள்ள சுற்று இல்லை. மேலாளரிடம் கேளுங்கள்.",
      "No row in the Rotations tab has Status = Active.",
      "Set exactly one rotation row to Active (and the others to Closed or Planned)."
    );
  }
  if (activeRotations.length > 1) {
    throw new ApiError(
      409,
      "MULTIPLE_ACTIVE_ROTATIONS",
      "ஒன்றுக்கு மேற்பட்ட சுற்றுகள் செயலில் உள்ளன.",
      "More than one rotation row has Status = Active.",
      "Only one rotation may be Active at a time."
    );
  }
  const active = activeRotations[0];

  const sessions = await getSessions(scheduleRows);

  const activeEmployees = ref.employees.filter((e) => e.active);
  if (activeEmployees.length < 2) {
    throw new ApiError(
      409,
      "NOT_ENOUGH_STAFF",
      "குறைந்தது இரண்டு பேர் வேண்டும் (விற்பனையாளர் + வாடிக்கையாளர்).",
      "At least two active employees are needed — one salesperson and one customer.",
      "Mark more people Active = Y in the Employees tab."
    );
  }

  // ---- Rule 1: never create a second session while one is still running ----
  const existing = findInProgressSession(sessions, active.number);
  if (existing) {
    return json({ session: publicSession(existing), reused: true });
  }

  // ---- Rule 3: salesperson = active employee who has not performed yet ----
  const performed = new Set(
    sessions.filter((s) => s.rotation === active.number).map((s) => s.salespersonId)
  );
  const eligible = activeEmployees.filter((e) => !performed.has(e.id));

  if (!eligible.length) {
    throw new ApiError(
      409,
      "ROTATION_COMPLETE",
      "இந்த சுற்றில் அனைவரும் முடித்துவிட்டார்கள். மேலாளர் சுற்றை மூட வேண்டும்.",
      "Everyone has performed in this rotation. Ask the manager to close the rotation.",
      "Manager → Rotation close."
    );
  }

  // ---- Rules 4 + 5: customer and card ----
  const salesperson = pickOne(eligible);
  const customer = pickOne(activeEmployees.filter((e) => e.id !== salesperson.id));
  const card = dealCard(ref.cards, sessions);

  // ---- Concurrency guard: re-read right before writing ----
  // If somebody else tapped Shuffle a moment ago, their session is already
  // there. Hand that one back instead of creating a duplicate.
  const freshRows = await readRange(`${SHEET.schedule}!A:J`);
  const freshSessions = parseSchedule(freshRows);
  const knownIds = new Set(
    sessions.filter((s) => s.rotation === active.number).map((s) => s.sessionId)
  );
  const raced = freshSessions.filter(
    (s) => s.rotation === active.number && !knownIds.has(s.sessionId)
  );
  if (raced.length > 0) {
    const latest = raced[raced.length - 1];
    return json({
      session: publicSession({
        ...latest,
        scoreStatus: "Waiting: customer ticks",
        complete: false,
      }),
      reused: true,
    });
  }

  // ---- Rule 6: one Schedule row ----
  const stamp = istNow();
  const sessionId = "S" + String(nextSessionNumber(freshSessions)).padStart(3, "0");

  await appendRows(`${SHEET.schedule}!A:J`, [
    [
      sessionId,             // A Session ID
      stamp.date,            // B Date (text, IST)
      active.number,         // C Rotation
      salesperson.id,        // D Salesperson ID
      salesperson.name,      // E Salesperson Name
      customer.id,           // F Customer ID
      customer.name,         // G Customer Name
      card.id,               // H Card ID
      "Scheduled",           // I Status
      stamp.stamp,           // J Created At
    ],
  ]);

  // ---- Rule 7: all Concept_Ratings rows in ONE call ----
  const applicable = ref.concepts.map((concept) => conceptAppliesToCard(concept, card.id));

  const ratingRows = ref.concepts.map((concept, index) => [
    sessionId,                              // A Session ID
    concept.id,                             // B Concept ID
    concept.moduleNo,                       // C Module No
    applicable[index] ? "Y" : "N",          // D Applicable
    applicable[index] ? "" : "NA",          // E Rating (blank until rated)
    "",                                     // F Manager Note
    "",                                     // G Rated At
  ]);

  if (ratingRows.length) {
    try {
      await appendRows(`${SHEET.ratings}!A:G`, ratingRows);
    } catch (firstError) {
      // One retry: if this really fails the session has no rating rows, so tell
      // the manager to cancel it rather than leave a stuck session.
      try {
        await appendRows(`${SHEET.ratings}!A:G`, ratingRows);
      } catch (secondError) {
        console.error("Concept_Ratings append failed twice:", secondError);
        throw new ApiError(
          502,
          "RATINGS_WRITE_FAILED",
          "கருத்து வரிசைகள் சேமிக்க முடியவில்லை. மேலாளர் இந்த அமர்வை ரத்து செய்யுங்கள்.",
          "The session " + sessionId + " was created but its concept rows could not be written.",
          "Ask the manager to cancel session " + sessionId + ", then shuffle again."
        );
      }
    }
  }

  return json({
    session: {
      sessionId,
      date: stamp.date,
      rotation: active.number,
      salespersonId: salesperson.id,
      salespersonName: salesperson.name,
      customerId: customer.id,
      customerName: customer.name,
      cardId: card.id,
      status: "Scheduled",
      scoreStatus: "Waiting: customer ticks",
      complete: false,
    },
    reused: false,
    concepts: {
      rows: ratingRows.length,
      applicable: applicable.filter(Boolean).length,
    },
    deck: {
      deckSize: ref.cards.length,
      cycle: Math.floor(sessions.length / ref.cards.length) + 1,
      position: (sessions.length % ref.cards.length) + 1,
    },
  });
}

/* --------------------------------------------------------------------------
   STAGE 3 — the customer's persona card and the discovery ticks
   -------------------------------------------------------------------------- */

/**
 * GET /api/session/:id/card
 * The secret persona card for one session: the 12 attribute values, the
 * objection and the behaviour tip — plus any ticks already saved.
 *
 * There is no customer login (by design), so the screen is honour-system
 * protected: the front end only asks for this after "I am the customer".
 */
async function handleCard(request, url, match) {
  assertConfig();

  const sessionId = decodeURIComponent(match[1] || "").trim();
  if (!sessionId) {
    throw new ApiError(
      400,
      "SESSION_ID_MISSING",
      "அமர்வு எண் இல்லை.",
      "The session ID is missing from the address."
    );
  }

  const [ref, scheduleRows] = await Promise.all([
    getReferenceData(),
    readRange(`${SHEET.schedule}!A:J`),
  ]);

  const sessions = await getSessions(scheduleRows);
  const session = findSessionById(sessions, sessionId);

  if (!session) {
    throw new ApiError(
      404,
      "SESSION_NOT_FOUND",
      "இந்த அமர்வு கிடைக்கவில்லை.",
      "No session " + sessionId + " in the Schedule tab."
    );
  }

  const card = ref.cards.find((c) => c.id.toUpperCase() === txt(session.cardId).toUpperCase());
  if (!card) {
    throw new ApiError(
      409,
      "CARD_MISSING",
      "இந்த அமர்வின் கார்டு Customer_Cards இல் இல்லை.",
      "Session " + session.sessionId + " points at card " + session.cardId + ", which is not in Customer_Cards.",
      "Check column H of the Schedule row, or add the missing card."
    );
  }

  const marksRows = await readRange(`${SHEET.discovery}!A:O`);
  const marks = parseDiscoveryMarks(marksRows, ref.attributes).get(session.sessionId.toUpperCase()) || null;

  // The ticks are frozen once the manager has finished rating the session.
  const locked = session.complete === true;

  return json({
    session: publicSession(session),
    card: {
      id: card.id,
      persona: card.persona,
      objectionType: card.objectionType,
      objection: card.objection,
      behaviourTip: card.behaviourTip,
      attributes: ref.attributes.slice(0, 12).map((attribute, index) => ({
        id: attribute.id,
        tamil: attribute.tamil,
        english: attribute.english,
        value: card.values[index] || "",
      })),
    },
    ticks: marks ? marks.ticks : [],
    markedBy: marks ? marks.markedBy : "",
    markedAt: marks ? marks.markedAt : "",
    locked,
    canEdit: !locked,
  });
}

/**
 * POST /api/session/:id/discovery
 * Body: { "ticks": ["A01", "A04", ...] }
 * Writes the 12 tick columns (Y / blank) plus "Marked By" and "Marked At".
 * One append for a new session, one range update if the row already exists.
 */
async function handleDiscovery(request, url, match) {
  assertConfig();

  const sessionId = decodeURIComponent(match[1] || "").trim();
  const body = await readJsonBody(request);

  if (Object.prototype.hasOwnProperty.call(body, "ticks") && !Array.isArray(body.ticks)) {
    throw new ApiError(
      400,
      "INVALID_TICKS",
      "டிக் பட்டியல் தவறான வடிவத்தில் உள்ளது.",
      "The ticks value must be a list of attribute IDs, e.g. [\"A01\",\"A04\"].",
      "Reload the page and tick again."
    );
  }
  const requested = Array.isArray(body.ticks) ? body.ticks : [];

  const [ref, scheduleRows] = await Promise.all([
    getReferenceData(),
    readRange(`${SHEET.schedule}!A:J`),
  ]);

  const sessions = await getSessions(scheduleRows);
  const session = findSessionById(sessions, sessionId);

  if (!session) {
    throw new ApiError(
      404,
      "SESSION_NOT_FOUND",
      "இந்த அமர்வு கிடைக்கவில்லை.",
      "No session " + sessionId + " in the Schedule tab."
    );
  }

  if (session.complete) {
    throw new ApiError(
      409,
      "TICKS_LOCKED",
      "மேலாளர் மதிப்பீடு முடிந்துவிட்டது. இனி டிக் மாற்ற முடியாது.",
      "The manager has finished rating session " + session.sessionId + ", so its ticks are locked.",
      "Ask the manager to unlock it (later stage)."
    );
  }

  const known = ref.attributes.slice(0, 12);
  const knownIds = new Set(known.map((attribute) => attribute.id.toUpperCase()));

  const cleaned = [];
  const unknown = [];
  for (const raw of requested) {
    const id = txt(raw).toUpperCase();
    if (!id) continue;
    if (!knownIds.has(id)) unknown.push(raw);
    else if (!cleaned.includes(id)) cleaned.push(id);
  }

  if (unknown.length) {
    throw new ApiError(
      400,
      "INVALID_ATTRIBUTE",
      "தெரியாத பண்பு எண் அனுப்பப்பட்டது.",
      "Unknown attribute ID(s): " + unknown.join(", "),
      "Send only the IDs from the Attributes tab (A01…A12)."
    );
  }

  const ticked = new Set(cleaned);
  const markCells = known.map((attribute) => (ticked.has(attribute.id.toUpperCase()) ? "Y" : ""));
  const stamp = istNow();

  const marksRows = await readRange(`${SHEET.discovery}!A:O`);
  const existing = parseDiscoveryMarks(marksRows, ref.attributes).get(session.sessionId.toUpperCase()) || null;

  if (existing) {
    // B..O = the 12 ticks + Marked By + Marked At (A stays the session ID).
    await batchUpdateValues([
      {
        range: `${SHEET.discovery}!B${existing.rowNumber}:O${existing.rowNumber}`,
        values: [[...markCells, session.customerName, stamp.stamp]],
      },
    ]);
  } else {
    await appendRows(`${SHEET.discovery}!A:O`, [
      [session.sessionId, ...markCells, session.customerName, stamp.stamp],
    ]);
  }

  return json({
    ok: true,
    sessionId: session.sessionId,
    ticks: known.filter((attribute, index) => markCells[index] === "Y").map((attribute) => attribute.id),
    count: markCells.filter(Boolean).length,
    markedBy: session.customerName,
    markedAt: stamp.stamp,
    locked: false,
  });
}

function maskSheetId(id) {
  const value = txt(id);
  if (value.length <= 8) return "••••";
  return value.slice(0, 6) + "…" + value.slice(-4);
}

/* ==========================================================================
   8. ROUTER + WORKER ENTRY POINT
   ========================================================================== */

const routes = [
  { method: "GET", pattern: /^\/api\/health$/, handler: handleHealth },
  { method: "GET", pattern: /^\/api\/employees$/, handler: handleEmployees },
  { method: "GET", pattern: /^\/api\/state$/, handler: handleState },
  { method: "POST", pattern: /^\/api\/shuffle$/, handler: handleShuffle },
  { method: "GET", pattern: /^\/api\/session\/([^/]+)\/card$/, handler: handleCard },
  { method: "POST", pattern: /^\/api\/session\/([^/]+)\/discovery$/, handler: handleDiscovery },
];

async function routeApi(request, url) {
  // Same-origin only: no CORS headers are ever added, so other websites cannot
  // read any of this from a browser.
  for (const route of routes) {
    if (route.method !== request.method) continue;
    const match = url.pathname.match(route.pattern);
    if (match) return route.handler(request, url, match);
  }
  throw new ApiError(
    404,
    "NOT_FOUND",
    "இந்த API முகவரி இல்லை.",
    "Unknown API route: " + request.method + " " + url.pathname
  );
}

export default {
  async fetch(request, env, ctx) {
    ENV = env;
    const url = new URL(request.url);

    try {
      if (url.pathname === "/api" || url.pathname.startsWith("/api/")) {
        return await routeApi(request, url);
      }

      // Everything that is not /api is a normal file in /public.
      // With the `assets` config in wrangler.jsonc Cloudflare usually answers
      // these before the Worker runs; this is just a safety net.
      if (env.ASSETS) return env.ASSETS.fetch(request);
      return new Response("Not found", { status: 404 });
    } catch (err) {
      return errorResponse(err);
    }
  },
};
