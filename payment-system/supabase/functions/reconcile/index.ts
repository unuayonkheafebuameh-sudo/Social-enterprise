import { db, json, preflight, requireAdmin, runReconcile } from "../_shared/lib.ts";

Deno.serve(async (req) => {
  const pf = preflight(req); if (pf) return pf;
  if (req.method !== "POST") return json(req, { error: "method_not_allowed" }, 405);
  const secret = Deno.env.get("CRON_SECRET") ?? "";
  const cron = secret.length >= 16 && req.headers.get("x-cron-secret") === secret;
  const admin = cron ? null : await requireAdmin(req);
  if (!cron && !admin) return json(req, { error: "forbidden" }, 403);
  const out = await runReconcile(cron ? "reconciler" : "admin");
  return json(req, out);
});
