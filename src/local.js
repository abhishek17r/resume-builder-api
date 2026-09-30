// Only requests from this computer: for routes that hold keys or start programs.
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1'])
export const localOnly = (req, res, next) => (LOOPBACK.has(req.socket.remoteAddress)
  ? next()
  : res.status(403).json({ error: { code: 'local_only', message: 'This only works from this computer.' } }))
