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
  spanner: {
    instance: required('SPANNER_INSTANCE'),
    database: required('SPANNER_DATABASE'),
    emulatorHost: process.env.SPANNER_EMULATOR_HOST,
  },
  migrationsDir: process.env.MIGRATIONS_DIR ?? '/migrations',
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
    maxLoginRequestsPerHour: 5,
    maxCodeAttempts: 5,
    cookieSecure: appBaseUrl.startsWith('https://'),
  },
  google: {
    enabled: Boolean(googleClientId && googleClientSecret),
    clientId: googleClientId,
    clientSecret: googleClientSecret,
    redirectUri: `${appBaseUrl}/api/auth/google/callback`,
  },
};
