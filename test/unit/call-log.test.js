import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildCallRow, mmss, callLogEnabled } from '../../src/lib/call-log.js';
import { parseAfterCall } from '../../src/lib/ravan.js';

test('call-log: mmss formats seconds as m:ss', () => {
  assert.equal(mmss(134), '2:14');
  assert.equal(mmss(9), '0:09');
  assert.equal(mmss(0), '');
  assert.equal(mmss(null), '');
  assert.equal(mmss(605), '10:05');
});

test('call-log: buildCallRow maps a parsed call to a stable flat row', () => {
  const call = parseAfterCall({
    call_session: {
      id: 'cs-1', caller_number: '+918178490194', duration_sec: 134,
      disconnect_reason: 'user_hangup', recording_url: 'https://rec/1',
      post_call_analysis_result: {
        summary: { type: 'string', value: 'Asked about air fryers.' },
        sentiments: { type: 'enum', value: 'Neutral' },
      },
    },
    transcriptions: 'truTRTL: Hello\n: Hi',
  });
  const row = buildCallRow(call, '2026-08-12T10:00:00Z');
  assert.equal(row.time, '2026-08-12T10:00:00Z');
  assert.equal(row.call_id, 'cs-1');
  assert.equal(row.caller_number, '+918178490194');
  assert.equal(row.duration, '2:14');
  assert.equal(row.sentiment, 'Neutral');
  assert.equal(row.summary, 'Asked about air fryers.');
  assert.equal(row.recording_url, 'https://rec/1');
  assert.match(row.transcript, /truTRTL: Hello/);
  // Custom extraction fields are blank until Agni is configured — never undefined.
  assert.equal(row.resolution, '');
  assert.equal(row.callback_needed, '');
});

test('call-log: disabled (no URL) is a safe no-op', async () => {
  // In the test env CALL_LOG_SHEET_URL is unset, so the feature is off and never throws.
  assert.equal(callLogEnabled(), false);
});
