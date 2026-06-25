// Sentry browser init. Loaded by Next.js on the client via instrumentation.
import * as Sentry from "@sentry/nextjs";

Sentry.init({
  dsn: process.env.NEXT_PUBLIC_SENTRY_DSN || "https://03249a42b3a4036a1fe9f3a928468d56@sentry.nubo.email/2",
  environment: process.env.SENTRY_ENV || process.env.NODE_ENV || "production",
  release: process.env.NEXT_PUBLIC_GIT_COMMIT || undefined,
  tracesSampleRate: 0.2,
  replaysSessionSampleRate: 0,
  replaysOnErrorSampleRate: 0.1,
  sendDefaultPii: false,
  enabled: process.env.NODE_ENV === "production",
});

// Capture App Router client navigations as transactions.
export const onRouterTransitionStart = Sentry.captureRouterTransitionStart;
