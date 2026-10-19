import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CARRIER_IDS, normalizeTracking, toShipment, trackingUrl } from './tracking';

test('normalizeTracking strips spaces and dashes and uppercases', () => {
  assert.equal(normalizeTracking(' 1z 999-aa1 0123 4567 84 '), '1Z999AA10123456784');
  assert.equal(normalizeTracking('9400 1000 0000 0000 0000 00'), '9400100000000000000000');
});

test('normalizeTracking rejects things that are not tracking numbers', () => {
  for (const bad of ['', '12345', 'abc/123456', 'https://ups.com/1Z999', '1Z99<script>', 'x'.repeat(41)]) {
    assert.equal(normalizeTracking(bad), null, bad);
  }
});

test('every carrier but other has a tracking link with the number in it', () => {
  for (const carrier of CARRIER_IDS) {
    const url = trackingUrl(carrier, '1Z999AA10123456784');
    if (carrier === 'other') assert.equal(url, null);
    else {
      assert.match(url!, /^https:\/\//);
      assert.ok(url!.endsWith('1Z999AA10123456784'), url!);
    }
  }
  assert.equal(trackingUrl('ups', '1Z999AA10123456784'), 'https://www.ups.com/track?tracknum=1Z999AA10123456784');
  assert.equal(trackingUrl('nonsense', '123456'), null);
});

test('toShipment is null until shipped', () => {
  assert.equal(toShipment({ ShippedAt: null, Carrier: null, TrackingNumber: null }), null);
  assert.deepEqual(toShipment({ ShippedAt: '2026-10-18T00:00:00Z', Carrier: 'other', TrackingNumber: 'ABC123' }), {
    shippedAt: '2026-10-18T00:00:00Z',
    carrier: 'other',
    trackingNumber: 'ABC123',
    trackingUrl: null,
  });
});
