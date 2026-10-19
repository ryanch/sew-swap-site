// Tracking numbers and links to the carriers' tracking pages. The maker picks the carrier (the
// web page guesses one from the number's format), so a link is only as right as that choice.

export const CARRIERS = {
  usps: 'USPS',
  ups: 'UPS',
  fedex: 'FedEx',
  dhl: 'DHL',
  canadapost: 'Canada Post',
  purolator: 'Purolator',
  canpar: 'Canpar Express',
  other: 'Other',
} as const;

export type Carrier = keyof typeof CARRIERS;

export const CARRIER_IDS = Object.keys(CARRIERS) as Carrier[];

const TRACKING_PAGES: Record<Exclude<Carrier, 'other'>, string> = {
  usps: 'https://tools.usps.com/go/TrackConfirmAction?tLabels=',
  ups: 'https://www.ups.com/track?tracknum=',
  fedex: 'https://www.fedex.com/wtrk/track/?trknbr=',
  dhl: 'https://www.dhl.com/global-en/home/tracking.html?tracking-id=',
  canadapost: 'https://www.canadapost-postescanada.ca/track-reperage/en#/search?searchFor=',
  purolator: 'https://www.purolator.com/en/shipping/tracker?pin=',
  canpar: 'https://www.canpar.com/en/tracking/delivery_options.htm?barcode=',
};

/** '1z 999-aa1 0123' to '1Z999AA10123', or null if it can't be a tracking number. */
export function normalizeTracking(input: string): string | null {
  const s = input.toUpperCase().replace(/[\s-]+/g, '');
  return /^[A-Z0-9]{6,40}$/.test(s) ? s : null;
}

/** The carrier's tracking page for this number, or null for 'other'. */
export function trackingUrl(carrier: string, trackingNumber: string): string | null {
  const page = TRACKING_PAGES[carrier as keyof typeof TRACKING_PAGES];
  return page ? page + encodeURIComponent(trackingNumber) : null;
}

export const carrierLabel = (carrier: string) => CARRIERS[carrier as Carrier] ?? carrier;

export type Shipment = { shippedAt: string; carrier: string; trackingNumber: string; trackingUrl: string | null };

/** The API's view of a shipped pairing, from its Assignments columns. */
export function toShipment(r: { ShippedAt: string | null; Carrier: string | null; TrackingNumber: string | null }): Shipment | null {
  if (!r.ShippedAt || !r.Carrier || !r.TrackingNumber) return null;
  return { shippedAt: r.ShippedAt, carrier: r.Carrier, trackingNumber: r.TrackingNumber, trackingUrl: trackingUrl(r.Carrier, r.TrackingNumber) };
}
