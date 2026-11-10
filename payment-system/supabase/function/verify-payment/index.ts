import { db, json, preflight, ip, verifyAndApply, isPaid } from "../_shared/lib.ts";

Deno.serve(async (req) => {
  const pf = preflight(req); if (pf) return pf;
  if (req.method !== "POST") return json(req, { error: "method_not_allowed" }, 405);
  const b = await req.json().catch(() => null);
  if (!b) return json(req, { error: "invalid_request" }, 400);
  const rl = await db.rpc("hit_rate_limit", { p_key: "verify:" + ip(req), p_max: 40, p_window_seconds: 300 });
  if (rl.data !== true) return json(req, { error: "rate_limited" }, 429);

  let ref = "";
  if (typeof b.reference === "string" && /^PAY-[0-9a-f]{32}$/.test(b.reference)) ref = b.reference;
  else if (typeof b.order_number === "string" && typeof b.email === "string") {
    const { data: o } = await db.from("orders").select("id").eq("order_number", b.order_number.trim().toUpperCase()).eq("customer_email", b.email.trim().toLowerCase()).maybeSingle();
    if (!o) return json(req, { error: "not_found", message: "No order matches those details." }, 404);
    const { data: p } = await db.from("payments").select("transaction_reference").eq("order_id", o.id).order("created_at", { ascending: false }).limit(1).maybeSingle();
    ref = p?.transaction_reference ?? "";
  }
  if (!ref) return json(req, { error: "invalid_request" }, 400);

  const load = async () => (await db.from("payments").select("id,payment_status,needs_review,amount,currency,orders(order_number)").eq("transaction_reference", ref).maybeSingle()).data as any;
  let p = await load();
  if (!p) return json(req, { error: "not_found", message: "No payment found." }, 404);

  let verified = true;
  if (!isPaid(p.payment_status)) {
    try { verified = (await verifyAndApply(ref, "customer")).state !== "unverified"; } catch { verified = false; }
    p = await load();
  }
  let receipt = null;
  if (isPaid(p.payment_status)) {
    receipt = (await db.from("receipts").select("receipt_data").eq("payment_id", p.id).maybeSingle()).data?.receipt_data ?? null;
  }
  return json(req, {
    reference: ref, order_number: p.orders?.order_number, amount: p.amount, currency: p.currency, verified, receipt,
    payment_status: p.needs_review ? "review" : p.payment_status,
  });
});
