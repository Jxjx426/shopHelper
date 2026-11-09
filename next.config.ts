import type { NextConfig } from "next";
const config: NextConfig = {
  serverExternalPackages: ["@electric-sql/pglite", "pdfkit"],
  poweredByHeader: false,
  outputFileTracingExcludes: {
    "/*": ["./data/**/*", "./test-results/**/*", "./output/**/*", "./.env*"],
  },
  outputFileTracingIncludes: {
    "/*": ["./assets/pdf-fonts/**/*", "./assets/*ca*.crt"],
  },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "same-origin" },
          { key: "X-Frame-Options", value: "DENY" },
        ],
      },
    ];
  },
};
export default config;
