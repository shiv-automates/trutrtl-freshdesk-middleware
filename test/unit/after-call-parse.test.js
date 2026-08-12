// parseAfterCall against the REAL Agni `call_completed` payload (captured live 2026-08-11).
// Agni's docs are wrong; this is the shape it actually sends. Locks it so a regression that
// re-blinds the after-call webhook ("no phone" on every call) turns this test red.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseAfterCall, renderTranscript } from '../../src/lib/ravan.js';

// Trimmed but structurally faithful copy of the real payload.
const REAL = {
  agent_name: 'truTRTL',
  call_type: 'inbound_call',
  event: 'call_completed',
  call_session: {
    agent_id: '019ea6c3-1327-7805-9372-19ddf5fd1b10',
    callee_number: '+918035763081', // truTRTL's own Plivo line — must NEVER be used as the caller
    caller_number: '+918178490194', // the actual customer
    channel: 'inbound_call',
    disconnect_reason: 'user_hangup',
    duration_sec: 134,
    id: '019ff33e-2fa3-7fea-8793-8554fc4b3aa8',
    recording_url: 'https://api.ravan.ai/api/v1/calling/sessions/019ff33e/recording?token=abc',
    status: 'completed',
    post_call_analysis_result: {
      summary: { type: 'string', value: 'The user asked about air fryers.' },
      sentiments: { type: 'enum', value: 'Neutral' },
    },
  },
  post_call_analysis: {
    first_name: { type: 'string', value: '' },
    last_name: { type: 'string', value: '' },
    summary: { type: 'string', value: 'The user asked about air fryers.' },
    sentiments: { type: 'enum', value: 'Neutral' },
  },
  transcriptions: "truTRTL: Thank you for calling True Turtle...\n: Aara bhai tum ho kaun?\ntruTRTL: Haan, main True Turtle ki AI assistant hoon!",
};

test('⭐ parseAfterCall reads the REAL Agni shape (call_session + transcriptions string)', () => {
  const c = parseAfterCall(REAL);
  // The customer's number is caller_number — NOT callee_number (truTRTL's own line).
  assert.equal(c.phone, '+918178490194');
  assert.notEqual(c.phone, '+918035763081', 'must never pick up truTRTL\'s own callee number');
  assert.equal(c.callId, '019ff33e-2fa3-7fea-8793-8554fc4b3aa8');
  assert.equal(c.durationSec, 134);
  assert.equal(c.disconnectReason, 'user_hangup');
  assert.equal(c.status, 'completed');
  // Nested {type,value} unwrapped:
  assert.equal(c.summary, 'The user asked about air fryers.');
  assert.equal(c.sentiment, 'Neutral');
  assert.ok(c.recordingUrl.startsWith('https://api.ravan.ai/'));
  // Transcript is the STRING, and renderTranscript passes a string through:
  assert.equal(typeof c.transcripts, 'string');
  assert.match(renderTranscript(c.transcripts), /Thank you for calling True Turtle/);
});

test('parseAfterCall still accepts the documented data.* shape (backward compat)', () => {
  const docsShape = {
    data: {
      call_session_id: 'abc-123',
      caller_number: '+919812345678',
      duration_sec: 60,
      summary: 'flat summary',
      post_call_analysis: { sentiment: 'positive' },
      transcripts: [
        { role: 'agent', message: { content: 'Hello' } },
        { role: 'user', message: { content: 'Hi' } },
      ],
    },
  };
  const c = parseAfterCall(docsShape);
  assert.equal(c.phone, '+919812345678');
  assert.equal(c.callId, 'abc-123');
  assert.equal(c.summary, 'flat summary');
  assert.equal(c.sentiment, 'positive');
  assert.match(renderTranscript(c.transcripts), /AGENT: Hello/);
});
