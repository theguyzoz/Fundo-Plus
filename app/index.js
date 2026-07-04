// app/index.js — Mount this in bot.js with:
//   import { mountAppRoutes } from './app/index.js';
//   mountAppRoutes(app);
// Call mountAppRoutes(app) right after:  app.use('/', websiteRouter);

import appAuthRouter from './auth.js';
import appMainRouter from './main.js';
import appAIRouter   from './ai.js';
import { getSessionUser } from '../website/auth.js';
import { getAppSessionUser } from './auth.js';

// Middleware that accepts EITHER a web session OR an app token
export function requireAuthOrApp(req, res, next) {
  const token = req.headers['x-session-token'] || req.query?.token;
  // Try web session first
  let user = getSessionUser(token);
  if (!user) user = getAppSessionUser(token);
  if (!user) return res.status(401).json({ error: 'Not authenticated' });
  req.user = user;
  next();
}

export function mountAppRoutes(app) {
  // Inject web-session resolver so app/auth confirm endpoint can verify the browser login
  app.use('/api/app', (req, _res, next) => {
    req._webAuth = { getSessionUser };
    next();
  });

  app.use('/api/app/auth', appAuthRouter);   // login, pending, poll, confirm, me, logout
  app.use('/api/app',      appMainRouter);   // /me, /papers, /papers/:id/download
  app.use('/api/app',      appAIRouter);     // /chat, /chat/clear
}
