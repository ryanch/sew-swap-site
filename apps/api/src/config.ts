function required(name: string, fallback?: string): string {
  const value = process.env[name] || fallback;
  if (!value) throw new Error(`Missing required env var ${name}`);
  return value;
}

const appBaseUrl = required('APP_BASE_URL', 'http://localhost:5173').replace(/\/$/, '');
const googleClientId = process.env.GOOGLE_CLIENT_ID || undefined;
const googleClientSecret = process.env.GOOGLE_CLIENT_SECRET || undefined;

export const config = {
  port: Number(process.env.PORT ?? 8080),
  projectId: required('GOOGLE_CLOUD_PROJECT'),
  appBaseUrl,
  smtp: {
    host: required('SMTP_HOST'),
    port: Number(process.env.SMTP_PORT ?? 587),
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
    from: required('MAIL_FROM'),
  },
  auth: {
    secret: required('AUTH_SECRET'),
    sessionTtlDays: Number(process.env.SESSION_TTL_DAYS ?? 30),
    loginTokenTtlMinutes: 15,
    maxLoginRequestsPerHour: Number(process.env.LOGIN_REQUESTS_PER_HOUR ?? 5),
    // Always admins; lowercased like Users.Email.
    adminEmails: (process.env.ADMIN_EMAILS ?? '')
      .split(',')
      .map((e) => e.trim().toLowerCase())
      .filter(Boolean),
    maxCodeAttempts: 5,
    cookieSecure: appBaseUrl.startsWith('https://'),
  },
  instagram: {
    // Tried in order; see src/instagram/strategies.ts. `fake` is for local development only.
    strategies: (process.env.INSTAGRAM_CHECK_STRATEGIES ?? 'webProfileInfo,crawlerPage')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    minSecondsBetweenChecks: Number(process.env.INSTAGRAM_CHECK_MIN_SECONDS ?? 10),
    maxChecksPerHour: 15,
    // A passing check counts for joining swaps for this long.
    checkValidDays: 30,
  },
  google: {
    enabled: Boolean(googleClientId && googleClientSecret),
    clientId: googleClientId,
    clientSecret: googleClientSecret,
    redirectUri: `${appBaseUrl}/api/auth/google/callback`,
  },
};
