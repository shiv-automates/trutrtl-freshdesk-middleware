#!/usr/bin/env bash
# Manual end-to-end checks against a running middleware instance.
#   1. cp .env.example .env  &&  fill FRESHDESK_API_KEY + RAVAN_SHARED_SECRET
#   2. npm start             (in another terminal)
#   3. BASE=http://localhost:3000 SECRET=<your RAVAN_SHARED_SECRET> bash test/curl-examples.sh
#
# For a SAFE live register test, run the server with TEST_AUTO_CLOSE=true so the
# created ticket is immediately closed.

set -u
BASE="${BASE:-http://localhost:3000}"
SECRET="${SECRET:-changeme}"
AUTH="Authorization: Bearer ${SECRET}"
JSON="Content-Type: application/json"
hr() { printf '\n──────── %s ────────\n' "$1"; }

hr "health"
curl -s "$BASE/health"; echo

hr "1. status by complaint number (use a REAL recent id, e.g. 11914)"
curl -s -X POST "$BASE/freshdesk/complaint-status" -H "$AUTH" -H "$JSON" \
  -d '{"complaint_number":"11914"}'; echo

hr "2. status by phone number (use a REAL mobile that exists in Freshdesk)"
curl -s -X POST "$BASE/freshdesk/complaint-status" -H "$AUTH" -H "$JSON" \
  -d '{"phone_number":"+919876543210"}'; echo

hr "3. unknown number → {found:false}"
curl -s -X POST "$BASE/freshdesk/complaint-status" -H "$AUTH" -H "$JSON" \
  -d '{"phone_number":"+910000000000"}'; echo

hr "4. wrapped params ({args:{...}}) still work"
curl -s -X POST "$BASE/freshdesk/complaint-status" -H "$AUTH" -H "$JSON" \
  -d '{"args":{"complaint_number":"11914"}}'; echo

hr "5. missing auth → 401"
curl -s -o /dev/null -w "HTTP %{http_code}\n" -X POST "$BASE/freshdesk/complaint-status" -H "$JSON" \
  -d '{"complaint_number":"11914"}'

hr "6. missing params → 400"
curl -s -o /dev/null -w "HTTP %{http_code}\n" -X POST "$BASE/freshdesk/complaint-status" -H "$AUTH" -H "$JSON" \
  -d '{}'

hr "7. register complaint (run server with TEST_AUTO_CLOSE=true!)"
curl -s -X POST "$BASE/freshdesk/register-complaint" -H "$AUTH" -H "$JSON" -d '{
  "name":"Test Caller",
  "phone_number":"+919812345678",
  "product":"48 inch ceiling fan",
  "platform":"Zepto",
  "issue_description":"Fan not running, motor dead",
  "purchase_date":"2026-04-01",
  "order_id":"TEST-ORDER-1",
  "installed":true,
  "pincode":"122015",
  "city":"Gurugram",
  "state":"Haryana"
}'; echo

hr "8. register again (same phone+product) → deduped, same number"
curl -s -X POST "$BASE/freshdesk/register-complaint" -H "$AUTH" -H "$JSON" -d '{
  "name":"Test Caller","phone_number":"+919812345678","product":"ceiling fan",
  "platform":"Zepto","issue_description":"duplicate within window"
}'; echo

hr "9. after-call webhook (creates/updates a ticket)"
curl -s -X POST "$BASE/ravan/after-call" -H "$JSON" -d '{
  "event":"call.completed",
  "data":{
    "call_session_id":"local-test-001",
    "phone":"+919812345678",
    "caller_name":"Test Caller",
    "summary":"Customer reported ceiling fan not working; complaint registered.",
    "post_call_analysis":{"sentiment":"neutral","next_steps":"Send invoice + video on WhatsApp"},
    "transcripts":[{"role":"agent","message":{"content":"Thank you for calling True Turtle."}}],
    "duration_sec":180,"status":"completed"
  }
}'; echo

hr "10. after-call duplicate (same call_session_id) → deduped"
curl -s -X POST "$BASE/ravan/after-call" -H "$JSON" -d '{
  "event":"call.completed","data":{"call_session_id":"local-test-001","phone":"+919812345678","summary":"dup"}
}'; echo
