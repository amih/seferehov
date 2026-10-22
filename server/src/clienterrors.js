// Errors in the app on readers' phones, written to the server log (journalctl), since
// there is no other way to see them. Rate-limited, and only the message, the place in
// the code, the screen and the app version are kept.
export default async function clientErrorRoutes(app) {
  app.post('/api/client-error', { config: { rateLimit: { max: 20, timeWindow: '1 hour' } } }, async (req) => {
    const b = req.body ?? {};
    const cut = (v, n) => String(v ?? '').slice(0, n);
    req.log.warn({ client: { message: cut(b.message, 300), where: cut(b.where, 200), stack: cut(b.stack, 1500), path: cut(b.path, 200),
      version: cut(b.version, 40), ua: cut(req.headers['user-agent'], 200), user: req.user?.id ?? null } }, 'client error');
    return { ok: true };
  });
}
