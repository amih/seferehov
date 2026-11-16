import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inviteCode, inviteState, validCode, inviteLink } from '../src/invites.js';

test('invites: codes are random, URL-safe and accepted by the checker', () => {
  const codes = new Set(Array.from({ length: 200 }, inviteCode));
  assert.equal(codes.size, 200);
  for (const c of codes) {
    assert.match(c, /^[A-Za-z0-9_-]{12}$/);
    assert.ok(validCode(c));
  }
  assert.ok(!validCode('short'));
  assert.ok(!validCode('../../etc/passwd'));
  assert.ok(!validCode(null));
  assert.match(inviteLink('abcDEF123_-x'), /\/\?i=abcDEF123_-x$/);
});

test('invites: a handover is open until accepted, declined or expired', () => {
  const now = new Date('2026-11-16T12:00:00Z');
  assert.equal(inviteState({ expires_at: '2027-01-15T00:00:00Z' }, now), 'open');
  assert.equal(inviteState({ expires_at: null }, now), 'open'); // a plain invite never expires
  assert.equal(inviteState({ expires_at: '2026-11-01T00:00:00Z' }, now), 'expired');
  assert.equal(inviteState({ accepted_at: '2026-11-10T00:00:00Z', expires_at: '2026-11-01T00:00:00Z' }, now), 'accepted');
  assert.equal(inviteState({ declined_at: '2026-11-10T00:00:00Z' }, now), 'declined');
});
