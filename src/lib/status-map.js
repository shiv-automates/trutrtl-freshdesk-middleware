// Freshdesk ticket status int → plain words Tara can say, plus a safe generic
// "next step" line so we never have to read internal notes aloud.

const LABELS = {
  2: 'registered and open',
  3: 'in progress',
  4: 'resolved',
  5: 'completed and closed',
};

const NEXT_STEPS = {
  2: 'Our service team will schedule a technician visit, usually within 2 to 3 working days.',
  3: 'The service team is working on it; you should hear about a technician visit shortly.',
  4: 'It has been marked resolved — please let us know if the issue comes back.',
  5: 'This complaint is completed and closed.',
};

export function statusLabel(code) {
  return LABELS[Number(code)] || 'being processed';
}

export function nextStep(code) {
  return NEXT_STEPS[Number(code)] || 'Our team will update you shortly.';
}

export function isClosed(code) {
  return Number(code) === 5;
}

export const STATUS_LABELS = LABELS; // exported for tests
