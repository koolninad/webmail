// Sentry edge-runtime init (middleware / edge routes).
import * as Sentry from "@sentry/nextjs";

Sentry.init({
  dsn: process.env.NEXT_PUBLIC_SENTRY_DSN || "https://03249a42b3a4036a1fe9f3a928468d56@sentry.nubo.email/2",
  environment: process.env.SENTRY_ENV || process.env.NODE_ENV || "production",
  release: process.env.NEXT_PUBLIC_GIT_COMMIT || undefined,
  tracesSampleRate: 0.2,
  sendDefaultPii: false,
  enabled: process.env.NODE_ENV === "production",
});
