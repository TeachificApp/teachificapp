import "dotenv/config";
import express from "express";
import { createServer } from "http";
import net from "net";
import helmet from "helmet";
import { createExpressMiddleware } from "@trpc/server/adapters/express";
import { registerOAuthRoutes } from "./oauth";
import { appRouter } from "../routers";
import { createContext } from "./context";
import { serveStatic } from "./staticServer";
// vite.ts is only imported dynamically in development to avoid bundling dev dependencies in production
import quizImportRouter from "../quizImportRoutes";
import scormUploadRouter from "../scormUploadRoutes";
import chunkedUploadRouter from "../chunkedUploadRoutes";
import contentRouter from "../contentRoutes";
import digitalDownloadRouter from "../digitalDownloadRoutes";
import mediaUploadRouter from "../mediaUploadRoutes";
import stripeWebhookRouter from "../stripeWebhookRoutes";

function isPortAvailable(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const server = net.createServer();
    server.listen(port, () => {
      server.close(() => resolve(true));
    });
    server.on("error", () => resolve(false));
  });
}

async function findAvailablePort(startPort: number = 3000): Promise<number> {
  for (let port = startPort; port < startPort + 20; port++) {
    if (await isPortAvailable(port)) {
      return port;
    }
  }
  throw new Error(`No available port found starting from ${startPort}`);
}

async function startServer() {
  const app = express();
  const server = createServer(app);

  // Increase timeout to 30 minutes for large file uploads (up to 3 GB)
  server.timeout = 30 * 60 * 1000;
  server.keepAliveTimeout = 30 * 60 * 1000;
  server.headersTimeout = 30 * 60 * 1000 + 5000;

  // ── Security headers (Helmet) ─────────────────────────────────────────────
  // Applied globally BEFORE all other middleware so every response gets headers.
  // Embed routes (/embed/*, /api/content/*) override X-Frame-Options below.
  app.use(helmet({
    // HSTS: instruct browsers to always use HTTPS for 1 year, include subdomains
    // Required for HSTS preload submission and enterprise firewall trust
    hsts: {
      maxAge: 31536000,        // 1 year in seconds
      includeSubDomains: true,
      preload: true,
    },
    // Content Security Policy — strict but compatible with SCORM packages
    contentSecurityPolicy: {
      directives: {
        defaultSrc:   ["'self'"],
        scriptSrc:    [
          "'self'",
          "'unsafe-inline'",  // Required for SCORM API injection into iframes
          "'unsafe-eval'",    // Required for some SCORM runtime packages
          "https://cdn.jsdelivr.net",
          "https://fonts.googleapis.com",
          "https://www.googletagmanager.com",
          "https://js.stripe.com",
        ],
        styleSrc:     ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com", "https://cdn.jsdelivr.net"],
        fontSrc:      ["'self'", "https://fonts.gstatic.com", "https://cdn.jsdelivr.net", "data:"],
        imgSrc:       ["'self'", "data:", "blob:", "https:"],
        mediaSrc:     ["'self'", "blob:", "https:"],
        connectSrc:   ["'self'", "https://api.manus.im", "https://api.stripe.com", "wss:", "https:"],
        frameSrc:     ["'self'", "https://js.stripe.com", "https:"],
        // Allow embedding from any HTTPS origin (required for LMS integration)
        frameAncestors: ["'self'", "https:"],
        objectSrc:    ["'none'"],
        baseUri:      ["'self'"],
        formAction:   ["'self'"],
        upgradeInsecureRequests: [],
      },
    },
    // Prevent MIME-type sniffing attacks
    noSniff: true,
    // Prevent IE from executing downloads in the site's security context
    ieNoOpen: true,
    // Referrer policy — send origin only on cross-origin requests
    referrerPolicy: { policy: "strict-origin-when-cross-origin" },
    // Remove X-Powered-By: Express
    hidePoweredBy: true,
    // Default frameguard: sameorigin — overridden for embed routes below
    frameguard: { action: "sameorigin" },
    // XSS filter for older browsers
    xssFilter: true,
    // Disable DNS prefetching (reduces information leakage)
    dnsPrefetchControl: { allow: false },
    // Cross-origin opener policy — allow popups for OAuth flows
    crossOriginOpenerPolicy: { policy: "same-origin-allow-popups" },
    // Cross-origin resource policy — allow cross-origin reads (CDN assets)
    crossOriginResourcePolicy: { policy: "cross-origin" },
    // Disable COEP so SCORM iframes can load external resources without CORP headers
    crossOriginEmbedderPolicy: false,
    // Permissions policy — disable unused browser features
    permittedCrossDomainPolicies: false,
  }));

  // Permissions-Policy header (not yet in helmet 8 stable, set manually)
  app.use((_req, res, next) => {
    res.setHeader(
      "Permissions-Policy",
      "camera=(), microphone=(), geolocation=(), payment=(self), usb=(), magnetometer=(), accelerometer=(), gyroscope=()"
    );
    next();
  });

  // ── Embed route overrides ─────────────────────────────────────────────────
  // /embed/* and /api/content/* must be frameable by any external LMS/site.
  // Override helmet's frameguard and add CORS headers for these routes only.
  app.use((req, res, next) => {
    const path = req.path;
    if (path.startsWith("/embed/") || path.startsWith("/api/content/")) {
      // Allow framing from any origin (required for LMS embedding)
      res.removeHeader("X-Frame-Options");
      res.setHeader("Content-Security-Policy",
        "frame-ancestors *; default-src 'self' 'unsafe-inline' 'unsafe-eval' https: data: blob:; img-src * data: blob:; media-src * blob:; connect-src *;"
      );
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type, Range");
    }
    next();
  });

  // Health check endpoint for Railway / load balancers (no auth required)
  app.get("/api/health", (_req, res) => {
    res.json({ status: "ok", timestamp: new Date().toISOString() });
  });

  // Stripe webhook MUST be before express.json() for raw body signature verification
  app.use("/api/stripe", stripeWebhookRouter);

  // Configure body parser with larger size limit for file uploads
  app.use(express.json({ limit: "3gb" }));
  app.use(express.urlencoded({ limit: "3gb", extended: true }));

  // OAuth callback under /api/oauth/callback
  registerOAuthRoutes(app);

  // Quiz Excel import/export
  app.use("/api/quiz", quizImportRouter);

  // SCORM/HTML ZIP upload
  app.use("/api/upload", scormUploadRouter);

  // Chunked upload for large files — bypasses proxy body size limit
  app.use("/api/chunked", chunkedUploadRouter);

  // Content file proxy — serves extracted package files by redirecting to S3 CDN URLs
  // MUST be before tRPC and Vite so /api/content/* doesn't fall through to the SPA
  app.use("/api/content", contentRouter);

  // Secure digital download — validates token, checks access controls, redirects to S3
  app.use("/api/download", digitalDownloadRouter);

  // Media upload — server-side proxy for browser file uploads (digital downloads, forms, media library)
  app.use("/api/media-upload", mediaUploadRouter);

  // tRPC API
  app.use(
    "/api/trpc",
    createExpressMiddleware({
      router: appRouter,
      createContext,
    })
  );

  // development mode uses Vite, production mode uses static files
  if (process.env.NODE_ENV === "development") {
    const { setupVite } = await import("./vite");
    await setupVite(app, server);
  } else {
    serveStatic(app);
  }

  const preferredPort = parseInt(process.env.PORT || "3000");
  const port = process.env.PORT
    ? preferredPort
    : await findAvailablePort(preferredPort);

  if (port !== preferredPort) {
    console.log(`Port ${preferredPort} is busy, using port ${port} instead`);
  }

  server.listen(port, () => {
    console.log(`Server running on http://localhost:${port}/`);
  });

  // Initialize Stripe products/prices (idempotent, non-blocking)
  setTimeout(async () => {
    try {
      const { ensureStripePlans } = await import("../stripePlans");
      await ensureStripePlans();
    } catch (e: any) {
      console.warn("[Stripe] Plan initialization skipped:", e.message);
    }
  }, 2000);

  // Seed desktop app download URLs (idempotent, non-blocking)
  setTimeout(async () => {
    try {
      const { ensureAppVersions } = await import("../appVersionsSeed");
      await ensureAppVersions();
    } catch (e: any) {
      console.warn("[AppVersions] Seed skipped:", e.message);
    }
  }, 3000);
}

startServer().catch(console.error);
