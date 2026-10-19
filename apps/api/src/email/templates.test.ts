import assert from 'node:assert/strict';
import { test } from 'node:test';
import { longDate, makersPublishedEmail, newPairingEmail, reminderEmail } from './templates';

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
