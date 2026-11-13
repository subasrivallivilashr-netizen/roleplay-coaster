// Roleplay Coaster - Cloudflare Worker (all backend logic lives here).
// It is the ONLY thing that talks to Google Sheets (service account + hand-built RS256 JWT).
// Static files (public/index.html) are served by the ASSETS binding.

const SHEETS = "https://sheets.googleapis.com/v4/spreadsheets/";
const TZ = "Asia/Kolkata";
const STATIC_TTL = 5 * 60 * 1000; // static tabs cached ~5 minutes (Sheets quota)
const DYN_TTL = 4 * 1000;         // tiny cache for live tabs, dropped on every write
const TOKEN_HOURS = 8;
const enc = new TextEncoder();

// ---------- errors (always Tamil + English) ----------
class HttpError extends Error {
  constructor(status, ta, en) { super(en); this.status = status; this.ta = ta; this.en = en; }
}
const fail = (status, ta, en) => { throw new HttpError(status, ta, en); };
const E = {
  input: ["தவறான உள்ளீடு.", "Invalid input."],
  notFound: ["அந்த செஷன் கிடைக்கவில்லை.", "Session not found."],
  sheet: ["தரவுத்தளத்தை அணுக முடியவில்லை. சற்று கழித்து முயற்சிக்கவும்.", "Could not reach the sheet. Please try again shortly."],
  busy: ["அதிக கோரிக்கைகள். சற்று நேரம் கழித்து முயற்சிக்கவும்.", "Too many requests. Please wait a moment and try again."],
  setup: ["அமைப்பு முழுமையடையவில்லை (secrets இல்லை).", "Setup incomplete: a Worker secret is missing."],
  auth: ["மேலாளர் உள்நுழைவு தேவை அல்லது காலாவதியானது.", "Manager login required or expired."],
  pass: ["கடவுச்சொல் தவறு.", "Wrong password."],
  locked: ["மேலாளர் சமர்ப்பித்த பிறகு மாற்ற முடியாது.", "Locked: the manager has already submitted this session."],
  open: ["ஏற்கனவே ஒரு செஷன் நடந்துகொண்டிருக்கிறது. அதை முடித்த பிறகு குலுக்கவும்.", "A session is already open. Finish it before shuffling."],
  allDone: ["இந்த சுழற்சியில் அனைவரும் முடித்துவிட்டனர். சுழற்சியை மூடவும்.", "Everyone has performed this rotation. Close the rotation."],
  race: ["வேறொருவர் அதே நேரத்தில் குலுக்கினார். மீண்டும் முயற்சிக்கவும்.", "Someone shuffled at the same moment. Please try again."],
  needAll: ["சமர்ப்பிக்கும் முன் அனைத்து கருத்துகளுக்கும் மதிப்பீடு தேவை.", "Rate every concept before submitting."],
  cantClose: ["அனைவரும் செய்து, அனைத்து செஷன்களும் முடிந்த பிறகே சுழற்சியை மூட முடியும்.", "Everyone must perform and every session must be complete before closing."],
  closed: ["இந்த சுழற்சி மூடப்பட்டுவிட்டது.", "This rotation is already closed."],
  noRot: ["செயலில் உள்ள சுழற்சி இல்லை (Rotations tab).", "No Active rotation found in the Rotations tab."],
  rotFull: ["Rotations tab நிரம்பிவிட்டது (20 வரிசைகள்).", "The Rotations tab is full (20 rows)."],
  few: ["குறைந்தது 2 செயலில் உள்ள ஊழியர்கள் தேவை.", "At least 2 active employees are needed."],
};
const bad = (k) => fail(k === "auth" ? 401 : k === "busy" ? 429 : 400, ...E[k]);

// ---------- small utilities ----------
const num = (x) => (x === "" || x == null || isNaN(Number(x)) ? 0 : Number(x));
const str = (x) => (x == null ? "" : String(x));
const pad = (r, n) => { const a = r.slice(0, n); while (a.length < n) a.push(""); return a; };
const colLetter = (n) => { let s = ""; while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); } return s; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// unbiased crypto-random integer in [0, n)
function randInt(n) {
  const lim = Math.floor(0x100000000 / n) * n;
  const a = new Uint32Array(1);
  do { crypto.getRandomValues(a); } while (a[0] >= lim);
  return a[0] % n;
}
const pick = (arr) => arr[randInt(arr.length)];

// IST date (YYYY-MM-DD, text) and timestamp (YYYY-MM-DD HH:mm)
function istNow() {
  const p = {};
  for (const x of new Intl.DateTimeFormat("en-GB", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date())) p[x.type] = x.value;
  const date = `${p.year}-${p.month}-${p.day}`;
  return { date, stamp: `${date} ${p.hour}:${p.minute}` };
}

const b64u = (buf) => {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = ""; for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};
const b64uDecode = (t) => {
  const s = t.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(s + "=".repeat((4 - (s.length % 4)) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
};

// ---------- Google auth: RS256 JWT with Web Crypto (no googleapis package) ----------
let gTok = { value: null, exp: 0 };
async function googleToken(env) {
  const now = Math.floor(Date.now() / 1000);
  if (gTok.value && gTok.exp - 60 > now) return gTok.value;
  const head = b64u(enc.encode(JSON.stringify({ alg: "RS256", typ: "JWT" })));
  const claim = b64u(enc.encode(JSON.stringify({
    iss: env.GOOGLE_SERVICE_ACCOUNT_EMAIL, scope: "https://www.googleapis.com/auth/spreadsheets",
    aud: "https://oauth2.googleapis.com/token", iat: now, exp: now + 3600,
  })));
  // secret may hold real newlines or literal "\n"
  const pem = env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, "\n").replace(/-----[^-]+-----/g, "").replace(/\s+/g, "");
  const key = await crypto.subtle.importKey("pkcs8", b64uDecode(pem), { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, enc.encode(`${head}.${claim}`));
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `grant_type=${encodeURIComponent("urn:ietf:params:oauth:grant-type:jwt-bearer")}&assertion=${head}.${claim}.${b64u(sig)}`,
  });
  if (!res.ok) { console.error("token error", await res.text()); fail(502, ...E.sheet); }
  const j = await res.json();
  gTok = { value: j.access_token, exp: now + (j.expires_in || 3600) };
  return gTok.value;
}

// ---------- Sheets REST helpers ----------
async function sheets(env, path, method = "GET", body) {
  const token = await googleToken(env);
  const res = await fetch(SHEETS + env.SHEET_ID + path, {
    method, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 429) bad("busy");
  if (!res.ok) { console.error("sheets error", res.status, await res.text()); fail(502, ...E.sheet); }
  return res.json();
}
// batch read: many ranges in ONE request; returns array of 2D arrays
async function batchGet(env, ranges) {
  const qs = ranges.map((r) => "ranges=" + encodeURIComponent(r)).join("&");
  const d = await sheets(env, `/values:batchGet?${qs}&valueRenderOption=UNFORMATTED_VALUE`);
  return d.valueRanges.map((v) => v.values || []);
}
// batch write; RAW keeps dates as text and never turns notes into formulas
const writeBatch = (env, data) => sheets(env, "/values:batchUpdate", "POST", { valueInputOption: "RAW", data });
// append new rows. OVERWRITE (not INSERT_ROWS) so Scores/Leaderboard formulas never shift.
async function appendRows(env, tab, rows) {
  const r = await sheets(env, `/values/${encodeURIComponent(tab + "!A1")}:append?valueInputOption=RAW&insertDataOption=OVERWRITE`, "POST", { values: rows });
  const m = /!A(\d+)/.exec(r.updates?.updatedRange || "");
  return m ? Number(m[1]) : 0; // first row written
}
// remove rows by rewriting the tail and clearing the end (a real row delete would break Scores references)
async function compact(env, tab, width, shouldRemove) {
  const last = colLetter(width);
  const [rows] = await batchGet(env, [`${tab}!A2:${last}`]);
  const first = rows.findIndex(shouldRemove);
  if (first < 0) return 0;
  const keep = rows.filter((r, i) => !shouldRemove(r, i));
  const tail = keep.slice(first).map((r) => pad(r, width));
  if (tail.length) await writeBatch(env, [{ range: `${tab}!A${first + 2}:${last}${first + 1 + tail.length}`, values: tail }]);
  await sheets(env, "/values:batchClear", "POST", { ranges: [`${tab}!A${keep.length + 2}:${last}${rows.length + 1}`] });
  return rows.length - keep.length;
}

// ---------- static tabs (cached) ----------
let staticCache = { t: 0, v: null };
async function loadStatic(env) {
  if (staticCache.v && Date.now() - staticCache.t < STATIC_TTL) return staticCache.v;
  const [set, emp, att, cards, con, dm] = await batchGet(env, [
    "Settings!A2:C14", "Employees!A2:D200", "Attributes!A2:F50",
    "Customer_Cards!A1:Q200", "Concepts!A2:H300", "Discovery_Marks!A1:Q1",
  ]);
  const sv = (i) => str(set[i]?.[1]);
  const settings = {
    discoveryWeight: num(sv(0)) || 15, conceptWeight: num(sv(1)) || 75, orderWeight: num(sv(11)) || 10, maxRating: num(sv(2)) || 5,
    prizes: [sv(6), sv(7), sv(8)],
  };
  const employees = emp.filter((r) => str(r[0]).trim()).map((r) => ({
    id: str(r[0]).trim(), name: str(r[1]).trim(), floor: str(r[2]), active: str(r[3]).trim().toUpperCase() === "Y",
  }));
  const attributes = att.filter((r) => str(r[0]).trim()).map((r) => ({ id: str(r[0]).trim(), ta: str(r[1]), en: str(r[2]), q: str(r[3]), ordered: str(r[5]).trim().toUpperCase() !== "N" }));
  // cards: find columns by header text, with positional fallback
  const head = (cards[0] || []).map(str);
  const hIdx = (re, fb) => { const i = head.findIndex((h) => re.test(h.trim())); return i >= 0 ? i : fb; };
  const colObjType = hIdx(/^objection type/i, 14), colSay = hIdx(/^what the customer says/i, 15), colTip = hIdx(/^behaviour tip/i, 16);
  const attCol = {};
  attributes.forEach((a, i) => { attCol[a.id] = hIdx(new RegExp("^" + a.id + "\\b"), 2 + i); });
  const cardList = [], cardMap = {};
  for (const r of cards.slice(1)) {
    const id = str(r[0]).trim(); if (!id) continue;
    const values = {}; for (const a of attributes) values[a.id] = str(r[attCol[a.id]]);
    const c = { id, persona: str(r[1]), values, objType: str(r[colObjType]), objSay: str(r[colSay]), tip: str(r[colTip]) };
    cardList.push(id); cardMap[id] = c;
  }
  const concepts = con.filter((r) => str(r[0]).trim()).map((r) => {
    const parts = str(r[6]).toUpperCase().split(/[,;\s]+/).filter(Boolean);
    return {
      id: str(r[0]).trim(), module: num(r[1]), moduleTa: str(r[2]), moduleEn: str(r[3]), ta: str(r[4]), en: str(r[5]),
      all: !parts.length || parts.includes("ALL"), cards: new Set(parts),
    };
  });
  // Discovery_Marks header gives the attribute column order (B..M)
  const dmHead = (dm[0] || []).map(str);
  const attIdSet = new Set(attributes.map((a) => a.id));
  const dmAttrIds = dmHead.slice(1).map((h) => h.trim()).filter((h) => attIdSet.has(h));
  // intended asking order = Attributes tab order, only attributes with "Order scored" = Y
  const orderIds = attributes.filter((a) => a.ordered).map((a) => a.id);
  // row layout: A id | B.. attribute Y/N | Marked By | Marked At | P Ask Order | Q Order Correct
  const v = { settings, employees, attributes, cards: cardMap, cardList, concepts, dmAttrIds, orderIds, dmWidth: Math.max(dmHead.length, 17) };
  staticCache = { t: Date.now(), v };
  return v;
}
const applies = (c, cardId) => c.all || c.cards.has(cardId);

// ---------- live tabs ----------
let dynCache = { t: 0, v: null };
const invalidate = () => { dynCache = { t: 0, v: null }; };
async function loadDyn(env, fresh = false) {
  if (!fresh && dynCache.v && Date.now() - dynCache.t < DYN_TTL) return dynCache.v;
  const [sch, sc, rot, dmRows] = await batchGet(env, ["Schedule!A2:J", "Scores!A2:Q501", "Rotations!A2:K21", "Discovery_Marks!A2:Q"]);
  const schedule = sch.map((r, i) => ({
    row: i + 2, id: str(r[0]), date: str(r[1]), rotation: num(r[2]), salesId: str(r[3]), sales: str(r[4]),
    custId: str(r[5]), customer: str(r[6]), cardId: str(r[7]), createdAt: str(r[9]),
  })).filter((s) => s.id);
  const scores = new Map();
  for (const r of sc) {
    if (!str(r[0])) continue;
    scores.set(str(r[0]), {
      id: str(r[0]), rotation: num(r[1]), date: str(r[2]), salesId: str(r[3]), sales: str(r[4]), customer: str(r[5]),
      found: num(r[7]), discovery: num(r[8]), applicable: num(r[9]), rated: num(r[10]), concept: num(r[12]), final: num(r[13]), status: str(r[14]), orderOk: num(r[15]), order: num(r[16]),
    });
  }
  const rotations = rot.map((r, i) => ({
    row: i + 2, no: num(r[0]), start: str(r[1]), end: str(r[2]), status: str(r[3]).trim(), winners: [str(r[7]), str(r[8]), str(r[9])],
  })).filter((r) => r.no > 0);
  const marks = new Map(dmRows.filter((r) => str(r[0])).map((r) => [str(r[0]), r]));
  const v = { schedule, scores, rotations, marks };
  dynCache = { t: Date.now(), v };
  return v;
}
const statusOf = (D, id) => D.scores.get(id)?.status || "Waiting: customer ticks";
const currentRotation = (D) => D.rotations.find((r) => r.status.toLowerCase() === "active") || bad("noRot");

// ---------- manager token (HMAC-SHA256, 8 hours) ----------
const hmacKey = (env) => crypto.subtle.importKey("raw", enc.encode(env.TOKEN_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
async function makeToken(env) {
  const payload = b64u(enc.encode(JSON.stringify({ role: "manager", exp: Date.now() + TOKEN_HOURS * 3600 * 1000 })));
  const sig = await crypto.subtle.sign("HMAC", await hmacKey(env), enc.encode(payload));
  return { token: `${payload}.${b64u(sig)}`, expires: Date.now() + TOKEN_HOURS * 3600 * 1000 };
}
async function requireManager(req, env) {
  const t = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  const [p, s] = t.split(".");
  if (!p || !s) bad("auth");
  let ok = false;
  try { ok = await crypto.subtle.verify("HMAC", await hmacKey(env), b64uDecode(s), enc.encode(p)); } catch { ok = false; }
  if (!ok) bad("auth");
  let payload; try { payload = JSON.parse(new TextDecoder().decode(b64uDecode(p))); } catch { bad("auth"); }
  if (payload.role !== "manager" || !(payload.exp > Date.now())) bad("auth");
}
// constant-time password check: HMAC the guess, then use the (constant-time) verify against the real one
async function passwordOk(env, guess) {
  const key = await hmacKey(env);
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(guess));
  return crypto.subtle.verify("HMAC", key, sig, enc.encode(env.MANAGER_PASSWORD));
}
const loginFails = new Map(); // ip -> [timestamps]; 5 wrong tries per 5 minutes
function throttle(ip) {
  const now = Date.now(); const a = (loginFails.get(ip) || []).filter((t) => now - t < 300000);
  loginFails.set(ip, a); if (a.length >= 5) bad("busy");
}

// ---------- validation ----------
const SID = /^S\d{3,6}$/;
const sidOf = (v) => { const s = str(v).trim(); if (!SID.test(s)) bad("input"); return s; };
const rotOf = (v) => { const n = Number(v); if (!Number.isInteger(n) || n < 1 || n > 999) bad("input"); return n; };
const cleanNote = (v) => str(v).replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 300);

// ---------- views ----------
function sessionView(D, s) {
  const sc = D.scores.get(s.id);
  return {
    id: s.id, rotation: s.rotation, date: s.date,
    salesperson: { id: s.salesId, name: s.sales }, customer: { id: s.custId, name: s.customer },
    status: statusOf(D, s.id), found: sc?.found ?? 0,
    discovery: sc?.discovery ?? 0, order: sc?.order ?? 0, orderCorrect: sc?.orderOk ?? 0, concept: sc?.concept ?? 0, final: sc?.final ?? 0,
  };
}
const findSession = (D, id) => D.schedule.find((s) => s.id === id) || fail(404, ...E.notFound);
const rotationSessions = (D, no) => D.schedule.filter((s) => s.rotation === no);
const openSessionOf = (D, no) => rotationSessions(D, no).find((s) => statusOf(D, s.id) !== "Complete");

function rotationProgress(S, D, rot) {
  const sessions = rotationSessions(D, rot.no);
  const performed = new Set(sessions.map((s) => s.salesId));
  const active = S.employees.filter((e) => e.active);
  const remaining = active.filter((e) => !performed.has(e.id));
  const completed = sessions.filter((s) => statusOf(D, s.id) === "Complete").length;
  return {
    active, remaining, total: active.length, performed: performed.size, completed,
    canClose: sessions.length > 0 && remaining.length === 0 && completed === sessions.length,
  };
}

// leaderboard: Complete sessions only; ties -> higher Concept score; exact ties flagged TIE
function buildLeaderboard(S, D, rotNo) {
  const order = new Map(S.employees.map((e, i) => [e.id, i]));
  const bm = badgeMap(S, D);
  const list = [...D.scores.values()].filter((s) => s.rotation === rotNo && s.status === "Complete");
  list.sort((a, b) => b.final - a.final || b.concept - a.concept || (order.get(a.salesId) ?? 999) - (order.get(b.salesId) ?? 999));
  return list.map((s, i) => ({
    rank: i + 1, id: s.salesId, name: s.sales, final: s.final, concept: s.concept, discovery: s.discovery, order: s.order, sessionId: s.id, badges: bm.get(s.id) || [],
    prize: S.settings.prizes[i] || "",
    tie: list.filter((o) => o.final === s.final && o.concept === s.concept).length > 1,
  }));
}

// ---------- badges (all calculated from existing Scores / Discovery_Marks, nothing new in the sheet) ----------
//  perfect  = every order-scored attribute asked in the intended order
//  mind     = every attribute discovered
//  budget   = budget asked LAST (the last order-scored attribute), in the right place
//  comeback = higher final score than that person's previous completed rotation
//  hattrick = completed a session in 3 rotations in a row
function badgeMap(S, D) {
  const out = new Map();
  const done = [...D.scores.values()].filter((x) => x.status === "Complete");
  const finals = new Map(); // salesId -> Map(rotation -> final)
  for (const x of done) { if (!finals.has(x.salesId)) finals.set(x.salesId, new Map()); finals.get(x.salesId).set(x.rotation, x.final); }
  const total = S.orderIds.length, budgetId = S.orderIds[total - 1], attrN = S.dmAttrIds.length;
  for (const x of done) {
    const b = [];
    if (total && x.orderOk === total) b.push("perfect");
    if (attrN && x.found === attrN) b.push("mind");
    const asked = askedOf(S, D.marks.get(x.id));
    const scoredAsked = asked.filter((a) => S.orderIds.includes(a));
    if (budgetId && scoredAsked.at(-1) === budgetId && orderChain(S, asked).includes(budgetId)) b.push("budget");
    const mine = finals.get(x.salesId);
    const before = [...mine.keys()].filter((r) => r < x.rotation);
    if (before.length && x.final > mine.get(Math.max(...before))) b.push("comeback");
    if (mine.has(x.rotation - 1) && mine.has(x.rotation - 2)) b.push("hattrick");
    out.set(x.id, b);
  }
  return out;
}
// Ludo board: every active employee is a token in the Yard (not yet played), on the Track (playing now) or Home (finished)
function buildBoard(S, D, rot, prog, open) {
  const bm = badgeMap(S, D);
  const turns = new Map(rotationSessions(D, rot.no).map((x, i) => [x.salesId, { x, n: i + 1 }]));
  const players = prog.active.map((e) => {
    const t = turns.get(e.id);
    const finished = !!t && statusOf(D, t.x.id) === "Complete";
    return {
      id: e.id, name: e.name, floor: e.floor,
      zone: !t ? "yard" : finished ? "home" : "track",
      turn: t ? t.n : 0,
      final: finished ? (D.scores.get(t.x.id)?.final ?? 0) : null,
      badges: finished ? bm.get(t.x.id) || [] : [],
    };
  });
  return { players, guest: open ? { id: open.custId, name: open.customer } : null };
}

// ---------- shuffle ----------
function pickCard(S, schedule) {
  // shuffled-deck dealing: a card is not repeated until all cards have been used once
  let used = new Set();
  for (const s of schedule) {
    if (!S.cards[s.cardId]) continue;
    used.add(s.cardId);
    if (used.size >= S.cardList.length) used = new Set();
  }
  const pool = S.cardList.filter((c) => !used.has(c));
  return pick(pool);
}
function nextSessionId(schedule) {
  let max = 0; for (const s of schedule) { const m = /^S(\d+)$/.exec(s.id); if (m) max = Math.max(max, Number(m[1])); }
  return "S" + String(max + 1).padStart(3, "0");
}

async function removeSession(env, id, scheduleRow) {
  // scheduleRow lets a rollback remove exactly one Schedule row even if an ID was duplicated
  await compact(env, "Schedule", 10, (r, i) => (scheduleRow ? i + 2 === scheduleRow : str(r[0]) === id));
  if (!scheduleRow) {
    await compact(env, "Discovery_Marks", 17, (r) => str(r[0]) === id);
  }
  await compact(env, "Concept_Ratings", 7, (r) => str(r[0]) === id);
  invalidate();
}

async function doShuffle(env) {
  const S = await loadStatic(env);
  const D = await loadDyn(env, true);
  const rot = currentRotation(D);
  if (rot.status.toLowerCase() !== "active") bad("closed");
  if (openSessionOf(D, rot.no)) bad("open");
  const prog = rotationProgress(S, D, rot);
  if (prog.active.length < 2) bad("few");
  if (!prog.remaining.length) bad("allDone");

  const sp = pick(prog.remaining);
  const cust = pick(prog.active.filter((e) => e.id !== sp.id));
  const cardId = pickCard(S, D.schedule);
  const id = nextSessionId(D.schedule);
  const { date, stamp } = istNow();

  const row = await appendRows(env, "Schedule", [[id, date, rot.no, sp.id, sp.name, cust.id, cust.name, cardId, "Scheduled", stamp]]);
  invalidate();
  try {
    // concurrency check: if another shuffle slipped in first (earlier row), ours steps aside
    const D2 = await loadDyn(env, true);
    const clash = D2.schedule.some((s) => s.rotation === rot.no && s.row < row && (s.id === id || s.salesId === sp.id || statusOf(D2, s.id) !== "Complete"));
    if (clash) { await removeSession(env, id, row); bad("race"); }
    // one rating row per concept: Applicable Y/N, rating blank (Y) or NA (N)
    const rows = S.concepts.map((c) => {
      const a = applies(c, cardId);
      return [id, c.id, c.module, a ? "Y" : "N", a ? "" : "NA", "", ""];
    });
    await appendRows(env, "Concept_Ratings", rows);
  } catch (e) {
    if (!(e instanceof HttpError && e.en === E.race[1])) { try { await removeSession(env, id); } catch (_) { /* best effort */ } }
    throw e;
  }
  if (!rot.start) await writeBatch(env, [{ range: `Rotations!B${rot.row}`, values: [[date]] }]);
  invalidate();
  // the card is deliberately NOT returned here
  return { sessionId: id, rotation: rot.no, salesperson: { id: sp.id, name: sp.name }, customer: { id: cust.id, name: cust.name } };
}

// ---------- order of asking ----------
// Longest chain of order-scored attributes that were asked in the intended relative order.
// A skipped or out-of-place question only loses its OWN share; it does not shift everything after it.
function orderChain(S, asked) {
  const rank = new Map(S.orderIds.map((id, i) => [id, i]));
  const seq = asked.filter((id) => rank.has(id));
  const len = seq.map(() => 1), prev = seq.map(() => -1);
  let end = -1;
  seq.forEach((id, i) => {
    for (let j = 0; j < i; j++) if (rank.get(seq[j]) < rank.get(id) && len[j] + 1 > len[i]) { len[i] = len[j] + 1; prev[i] = j; }
    if (end < 0 || len[i] > len[end]) end = i;
  });
  const chain = [];
  for (let i = end; i >= 0; i = prev[i]) chain.unshift(seq[i]);
  return chain;
}
// attributes the customer ticked, in the order they were ticked (from Discovery_Marks column P)
function askedOf(S, mine) {
  if (!mine) return [];
  const n = S.dmAttrIds.length;
  const flagged = S.dmAttrIds.filter((a, i) => str(mine[1 + i]).toUpperCase() === "Y");
  const saved = str(mine[3 + n]).split(",").map((x) => x.trim()).filter((a) => flagged.includes(a));
  return [...new Set([...saved, ...flagged])];
}

// ---------- customer ticks ----------
async function customerView(env, id) {
  const S = await loadStatic(env); const D = await loadDyn(env, true);
  const s = findSession(D, id);
  const card = S.cards[s.cardId] || fail(500, ...E.input);
  const [dm] = await batchGet(env, ["Discovery_Marks!A2:Q"]);
  const mine = dm.find((r) => str(r[0]) === id);
  const ticks = askedOf(S, mine);
  const view = sessionView(D, s);
  return {
    session: view, locked: view.status === "Complete", submitted: !!mine, ticks,
    persona: card.persona,
    attributes: S.attributes.map((a) => ({ id: a.id, ta: a.ta, en: a.en, value: card.values[a.id], ordered: a.ordered })),
    objection: { type: card.objType, says: card.objSay, tip: card.tip },
  };
}
async function saveTicks(env, body) {
  const id = sidOf(body.sessionId);
  if (!Array.isArray(body.ticks) || body.ticks.length > 50) bad("input");
  const S = await loadStatic(env); const D = await loadDyn(env, true);
  const s = findSession(D, id);
  if (statusOf(D, id) === "Complete") bad("locked");
  // ticks arrive in the order the customer tapped them = the order the salesperson asked
  const valid = new Set(S.dmAttrIds); const asked = [];
  for (const t of body.ticks) { if (!valid.has(t)) bad("input"); if (!asked.includes(t)) asked.push(t); }
  const chain = orderChain(S, asked);
  const { stamp } = istNow();
  const row = pad([id, ...S.dmAttrIds.map((a) => (asked.includes(a) ? "Y" : "N")), s.customer, stamp, asked.join(","), chain.length], S.dmWidth);
  const [dm] = await batchGet(env, ["Discovery_Marks!A2:A"]);
  const idx = dm.findIndex((r) => str(r[0]) === id);
  if (idx >= 0) await writeBatch(env, [{ range: `Discovery_Marks!A${idx + 2}:${colLetter(S.dmWidth)}${idx + 2}`, values: [row] }]);
  else await appendRows(env, "Discovery_Marks", [row]);
  invalidate();
  const D2 = await loadDyn(env, true);
  return { found: asked.length, session: sessionView(D2, findSession(D2, id)) };
}

// ---------- manager ----------
async function managerQueue(env) {
  const S = await loadStatic(env); const D = await loadDyn(env, true);
  const rot = currentRotation(D); const prog = rotationProgress(S, D, rot);
  return {
    rotation: rot.no, canClose: prog.canClose, remaining: prog.remaining.length,
    sessions: rotationSessions(D, rot.no).map((s) => sessionView(D, s)).filter((v) => v.status !== "Complete").reverse(),
  };
}
async function loadRatings(env, id) {
  const [cr] = await batchGet(env, ["Concept_Ratings!A2:G20000"]);
  const out = [];
  cr.forEach((r, i) => {
    if (str(r[0]) !== id) return;
    const raw = r[4];
    out.push({ row: i + 2, cid: str(r[1]), applicable: str(r[3]) === "Y", rating: raw === "" || raw == null || raw === "NA" ? null : Number(raw), note: str(r[5]) });
  });
  return out;
}
async function managerSession(env, id) {
  const S = await loadStatic(env); const D = await loadDyn(env, true);
  const s = findSession(D, id);
  const ratings = await loadRatings(env, id);
  const byId = new Map(ratings.map((r) => [r.cid, r]));
  const modules = new Map();
  for (const c of S.concepts) {
    const r = byId.get(c.id); if (!r || !r.applicable) continue;
    if (!modules.has(c.module)) modules.set(c.module, { no: c.module, ta: c.moduleTa, en: c.moduleEn, concepts: [] });
    modules.get(c.module).concepts.push({ id: c.id, ta: c.ta, en: c.en, rating: r.rating, note: r.note });
  }
  const card = S.cards[s.cardId];
  const [dm] = await batchGet(env, ["Discovery_Marks!A2:Q"]);
  const asked = askedOf(S, dm.find((r) => str(r[0]) === id));
  const chain = new Set(orderChain(S, asked));
  const att = new Map(S.attributes.map((a) => [a.id, a]));
  const label = (aid) => ({ id: aid, ta: att.get(aid)?.ta || aid, en: att.get(aid)?.en || "" });
  const order = {
    total: S.orderIds.length, weight: S.settings.orderWeight,
    asked: asked.map((aid) => ({ ...label(aid), scored: !!att.get(aid)?.ordered, credited: chain.has(aid) })),
    missed: S.orderIds.filter((aid) => !asked.includes(aid)).map(label),
    intended: S.orderIds.map(label),
  };
  return {
    session: sessionView(D, s), max: S.settings.maxRating, weight: S.settings.conceptWeight, order, attrCount: S.dmAttrIds.length,
    context: card ? { persona: card.persona, objection: card.objType } : null,
    modules: [...modules.values()].sort((a, b) => a.no - b.no),
  };
}
async function saveRatings(env, body) {
  const id = sidOf(body.sessionId);
  const S = await loadStatic(env); const D = await loadDyn(env, true);
  const s = findSession(D, id);
  const rot = currentRotation(D);
  if (s.rotation !== rot.no) bad("closed");
  const ratings = body.ratings && typeof body.ratings === "object" ? body.ratings : {};
  const notes = body.notes && typeof body.notes === "object" ? body.notes : {};
  const rows = await loadRatings(env, id);
  const byId = new Map(rows.filter((r) => r.applicable).map((r) => [r.cid, r]));
  const max = S.settings.maxRating;
  const data = []; const { stamp } = istNow();
  const touched = new Set([...Object.keys(ratings), ...Object.keys(notes)]);
  if (touched.size > 200) bad("input");
  for (const cid of touched) {
    const r = byId.get(cid); if (!r) bad("input");
    let val = r.rating, note = r.note;
    if (cid in ratings) {
      const v = ratings[cid];
      if (v === null || v === "") val = null;
      else if (Number.isInteger(v) && v >= 0 && v <= max) val = v;
      else bad("input");
    }
    if (cid in notes) note = cleanNote(notes[cid]);
    r.rating = val; r.note = note;
    data.push({ range: `Concept_Ratings!E${r.row}:G${r.row}`, values: [[val === null ? "" : val, note, val === null ? "" : stamp]] });
  }
  if (body.submit === true && [...byId.values()].some((r) => r.rating === null)) bad("needAll");
  if (data.length) await writeBatch(env, data);
  invalidate();
  const D2 = await loadDyn(env, true);
  return { session: sessionView(D2, findSession(D2, id)) };
}
async function cancelSession(env, body) {
  const id = sidOf(body.sessionId);
  const D = await loadDyn(env, true);
  const s = findSession(D, id);
  if (s.rotation !== currentRotation(D).no) bad("closed");
  await removeSession(env, id);
  return { cancelled: id };
}
async function closeRotation(env) {
  const S = await loadStatic(env); const D = await loadDyn(env, true);
  const rot = currentRotation(D);
  const prog = rotationProgress(S, D, rot);
  if (!prog.canClose) bad("cantClose");
  const board = buildLeaderboard(S, D, rot.no);
  const top = board.slice(0, 3);
  const used = D.rotations.map((r) => r.row);
  const nextRow = Math.max(...used) + 1;
  if (nextRow > 21) bad("rotFull");
  const { date } = istNow();
  const w = [0, 1, 2].map((i) => top[i]?.name || "");
  await writeBatch(env, [
    { range: `Rotations!C${rot.row}:D${rot.row}`, values: [[date, "Closed"]] },
    { range: `Rotations!H${rot.row}:K${rot.row}`, values: [[w[0], w[1], w[2], "N"]] },
    { range: `Rotations!A${nextRow}:D${nextRow}`, values: [[rot.no + 1, date, "", "Active"]] },
  ]);
  invalidate();
  return { closed: rot.no, next: rot.no + 1, winners: top, hasTie: top.some((t) => t.tie) };
}

// ---------- public reads ----------
async function homeState(env) {
  const S = await loadStatic(env); const D = await loadDyn(env);
  const rot = currentRotation(D); const prog = rotationProgress(S, D, rot);
  const open = openSessionOf(D, rot.no);
  return {
    rotation: { no: rot.no, start: rot.start }, total: prog.total, performed: prog.performed, completed: prog.completed,
    remaining: prog.remaining.map((e) => e.name), activeNames: prog.active.map((e) => e.name),
    open: open ? sessionView(D, open) : null, canClose: prog.canClose,
    board: buildBoard(S, D, rot, prog, open), orderTotal: S.orderIds.length,
    prizes: S.settings.prizes, weights: { discovery: S.settings.discoveryWeight, order: S.settings.orderWeight, concept: S.settings.conceptWeight },
    people: S.employees.map((e) => ({ id: e.id, name: e.name })),
    rotations: D.rotations.map((r) => ({ no: r.no, status: r.status })),
  };
}
async function leaderboard(env, rotParam) {
  const S = await loadStatic(env); const D = await loadDyn(env);
  const no = rotParam ? rotOf(rotParam) : currentRotation(D).no;
  const rows = buildLeaderboard(S, D, no);
  const pending = rotationSessions(D, no).filter((s) => statusOf(D, s.id) !== "Complete").length;
  return {
    rotation: no, rotations: D.rotations.map((r) => ({ no: r.no, status: r.status })), rows, pending,
    status: D.rotations.find((r) => r.no === no)?.status || "",
  };
}
async function history(env, q) {
  const D = await loadDyn(env);
  const rot = q.get("rotation") ? rotOf(q.get("rotation")) : 0;
  const emp = str(q.get("employee")).trim();
  if (emp && !/^[A-Za-z0-9_-]{1,12}$/.test(emp)) bad("input");
  const list = D.schedule.filter((s) => (!rot || s.rotation === rot) && (!emp || s.salesId === emp || s.custId === emp))
    .map((s) => ({ ...sessionView(D, s), createdAt: s.createdAt })).reverse();
  return { sessions: list.slice(0, 300) };
}

// ---------- router ----------
const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" } });
async function readBody(req) {
  const text = await req.text();
  if (text.length > 20000) bad("input");
  try { const b = JSON.parse(text || "{}"); return b && typeof b === "object" ? b : {}; } catch { return bad("input"); }
}

async function route(req, env, url) {
  const p = url.pathname, m = req.method;
  const q = url.searchParams;
  if (p === "/api/state" && m === "GET") return homeState(env);
  if (p === "/api/session" && m === "GET") { const D = await loadDyn(env, true); return { session: sessionView(D, findSession(D, sidOf(q.get("id")))) }; }
  if (p === "/api/customer" && m === "GET") return customerView(env, sidOf(q.get("id")));
  if (p === "/api/ticks" && m === "POST") return saveTicks(env, await readBody(req));
  if (p === "/api/shuffle" && m === "POST") return doShuffle(env);
  if (p === "/api/leaderboard" && m === "GET") return leaderboard(env, q.get("rotation"));
  if (p === "/api/history" && m === "GET") return history(env, q);
  if (p === "/api/login" && m === "POST") {
    const ip = req.headers.get("CF-Connecting-IP") || "x"; throttle(ip);
    const b = await readBody(req);
    if (!(await passwordOk(env, str(b.password)))) { loginFails.get(ip).push(Date.now()); bad("pass"); }
    return makeToken(env);
  }
  if (p.startsWith("/api/manager/")) {
    await requireManager(req, env);
    if (p === "/api/manager/queue" && m === "GET") return managerQueue(env);
    if (p === "/api/manager/session" && m === "GET") return managerSession(env, sidOf(q.get("id")));
    if (p === "/api/manager/rate" && m === "POST") return saveRatings(env, await readBody(req));
    if (p === "/api/manager/cancel" && m === "POST") return cancelSession(env, await readBody(req));
    if (p === "/api/manager/close" && m === "POST") return closeRotation(env);
  }
  return fail(404, "கிடைக்கவில்லை.", "Not found.");
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (!url.pathname.startsWith("/api/")) return env.ASSETS.fetch(req);
    try {
      for (const k of ["GOOGLE_SERVICE_ACCOUNT_EMAIL", "GOOGLE_PRIVATE_KEY", "SHEET_ID", "MANAGER_PASSWORD", "TOKEN_SECRET"]) if (!env[k]) bad("setup");
      return json({ ok: true, ...(await route(req, env, url)) });
    } catch (e) {
      if (e instanceof HttpError) return json({ ok: false, error: { ta: e.ta, en: e.en } }, e.status);
      console.error(e);
      return json({ ok: false, error: { ta: "ஏதோ தவறு நடந்தது. மீண்டும் முயற்சிக்கவும்.", en: "Something went wrong. Please try again." } }, 500);
    }
  },
};
