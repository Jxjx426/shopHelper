# Supabase database CA

`supabase-ca.crt` is the public CA certificate downloaded by the project owner from Supabase Database Settings → SSL Configuration on 2026-11-09. It is not a private key or an API credential and may be included in the application deployment.

The verified database connection uses `SHOP_DB_CA_FILE=assets/supabase-ca.crt`, with certificate and hostname verification enabled. Do not replace this with `rejectUnauthorized=false`.

Both Next.js file tracing and `netlify.toml` include this public certificate. The actual database URL, API keys and JWT secret remain only in ignored local environment files and Netlify's production environment settings; do not commit those files.
