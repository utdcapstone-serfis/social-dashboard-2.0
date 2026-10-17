import { defineConfig, loadEnv, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

/**
 * Dev-only: serves the serverless functions in api/ at /api/<name> so
 * `npm run dev` works without the Vercel CLI. META_*, YOUTUBE_*, TIKTOK_*, X_*,
 * PINTEREST_*, SNAPCHAT_*, LINKEDIN_* and BLUESKY_* values come from .env.local and stay on the server
 * side; Vite only exposes VITE_* variables to the browser.
 */
const LOCAL_API_ROUTES = ["meta", "youtube", "tiktok", "x", "pinterest", "snapchat", "linkedin", "bluesky"] as const;

function localApi(mode: string): Plugin {
  return {
    name: "local-api",
    apply: "serve",
    configureServer(server) {
      Object.assign(process.env, loadEnv(mode, process.cwd(), ["META_", "YOUTUBE_", "TIKTOK_", "X_", "PINTEREST_", "SNAPCHAT_", "LINKEDIN_", "BLUESKY_"]));
      for (const name of LOCAL_API_ROUTES) {
        server.middlewares.use(`/api/${name}`, async (req, res) => {
          try {
            const mod = (await server.ssrLoadModule(`/api/${name}.ts`)) as {
              GET: (request: Request) => Promise<Response>;
            };
            const response = await mod.GET(
              new Request(`http://localhost${req.originalUrl ?? req.url ?? `/api/${name}`}`),
            );
            res.statusCode = response.status;
            response.headers.forEach((value, key) => res.setHeader(key, value));
            res.end(await response.text());
          } catch (err) {
            res.statusCode = 500;
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
          }
        });
      }
    },
  };
}

export default defineConfig(({ mode }) => ({
  // Vercel serves from the domain root; GitHub Pages serves from /social-dashboard/.
  base: process.env.VERCEL ? "/" : "/social-dashboard/",
  plugins: [react(), localApi(mode)],
}));
