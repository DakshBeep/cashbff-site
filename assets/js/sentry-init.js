// Lazy-configure Sentry once it's loaded (the loader script exposes window.Sentry).
window.sentryOnLoad = function () {
  Sentry.init({
    dsn: "https://2d45e7a7cdc726451c61d775aa22fbf2@o4511234298937344.ingest.us.sentry.io/4511234305949696",
    // Minimal config — no session replay, no tracing, just error capture.
    tracesSampleRate: 0,
  });
};
