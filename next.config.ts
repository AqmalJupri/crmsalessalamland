import type { NextConfig } from "next";

const failClosedFallbackCsp = [
  "default-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
  "object-src 'none'",
].join("; ");

const securityHeaders = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=()" },
  { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
  { key: "Cross-Origin-Resource-Policy", value: "same-origin" },
  // Proxy replaces this with the request nonce policy for matched page and
  // Flight requests. API/static paths outside its matcher retain a
  // non-executable fail-closed policy instead of having no CSP.
  { key: "Content-Security-Policy", value: failClosedFallbackCsp },
];

const nextConfig: NextConfig = {
  poweredByHeader: false,
  reactStrictMode: true,
  turbopack: {
    root: process.cwd(),
  },
  experimental: {
    authInterrupts: true,
    typedEnv: true,
  },
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: securityHeaders,
      },
    ];
  },
  async rewrites() {
    return {
      beforeFiles: [
        {
          source: "/:path*",
          destination: "/api/internal/prefetch-contract",
          has: [{ type: "header", key: "next-router-prefetch", value: "1" }],
          missing: [{ type: "header", key: "rsc", value: "1" }],
        },
      ],
    };
  },
};

export default nextConfig;
