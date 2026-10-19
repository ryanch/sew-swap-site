import assert from 'node:assert/strict';
import { test } from 'node:test';
import { longDate, makersPublishedEmail, newPairingEmail, packageShippedEmail, reminderEmail, shipReminderEmail } from './templates';

const swap = { title: 'Pincushions <&>', shipBy: '2026-11-05' };

test('longDate keeps the day whatever the timezone', () => {
  assert.equal(longDate('2026-11-05'), 'November 5, 2026');
  assert.equal(longDate('2027-01-01'), 'January 1, 2027');
});

test('confirm emails link to /makes and give the ship date', () => {
  for (const make of [makersPublishedEmail, newPairingEmail, reminderEmail]) {
    const email = make(swap, 'https://sew.example');
    assert.match(email.text, /https:\/\/sew\.example\/makes/);
    assert.match(email.html, /href="https:\/\/sew\.example\/makes"/);
    assert.match(email.text, /ship by November 5, 2026/);
    assert.match(email.subject, /Pincushions <&>/);
    // The title is escaped in HTML.
    assert.doesNotMatch(email.html, /<&>/);
    assert.match(email.html, /Pincushions &lt;&amp;&gt;/);
  }
});

test('the ship reminder gives the ship date and links to /makes', () => {
  const email = shipReminderEmail(swap, 'https://sew.example', '2026-10-01');
  assert.match(email.text, /Please ship by November 5, 2026/);
  assert.match(email.text, /https:\/\/sew\.example\/makes/);
  assert.match(email.html, /href="https:\/\/sew\.example\/makes"/);
  assert.doesNotMatch(email.html, /<&>/);
  // After the date it says it was due.
  assert.match(shipReminderEmail(swap, 'https://sew.example', '2026-11-06').text, /The ship-by date was November 5, 2026/);
});

test('the shipped email has the tracking number and link', () => {
  const s = { swapId: 's1', title: swap.title };
  const email = packageShippedEmail(s, { carrier: 'UPS', trackingNumber: '1Z999', trackingUrl: 'https://www.ups.com/track?tracknum=1Z999' }, 'https://sew.example');
  assert.match(email.text, /UPS tracking number: 1Z999/);
  assert.match(email.text, /https:\/\/www\.ups\.com\/track\?tracknum=1Z999/);
  assert.match(email.html, /Track my package/);
  assert.match(email.text, /https:\/\/sew\.example\/swaps\/s1/);
  // With no link (carrier "Other") there's no button.
  const other = packageShippedEmail(s, { carrier: null, trackingNumber: 'AB123456', trackingUrl: null }, 'https://sew.example');
  assert.match(other.text, /Tracking number: AB123456/);
  assert.doesNotMatch(other.html, /Track my package/);
});
