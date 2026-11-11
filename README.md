# Roleplay Coaster · ரோல்பிளே கோஸ்டர்

A jewellery-sales roleplay practice app for a 28-person store floor.

- **Shuffle** picks a Salesperson and a Customer at random.
- The customer secretly gets a persona card (12 attributes + 1 objection).
- The salesperson asks questions, discovers the 12 attributes, then presents jewellery using the trained sales concepts (in Tamil).
- The customer ticks which attributes were discovered.
- The manager rates each applicable concept from 1–5 (0 = not covered).
- Google Sheet formulas combine both into a score out of 100, and each rotation has its own leaderboard with prizes for the top 3.

**Stack (fixed):** Google Sheets as the database · one Cloudflare Worker (all backend logic) · a single static `index.html` · GitHub → Cloudflare auto-deploy.

### You do not install anything on your PC

No Node.js, no Wrangler, no command line. You upload five files to GitHub, connect the repo to Cloudflare once, and Cloudflare builds and hosts it. Every later update is another small upload.

```
public/index.html   the whole website (HTML + CSS + JavaScript)
src/worker.js       the whole backend (Google login, Sheets, API routes)
wrangler.jsonc      Cloudflare settings
.gitignore          files that must never be uploaded
README.md           this file
```

These five files live in:

```
C:\Users\newhire\Documents\Default Project\roleplay-coaster
```

There is **no build step** and no other files. (Cloudflare installs its own tools on its build machines — that part is invisible to you.)

---

## ⚠️ Use the corrected spreadsheet

I patched two silent breakages in your workbook. Upload **`Roleplay_Coaster_Database_v2.xlsx`** (in your Downloads folder), **not** the original.

| What was wrong | What happens later | What I changed |
| --- | --- | --- |
| `Scores` had formulas only for rows 2–501 (500 sessions) | Session 501+ would never get a score, so it could never be "Complete" | Formulas now run to row **1001** (1000 sessions) |
| `Scores` looked at `Concept_Ratings` rows 2–20,000 | At 62 rows per session that is ~322 sessions, after which concept scores go wrong | Lookup ranges now go to row **63,000** (≈1000 sessions) |
| `Rotations` / `Leaderboard_Calc` pointed at `Scores` row 501 | "Sessions fully scored" and the sheet leaderboard would freeze | Pointed at the new last row (1001) |

Nothing else changed — no tab names, no column names, no layout.

---

# Part 1 · Put the spreadsheet in Google Drive

1. Open <https://drive.google.com> and sign in with the store's Google account.
2. Drag **`Roleplay_Coaster_Database_v2.xlsx`** into Drive (or click **+ New → File upload**).
3. Double-click the uploaded file. Google opens a preview.
4. At the top, click **Open with Google Sheets** (or right-click the file in Drive → **Open with → Google Sheets**).
5. In Google Sheets: **File → Save as Google Sheets**. A new spreadsheet appears.
6. (Optional but tidy) Rename it **Roleplay Coaster Database**. Delete the `.xlsx` copy from Drive so nobody edits the wrong file.
7. **Copy the Sheet ID.** Look at the address bar:

   ```
   https://docs.google.com/spreadsheets/d/1AbCdEfGhIjKlMnOpQrStUvWxYz1234567890/edit#gid=0
                                          └──────────── this long part ────────────┘
   ```

   That long string between `/d/` and `/edit` is your **SHEET_ID**. Paste it into Notepad for now.

> Google may warn "This file was created by another app". That is normal. Click **Allow** / **Save as Google Sheets**.

---

# Part 2 · Create the Google "service account"

A service account is a robot Google account. The Worker logs in as the robot; the robot is allowed to edit your sheet.

1. Go to <https://console.cloud.google.com/> and sign in with the **same Google account**.
2. At the very top, click the project dropdown → **New project**.
   - Project name: `roleplay-coaster`
   - Location: leave as is
   - Click **Create**, wait a few seconds, then make sure the project selector at the top shows `roleplay-coaster`.
3. Open the menu (☰, top-left) → **APIs & Services → Library**.
4. Search for **Google Sheets API** → click it → click **Enable**. Wait for "API enabled".
5. Open the menu → **IAM & Admin → Service Accounts** → **+ Create service account**.
   - Service account name: `roleplay-coaster`
   - Service account ID fills itself in (something like `roleplay-coaster@roleplay-coaster-123456.iam.gserviceaccount.com`)
   - Click **Create and continue**
   - On "Grant this service account access to project" **leave everything empty** → **Continue** → **Done**
6. In the list, click the new service account. Open the **Keys** tab.
7. **Add key → Create new key → JSON → Create**. A `.json` file downloads. **This file is a password — never email it, never put it on GitHub.**
8. Open the JSON in Notepad. You need two values inside it:
   - `"client_email": "roleplay-coaster@....iam.gserviceaccount.com"` ← the robot's address
   - `"private_key": "-----BEGIN PRIVATE KEY-----\nMIIE...\n-----END PRIVATE KEY-----\n"` ← the robot's key
9. Go back to your Google Sheet → **Share** (top-right).
   - Paste the **client_email** address.
   - Role: **Editor**.
   - Untick "Notify people" → **Share**.
   - If Google says the account "does not exist", press **Share anyway** — it does exist.

> If **Create new key** is greyed out, your Google Workspace administrator has blocked service-account keys. Ask them to allow it for this project, or use a personal Google account for setup.

---

# Part 3 · Upload the five files to GitHub

1. Sign in at <https://github.com> (create a free account if needed).
2. Click **+** (top-right) → **New repository**.
   - Repository name: `roleplay-coaster`
   - Visibility: **Private**
   - Tick nothing else (no README, no .gitignore, no licence)
   - Click **Create repository**.
3. On the empty repository page, click the link **uploading an existing file** (in the "Quick setup" box). If you cannot see it, use **Add file → Upload files**.
4. Open File Explorer and go to:

   ```
   C:\Users\newhire\Documents\Default Project\roleplay-coaster
   ```

5. Select **all five items** and drag them into the dotted upload box in your browser:

   - the `.gitignore` file
   - `README.md`
   - `wrangler.jsonc`
   - the **`public`** folder
   - the **`src`** folder

   Dragging folders uploads what is inside them, so the browser list should end up showing:
   `public/index.html`, `src/worker.js`, and the three files at the top level.
6. In the "Commit changes" box at the bottom, type `Roleplay Coaster` and click **Commit changes**.

> **Important:** `wrangler.jsonc`, `public` and `src` must sit at the **top level** of the repository (not inside another folder). Cloudflare looks for `wrangler.jsonc` there.

> If `.gitignore` does not appear in Explorer, click **View → Show → Hidden items** in Explorer's toolbar.

---

# Part 4 · Connect GitHub to Cloudflare (one time)

1. Sign in at <https://dash.cloudflare.com> (create a free account if needed).
2. In the left sidebar click **Workers & Pages** → **Create** → **Workers** → **Import a repository** (some accounts label it **Connect to Git**).
3. Click **Connect GitHub** → authorise Cloudflare:
   - Choose **Only select repositories** → pick `roleplay-coaster` → **Install & Authorize**.
4. Back in Cloudflare, select `roleplay-coaster` → **Begin setup**.
5. Fill the form exactly like this:

   | Field | What to put |
   | --- | --- |
   | Project name | `roleplay-coaster` |
   | Production branch | `main` |
   | Build command | **leave completely empty** |
   | Deploy command | `npx --yes wrangler deploy` |
   | Root directory | **leave empty** |

6. Click **Deploy** and wait ~1–2 minutes. The **Deployments** tab shows the progress.
7. When it finishes, click the link at the top (like `https://roleplay-coaster.your-name.workers.dev`).

You will see the red **Connection failed** card saying some secrets are missing. That is expected — the next part fixes it.

> From now on, **every change you upload to that GitHub repo is redeployed automatically** in about a minute. That is the whole deploy process.

---

# Part 5 · Add the five secrets in the Cloudflare dashboard

Secrets are kept by Cloudflare and never appear in the code or on GitHub.

1. Open <https://dash.cloudflare.com> → **Workers & Pages** → click **roleplay-coaster**.
2. Open the **Settings** tab → **Variables and Secrets** (older accounts call it **Environment Variables**).
3. Click **+ Add** (or **Add variable**), then for each of these five rows choose **Type: Secret**, type the **Name**, paste the **Value**, and click **Save**:

   | Name | Value |
   | --- | --- |
   | `SHEET_ID` | the long ID from Part 1 |
   | `MANAGER_PASSWORD` | the password your manager will type |
   | `TOKEN_SECRET` | any long random text, e.g. `k7Qp2sV9xL4mR8tY6wZ3nB5cF1hJ0dGa` |
   | `GOOGLE_SERVICE_ACCOUNT_EMAIL` | the `client_email` from the JSON key file |
   | `GOOGLE_PRIVATE_KEY` | the `private_key` from the JSON key file |

   For `GOOGLE_PRIVATE_KEY`: in Notepad, copy **only** the text between the quote marks after `"private_key":` — it is one long line that contains `\n` in the middle. Do **not** copy the quote marks themselves. (If your editor shows it broken over several lines, that is fine too — the Worker understands both.)

4. If the page shows a **Deploy** / **Save and deploy** button, click it.
5. Open your `workers.dev` link again → you should see the green **Connection OK** card with 28 employees.

> Already have a link open? Refresh it. Secrets take effect immediately, no rebuild needed.

---

# Part 6 · Test it

- [ ] The link shows the green **Connection OK** card, not the red one.
- [ ] Employees **28** (28 active), Attributes **12**, Cards **10**, Concepts **62**.
- [ ] Current rotation **R1**, weights **30 / 70**.
- [ ] All 28 names appear as chips.
- [ ] Rename one employee in the Google Sheet → press **மீண்டும் சோதி · Test again** → the new name appears (this also clears the 5-minute cache).
- [ ] Open the link on a phone — the layout should be readable and the buttons easy to tap.

---

# Part 7 · Updating the app later (no tools needed)

**Everyday update (small change in one file):**

1. Open your repo on GitHub → click the file (e.g. `public/index.html`).
2. Click the **pencil** icon → make the change → **Commit changes**.
3. Wait ~1 minute, refresh the live link. Done.

**When I send you new versions of the files:**

1. Repo → **Add file → Upload files**.
2. Drag the changed files in (same names, same folders) → **Commit changes**. GitHub replaces the old ones.
3. Cloudflare redeploys by itself.

**Where to watch the build:** Cloudflare → **Workers & Pages → roleplay-coaster → Deployments**. Green = live. Click a failed build to read the red error line.

---

# Part 8 · Editing the content later (no code needed)

Everything the app shows comes from the sheet. Edit cells, wait up to 5 minutes (or press **Test again** in the app), and the change appears.

| I want to… | Where |
| --- | --- |
| Add an employee | `Employees`, next empty row: `E29` · Name · Floor · `Y`. Column E is a formula — leave it. |
| Remove someone from the rotation | Set their **Active** to `N` |
| Change a persona / objection | `Customer_Cards`, columns B–Q |
| Add or reword a concept | `Concepts`, new row `K63`… with Module No, module names, concept Tamil/English, **Applies To** (`ALL` or e.g. `C04,C05`), Max Rating `5` |
| Change prizes | `Settings` B8 / B9 / B10 (1st / 2nd / 3rd) |
| Change weights | `Settings` B2 / B3 (must total 100) |
| Change the manager password | Part 9 |

Rules to keep the app working:

- **Keep the 12 attributes.** `Attributes` is read top-to-bottom (A01…A12) and `Customer_Cards` columns C–N are read in that same order. Adding a 13th attribute would shift the card columns.
- **Keep the 10 cards.** The deck deals 10 unique cards per cycle.
- **Applies To** must be `ALL` or card IDs separated by commas: `C04,C05,C06,C07,C10`.
- **Never type in** `Scores`, `Leaderboard`, `Leaderboard_Calc`, `Employees` column E, `Concepts` column H, or `Rotations` columns E–G. They are formulas.
- One rotation row must have Status **Active** at a time.
- Deleting rows by hand can break the row-for-row link between `Schedule` and `Scores`. Use the manager's **Cancel session** button instead (arrives in a later stage).

---

# Part 9 · Changing the manager password

1. <https://dash.cloudflare.com> → **Workers & Pages** → **roleplay-coaster** → **Settings** → **Variables and Secrets**.
2. Click `MANAGER_PASSWORD` → change the value → **Save** → **Deploy** if asked.
3. It works immediately. No GitHub upload needed.

---

# Part 10 · Test checklist

### Stage 1 — connection (works now)

- [ ] Live link shows **Connection OK**.
- [ ] Counts: 28 employees (28 active), 12 attributes, 10 cards, 62 concepts.
- [ ] Rotation R1, weights 30 / 70.
- [ ] All 28 employee names are listed.
- [ ] Rename an employee in the sheet → **Test again** → new name shows.
- [ ] Phone layout is readable.

Shuffle, customer view, manager rating, leaderboard, history and rotation close get their own checklist as each stage is built.

---

# Part 11 · Known limitations

1. **The card is honour-system protected.** There is no customer login, so the "I am the customer" button only asks for confirmation. A determined salesperson could peek. Adding logins would need a second access level and a real user store.
2. **Manager login is a single shared password**, not per-person accounts. Tokens live in `sessionStorage` and expire after 8 hours.
3. **Brute-force protection is best-effort.** It counts attempts per IP inside one Worker instance and adds a delay; Cloudflare isolates are not a durable database. Use a strong password.
4. **Scores come from the sheet, not the Worker.** Google recalculates after a write, so for a second or two a score may look stale. Refresh to see the final value.
5. **Sheet capacity:** 1000 sessions total (≈35 rotations of 28) and 63,000 rating rows. Beyond that the `Scores` formulas need extending again.
6. **`Rotations` columns E–G are formula-filled for the first 20 rotation rows only.** After that those helper columns stay blank; the app does not rely on them (it counts from `Schedule` itself).
7. **Google Sheets quota:** ~60 reads/minute. The app caches Employees/Attributes/Cards/Concepts/Settings for 5 minutes and batches reads, but a burst of many phones at once can still hit the limit briefly.
8. **The deck cycle is continuous across rotations** (all 10 cards before a repeat), so a rotation can start mid-deck.
9. **No offline mode.** Phones need data/wifi.

---

# Part 12 · Troubleshooting

| What you see | What it means | Fix |
| --- | --- | --- |
| Red card: `These Worker secrets are missing: …` | A secret is not set | Part 5. Check the exact spelling of the name. |
| Red card: `Google login failed: invalid_grant` | Email/key pair does not match, or the PC/server clock is off | Re-copy both Google secrets from the **same** JSON file |
| Red card: `Google login failed: … invalid JWT signature` | Key was pasted incompletely | Re-paste the whole `private_key` value |
| Red card: `Google Sheets error (403)` | Sheet not shared with the robot | Share with `client_email` as **Editor** |
| Red card: `Google Sheets error (404)` | Wrong `SHEET_ID` | Copy the ID again from the sheet URL |
| Red card: `Unknown range …` | Sheet tabs were renamed | Tab names must stay `Employees`, `Attributes`, `Customer_Cards`, `Concepts`, `Settings`, `Schedule`, `Discovery_Marks`, `Concept_Ratings`, `Scores`, `Rotations` |
| Cloudflare build fails: `Could not find wrangler.jsonc` | Files were uploaded inside an extra folder | Move `wrangler.jsonc`, `public`, `src` to the repo's top level |
| Cloudflare build fails at `npx wrangler deploy` | Deploy command typed incorrectly | Must be exactly `npx --yes wrangler deploy` |
| Live link shows an old version | Build still running / browser cache | Check **Deployments** for the green tick, then hard-refresh (Ctrl+F5) |
| Counts are 0 | Formulas were pasted as text, or wrong tabs | Use the provided workbook |
| Changes in the sheet do not show | 5-minute cache | Press **Test again** in the app |

---

# Appendix · Optional: run it on your own PC

You never need this. It is only useful if you want to test changes instantly without publishing, or see detailed error logs. It requires Node.js + Wrangler, and it changes nothing about the live site.

1. Install Node.js **LTS** from <https://nodejs.org> (Windows Installer). Keep "Add to PATH" ticked.
2. **Close every PowerShell window and open a new one**, then:

   ```powershell
   node -v
   npm install -g wrangler
   wrangler login
   ```

3. Create a file named `.dev.vars` in the app folder (Notepad → Save as → *All files*):

   ```
   GOOGLE_SERVICE_ACCOUNT_EMAIL=roleplay-coaster@your-project.iam.gserviceaccount.com
   GOOGLE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\nMIIE...\n-----END PRIVATE KEY-----\n"
   SHEET_ID=1AbCdEf...
   MANAGER_PASSWORD=ChangeMe123
   TOKEN_SECRET=dev-only-secret
   ```

4. Start it:

   ```powershell
   cd "C:\Users\newhire\Documents\Default Project\roleplay-coaster"
   wrangler dev
   ```

   Then open <http://localhost:8787>. Press `Ctrl + C` to stop.

5. To publish from the command line instead of GitHub: `wrangler deploy`, then `wrangler secret put NAME` for each secret. This is an alternative to Parts 4–5, **not** an extra requirement — pick one.

`.dev.vars` is listed in `.gitignore`, so it can never be uploaded to GitHub.
