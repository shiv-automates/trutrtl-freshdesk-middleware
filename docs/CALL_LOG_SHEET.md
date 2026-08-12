# Call-log Sheet — one row per call, so the team stops listening to every call

Every completed call POSTs a structured row to a Google Sheet (via a free Google Apps Script
Web App — no API keys, no service account) **and** a matching private note is added to the
caller's Freshdesk ticket when one exists. Set-up is ~5 minutes.

## What each row contains
`time · call_id · caller_number · duration (m:ss) · duration_sec · disposition · resolution ·
action_to_take · callback_needed · product · sentiment · disconnect_reason · summary ·
recording_url · transcript`

`summary`, `sentiment`, `duration`, `transcript`, `recording_url` fill in automatically today.
The four QA columns — **disposition, resolution, action_to_take, callback_needed** — fill in once
you add the matching **Post-Call Data Extraction** fields in Agni (Step 3).

---

## Step 1 — Create the Sheet + Apps Script (2 min)
1. Create a new Google Sheet (name it e.g. **truTRTL Call Log**).
2. **Extensions → Apps Script**. Delete the sample, paste this, **Save**:

```javascript
// truTRTL call-log receiver. Appends one row per call.
const SHEET_NAME = 'Calls';
const SECRET = ''; // optional — if set, must match CALL_LOG_SHEET_SECRET in the middleware .env
const COLUMNS = ['time','call_id','caller_number','duration','duration_sec','disposition',
  'resolution','action_to_take','callback_needed','product','sentiment','disconnect_reason',
  'summary','recording_url','transcript'];

function doPost(e) {
  try {
    const body = JSON.parse(e.postData.contents);
    if (SECRET && body.secret !== SECRET) {
      return ContentService.createTextOutput(JSON.stringify({ ok: false, error: 'unauthorized' }))
        .setMimeType(ContentService.MimeType.JSON);
    }
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    let sh = ss.getSheetByName(SHEET_NAME) || ss.insertSheet(SHEET_NAME);
    if (sh.getLastRow() === 0) sh.appendRow(COLUMNS);        // header row on first call
    sh.appendRow(COLUMNS.map(function (k) { return body[k] != null ? String(body[k]) : ''; }));
    return ContentService.createTextOutput(JSON.stringify({ ok: true }))
      .setMimeType(ContentService.MimeType.JSON);
  } catch (err) {
    return ContentService.createTextOutput(JSON.stringify({ ok: false, error: String(err) }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}
```

## Step 2 — Deploy it + wire the middleware (2 min)
1. In Apps Script: **Deploy → New deployment → type: Web app**.
   - **Execute as:** Me
   - **Who has access:** **Anyone**  ← required so the middleware can POST
   - **Deploy**, authorise, and **copy the Web App URL** (ends in `/exec`).
2. On the VPS, put that URL in `.env`:
   ```
   CALL_LOG_SHEET_URL=https://script.google.com/macros/s/AKfy…/exec
   # optional, if you set SECRET in the script:
   CALL_LOG_SHEET_SECRET=some-shared-secret
   ```
   Then `docker compose up -d` (re-reads .env; no rebuild needed).
3. Send me the URL and I'll set it + verify a row appends.

## Step 3 — Add the QA columns in Agni (Post-Call Data Extraction)
Agent → **Post-Call Data Extraction** → add these **custom fields** (name must match exactly, so
the middleware maps them):

| Field name | Type | Description to give Agni |
|---|---|---|
| `disposition` | enum | Values: `info_only`, `complaint_registered`, `warranty_registered`, `status_checked`, `callback_promised`, `nothing`. Pick the single best outcome of the call. |
| `resolution` | string | One line: what the agent actually told/resolved for the caller. Empty if nothing was resolved. |
| `action_to_take` | string | One line: the next action the human team should take (e.g. "call back to confirm number", "arrange technician", "none"). |
| `callback_needed` | enum | `yes` or `no` — does a human need to call this customer back? |

Once these exist, every new call's row (and Freshdesk note) carries them — the team reads the row
instead of the recording.

---

## Notes
- **Best-effort:** if the Sheet is unreachable, the call and the Freshdesk note are unaffected — the
  middleware logs a warning and moves on. Nothing blocks on the Sheet.
- **Privacy:** the row includes the transcript and caller number. Keep the Sheet restricted to your team.
- The Freshdesk note (same data) is added automatically to the caller's ticket when one exists — no
  setup needed for that half.
