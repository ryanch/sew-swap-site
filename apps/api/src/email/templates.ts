import type { Email } from './mailer';

// Notification emails. Kept short with one big button, like the sign-in email: many swappers
// aren't comfortable with technology.

const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/** 'YYYY-MM-DD' to 'March 5, 2026'. */
export function longDate(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    timeZone: 'UTC',
  });
}

type SwapInfo = { title: string; shipBy: string };

function confirmEmail(subject: string, lead: string, swap: SwapInfo, appBaseUrl: string): Email {
  const link = `${appBaseUrl}/makes`;
  const ship = longDate(swap.shipBy);
  const text = [
    'Hello!',
    '',
    lead,
    '',
    'Please sign in to Sew Swap to see who you are making for and confirm you can still make for them:',
    link,
    '',
    `Please ship by ${ship}.`,
  ].join('\n');
  const html = `
    <div style="font-family: Arial, sans-serif; font-size: 18px; line-height: 1.5; max-width: 520px">
      <p>Hello!</p>
      <p>${escapeHtml(lead)}</p>
      <p>Please sign in to see who you are making for and confirm you can still make for them:</p>
      <p><a href="${link}" style="display:inline-block;background:#1a7f37;color:#fff;padding:14px 28px;border-radius:8px;text-decoration:none;font-size:20px">See who I'm making for</a></p>
      <p>Please ship by <strong>${ship}</strong>.</p>
    </div>`;
  return { subject, text, html };
}

export const makersPublishedEmail = (swap: SwapInfo, appBaseUrl: string) =>
  confirmEmail(
    `${swap.title}: see who you're making for`,
    `Makers for ${swap.title} have been announced!`,
    swap,
    appBaseUrl,
  );

export const newPairingEmail = (swap: SwapInfo, appBaseUrl: string) =>
  confirmEmail(
    `${swap.title}: you have someone new to make for`,
    `The organizer of ${swap.title} has given you someone new to make for.`,
    swap,
    appBaseUrl,
  );

export const reminderEmail = (swap: SwapInfo, appBaseUrl: string) =>
  confirmEmail(
    `Reminder: please confirm who you're making for in ${swap.title}`,
    `This is a reminder from the organizer of ${swap.title}: you haven't confirmed who you're making for yet.`,
    swap,
    appBaseUrl,
  );

/** Asks a maker to ship, and to add the tracking number once they have. */
export function shipReminderEmail(swap: SwapInfo, appBaseUrl: string, today = new Date().toISOString().slice(0, 10)): Email {
  const link = `${appBaseUrl}/makes`;
  const ship = longDate(swap.shipBy);
  const when = swap.shipBy < today ? `The ship-by date was ${ship}.` : `Please ship by ${ship}.`;
  const subject = `Reminder: please ship your package for ${swap.title}`;
  const lead = `This is a reminder from the organizer of ${swap.title}. ${when}`;
  const text = [
    'Hello!',
    '',
    lead,
    '',
    "Once you've sent your package, please sign in to Sew Swap and add the tracking number:",
    link,
    '',
    "If you haven't confirmed who you're making for yet, you can do that there too.",
  ].join('\n');
  const html = `
    <div style="font-family: Arial, sans-serif; font-size: 18px; line-height: 1.5; max-width: 520px">
      <p>Hello!</p>
      <p>${escapeHtml(lead)}</p>
      <p>Once you've sent your package, please sign in and add the tracking number:</p>
      <p><a href="${link}" style="display:inline-block;background:#1a7f37;color:#fff;padding:14px 28px;border-radius:8px;text-decoration:none;font-size:20px">Add my tracking number</a></p>
      <p>If you haven't confirmed who you're making for yet, you can do that there too.</p>
    </div>`;
  return { subject, text, html };
}

/** Tells the recipient their package is on its way. It never names the maker. */
export function packageShippedEmail(
  swap: { swapId: string; title: string },
  /** `carrier` is the carrier's name, or null when the maker picked "Other". */
  shipment: { carrier: string | null; trackingNumber: string; trackingUrl: string | null },
  appBaseUrl: string,
): Email {
  const swapLink = `${appBaseUrl}/swaps/${swap.swapId}`;
  const subject = `${swap.title}: your package is on its way!`;
  const tracking = `${shipment.carrier ? `${shipment.carrier} tracking number` : 'Tracking number'}: ${shipment.trackingNumber}`;
  const text = [
    'Hello!',
    '',
    `Good news: your package from ${swap.title} has been shipped.`,
    '',
    tracking,
    ...(shipment.trackingUrl ? ['Track your package here:', shipment.trackingUrl] : []),
    '',
    'You can see this again on the swap page:',
    swapLink,
  ].join('\n');
  const html = `
    <div style="font-family: Arial, sans-serif; font-size: 18px; line-height: 1.5; max-width: 520px">
      <p>Hello!</p>
      <p>Good news: your package from ${escapeHtml(swap.title)} has been shipped.</p>
      <p><strong>${escapeHtml(tracking)}</strong></p>
      ${
        shipment.trackingUrl
          ? `<p><a href="${escapeHtml(shipment.trackingUrl)}" style="display:inline-block;background:#1a7f37;color:#fff;padding:14px 28px;border-radius:8px;text-decoration:none;font-size:20px">Track my package</a></p>`
          : ''
      }
      <p>You can see this again on <a href="${swapLink}">the swap page</a>.</p>
    </div>`;
  return { subject, text, html };
}
