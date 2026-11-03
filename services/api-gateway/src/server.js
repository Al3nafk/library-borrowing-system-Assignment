const express      = require('express');
const cors         = require('cors');
const { createProxyMiddleware } = require('http-proxy-middleware');

const app = express();
app.use(cors());
// Do NOT add express.json() here. It would consume the request body and
// the proxied POST/PUT/PATCH requests would hang. The gateway only forwards bytes.

// Service URLs (Docker Compose DNS names)
const SERVICES = {
  member: process.env.MEMBER_SERVICE_URL || 'http://member-service:3001',
  book:   process.env.BOOK_SERVICE_URL   || 'http://book-service:3002',
  loan:   process.env.LOAN_SERVICE_URL   || 'http://loan-service:3003',
};

// Health check for the gateway itself
app.get('/health', (req, res) =>
  res.json({ status: 'ok', service: 'api-gateway', port: 8000, version: '2.0', routes: SERVICES })
);

// Proxy factory helper
function proxy(target) {
  return createProxyMiddleware({
    target,
    changeOrigin: true,
    // app.use('/api/books', ...) strips '/api/books' from req.url, but our services
    // define full paths (/api/books/...). Put the original URL back.
    pathRewrite: (path, req) => req.originalUrl,
    on: {
      error: (err, req, res) => {
        res.status(503).json({
          error: 'Upstream service unavailable',
          target,
          detail: err.message
        });
      }
    }
  });
}

// ROUTE TABLE

// Member Service
app.use('/api/auth',    proxy(SERVICES.member));
app.use('/api/members', proxy(SERVICES.member));  // Week 8: add authenticateToken

// Book Service (public, browsing the catalogue doesn't need login)
app.use('/api/books',   proxy(SERVICES.book));

// Loan Service
app.use('/api/basket',  proxy(SERVICES.loan));    // Week 8: add authenticateToken
app.use('/api/loans',   proxy(SERVICES.loan));    // Week 8: add authenticateToken

// 404 for unknown routes
app.use((req, res) =>
  res.status(404).json({
    error:           'Route not found in gateway',
    requestedPath:   req.path,
    availableRoutes: ['/api/auth', '/api/members', '/api/books', '/api/basket', '/api/loans']
  })
);

const PORT = process.env.PORT || 8000;
app.listen(PORT, () => {
  console.log(`[api-gateway] Listening on :${PORT}`);
  console.log(`  /api/auth, /api/members -> ${SERVICES.member}`);
  console.log(`  /api/books              -> ${SERVICES.book}`);
  console.log(`  /api/basket, /api/loans -> ${SERVICES.loan}`);
});
