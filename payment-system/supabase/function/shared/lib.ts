import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

const env = (k: string) => Deno.env.get(k) ?? "";
export const db = createClient(env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"), { auth: { persistSession: false } });

const ORIGINS = env("ALLOWED_ORIGINS").split(",").map((s) => s.trim()).filter(Boolean);
export const cors = (req: Request) => {
  const o = req.headers.get("origin") ?? "";
  return {
    "Access-Control-Allow-Origin": ORIGINS.includes(o) ? o : (ORIGINS[0] ?? ""),
    "Access-Control-Allow-Headers": "authorization, content-type, apikey, x-client-info",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
  };
};
export const json = (req: Request, body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors(req), "Content-Type": "application/json" } });
export const preflight = (req: Request) => req.method === "OPTIONS" ? new Response("ok", { headers: cors(req) }) : null;
export const ip = (req: Request) =>
  req.headers.get("cf-connecting-ip") ?? req.headers.get("x-forwarded-for")?.split(",")[0].trim() ?? "unknown";

// Paystack call with timeout. Never logs headers or the secret key.
export async function paystack(path: string, method = "GET", body?: unknown) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), 15000);
  try {
    const r = await fetch("https://api.paystack.co" + path, {
      method, signal: c.signal,
      headers: { Authorization: "Bearer " + env("PAYSTACK_SECRET_KEY"), "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
    let data: any = null;
    try { data = await r.json(); } catch { /* non-JSON body */ }
    return { ok: r.ok && data?.status === true, http: r.status, data, network: false };
  } catch {
    return { ok: false, http: 0, data: null, network: true };
  } finally { clearTimeout(t); }
}

const FINAL = ["success", "partially_refunded", "refunded"];
export const isPaid = (s: string) => FINAL.includes(s);

// Independently verifies a payment with Paystack, then lets the database decide (finalize_payment).
export async function verifyAndApply(ref: string, actor: string): Promise<{ state: string }> {
  const { data: pay } = await db.from("payments").select("id,order_id,payment_status").eq("transaction_reference", ref).maybeSingle();
  if (!pay) return { state: "unknown_reference" };
  const r = await paystack("/transaction/verify/" + encodeURIComponent(ref));
  if (r.network || r.http >= 500 || r.http === 429) return { state: "unverified" };
  if (!r.ok) return (r.http === 404 || r.http === 400) ? { state: "not_found" } : { state: "unverified" };
  const t = r.data.data;
  if (t.reference !== ref || (t.metadata?.order_id && t.metadata.order_id !== pay.order_id)) {
    await db.rpc("flag_payment", { p_ref: ref, p_reason: "reference_or_order_mismatch", p_actor: actor });
    return { state: "mismatch" };
  }
  const setStatus = async (s: string) => {
    await db.rpc("set_payment_status", { p_ref: ref, p_new: s, p_actor: actor, p_note: "paystack_status_" + t.status });
    return { state: s };
  };
  switch (t.status) {
    case "success": {
      const { data, error } = await db.rpc("finalize_payment", {
        p_ref: ref, p_ps_id: String(t.id), p_amount: t.amount, p_currency: t.currency, p_channel: t.channel ?? null, p_actor: actor,
      });
      if (error) { console.error("finalize_failed", error.message); throw new Error("finalize_failed"); }
      if (data === "success") queueReceiptEmail(ref);
      return { state: data as string };
    }
    case "failed": return await setStatus("failed");
    case "abandoned": return await setStatus("abandoned");
    case "reversed": return await setStatus("reversed");
    default: return await setStatus("processing");
  }
}

const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
const money = (k: number, cur: string) => cur + " " + (k / 100).toLocaleString("en-NG", { minimumFractionDigits: 2 });
export function receiptHtml(d: any): string {
  const rows = (d.items ?? []).map((i: any) => `<tr><td>${esc(i.name)}</td><td>${esc(i.quantity)}</td><td>${money(i.unit_price, d.currency)}</td><td>${money(i.line_total, d.currency)}</td></tr>`).join("");
  const b = d.business ?? {};
  return `<div style="font-family:Arial,sans-serif;max-width:560px"><h2>${esc(b.name)}</h2><p>${esc(b.email)} | ${esc(b.phone)}<br>${esc(b.address)}</p>
<h3>Receipt ${esc(d.receipt_number)}</h3><p>Order: ${esc(d.order_number)}<br>Payment reference: ${esc(d.transaction_reference)}<br>Date: ${esc(d.paid_at)}<br>Customer: ${esc(d.customer_name)} (${esc(d.customer_email)})<br>Method: ${esc(d.payment_channel ?? "n/a")}<br>Status: ${esc(d.status)}</p>
<table border="1" cellpadding="6" cellspacing="0" style="border-collapse:collapse;width:100%"><tr><th>Item</th><th>Qty</th><th>Unit</th><th>Total</th></tr>${rows}</table>
<p>Subtotal: ${money(d.subtotal, d.currency)}<br>Discount: ${money(d.discount, d.currency)}<br><b>Total paid: ${money(d.total, d.currency)}</b></p><p>Verification reference: ${esc(d.verification_ref)}</p></div>`;
}

export async function sendReceiptEmail(id: string): Promise<string> {
  const { data: r } = await db.from("receipts").select("id,receipt_data,email_delivery_status,email_attempts").eq("id", id).maybeSingle();
  if (!r) return "missing";
  if (r.email_delivery_status === "sent") return "sent";
  const key = env("RESEND_API_KEY");
  if (!key) { await db.from("receipts").update({ email_delivery_status: "not_configured" }).eq("id", id); return "not_configured"; }
  let ok = false, err: string | null = null;
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST", headers: { Authorization: "Bearer " + key, "Content-Type": "application/json" },
      body: JSON.stringify({ from: env("RESEND_FROM"), to: [r.receipt_data.customer_email], subject: "Receipt " + r.receipt_data.receipt_number, html: receiptHtml(r.receipt_data) }),
    });
    ok = res.ok; if (!ok) err = "http_" + res.status;
  } catch { err = "network_error"; }
  await db.from("receipts").update({ email_delivery_status: ok ? "sent" : "failed", email_attempts: (r.email_attempts ?? 0) + 1, email_last_error: err }).eq("id", id);
  return ok ? "sent" : "failed";
}
function queueReceiptEmail(ref: string) {
  const p = (async () => {
    const { data: pay } = await db.from("payments").select("id").eq("transaction_reference", ref).maybeSingle();
    if (!pay) return;
    const { data: rc } = await db.from("receipts").select("id").eq("payment_id", pay.id).maybeSingle();
    if (rc) await sendReceiptEmail(rc.id);
  })().catch((e) => console.error("receipt_email_error", (e as Error).message));
  (globalThis as any).EdgeRuntime?.waitUntil?.(p);
}

export async function requireAdmin(req: Request) {
  const t = (req.headers.get("authorization") ?? "").replace(/^Bearer /i, "");
  if (!t) return null;
  const { data } = await db.auth.getUser(t);
  if (!data?.user) return null;
  const { data: a } = await db.from("admin_users").select("user_id").eq("user_id", data.user.id).maybeSingle();
  return a ? data.user : null;
}

// Rechecks unresolved payments directly with Paystack. Never creates a new charge.
export async function runReconcile(actor: "reconciler" | "admin") {
  const min = Number(env("RECONCILE_MIN_AGE_MINUTES") || 10);
  const from = new Date(Date.now() - 14 * 864e5).toISOString();
  const to = new Date(Date.now() - min * 6e4).toISOString();
  const twoDays = new Date(Date.now() - 2 * 864e5).toISOString();
  const { data } = await db.from("payments").select("transaction_reference,created_at,payment_status")
    .or(`payment_status.in.(pending,processing),and(payment_status.eq.abandoned,created_at.gte.${twoDays})`)
    .gte("created_at", from).lte("created_at", to).order("created_at").limit(50);
  const out = { checked: 0, updated: 0, unverified: 0, flagged: 0 };
  for (const p of data ?? []) {
    out.checked++;
    try {
      const r = await verifyAndApply(p.transaction_reference, actor);
      const age = Date.now() - new Date(p.created_at).getTime();
      if (r.state === "unverified") out.unverified++;
      else if (r.state === "not_found" && age > 36e5 && p.payment_status !== "abandoned") {
        await db.rpc("set_payment_status", { p_ref: p.transaction_reference, p_new: "abandoned", p_actor: actor, p_note: "not_found_at_paystack" });
        out.updated++;
      } else if (["success", "failed", "reversed"].includes(r.state)) out.updated++;
      else if (["mismatch", "duplicate"].includes(r.state)) out.flagged++;
      else if (r.state === "processing" && age > 72 * 36e5) {
        await db.rpc("flag_payment", { p_ref: p.transaction_reference, p_reason: "unresolved_over_72h", p_actor: actor });
        out.flagged++;
      }
    } catch (e) { console.error("reconcile_error", p.transaction_reference, (e as Error).message); out.unverified++; }
  }
  await db.from("payment_audit_logs").insert({ action: "reconciliation_run", actor_type: actor, details: out });
  return out;
}
