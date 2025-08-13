// gateway-routes.js
// Fixes incorrect '/arcana/config/shortcuts' mapping by routing to '/dispatch/shortcuts'
// Adds fallback redirect for any path containing 'shortcuts'

module.exports = function (app) {
  // Direct mapping for the known incorrect route
  app.use('/arcana/config/shortcuts', (req, res, next) => {
    console.log(`[Gateway] Redirecting ${req.originalUrl} → /dispatch/shortcuts`);
    req.url = '/dispatch/shortcuts';
    next();
  });

  // Fallback for any future variations containing "shortcuts"
  app.use((req, res, next) => {
    if (req.originalUrl.toLowerCase().includes('shortcuts')) {
      console.log(`[Gateway] Fallback triggered for ${req.originalUrl} → /dispatch/shortcuts`);
      req.url = '/dispatch/shortcuts';
    }
    next();
  });
};

