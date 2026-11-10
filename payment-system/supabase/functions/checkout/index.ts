import { db, json, preflight, paystack, ip, verifyAndApply, isPaid } from "../_shared/lib.ts";

const SITE = Deno.env.get("SITE_URL") ?? "";

Deno.serve(async (req) => {
  const pf = preflight(req); if (pf) return pf;
  if (req.method !== "POST") return json(req, { error: "method_not_allowed" }, 405);
  const b = await req.json().catch(() => null);
  if (!b) return json(req, { error: "invalid_request", message: "Invalid request." }, 400);

  const name = String(b.name ?? "").trim().slice(0, 120);
  const email = String(b.email ?? "").trim().toLowerCase().slice(0, 200);
  const idem = String(b.idempotency_key ?? "");
  const items: any[] = Array.isArray(b.items) ? b.items : [];
  const valid = name.length >= 2 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && /^[0-9a-f-]{36}$/i.test(idem) &&
    items.length > 0 && items.length <= 20 &&
    items.every((i) => typeof i?.slug === "string" && /^[a-z0-9-]{1,60}$/.test(i.slug) && Number.isInteger(i.quantity) && i.quantity >= 1 && i.quantity <= 100);
  if (!valid) return json(req, { error: "invalid_request", message: "Please check your details and basket." }, 400);

  const rl = await db.rpc("hit_rate_limit", { p_key: "checkout:" + ip(req), p_max: 10, p_window_seconds: 600 });
  if (rl.data !== true) return json(req, { error: "rate_limited", message: "Too many attempts. Please wait a few minutes." }, 429);

  let customer: string | null = null;
  const tok = (req.headers.get("authorization") ?? "").replace(/^Bearer /i, "");
  if (tok) customer = (await db.auth.getUser(tok)).data?.user?.id ?? null;

  // Prices and totals come from the database. Browser prices are never read.
  const { data, error } = await db.rpc("create_order", {
    p_idem: idem, p_name: name, p_email: email, p_customer: customer,
    p_items: items.map((i) => ({ slug: i.slug, quantity: i.quantity })),
  });
  if (error || !data?.[0]) {
    const bad = (error?.message ?? "").includes("invalid_items");
    console.error("create_order_failed", error?.message);
    return json(req, { error: "order_failed", message: bad ? "One of the items is not available." : "We could not create your order. Please try again." }, bad ? 400 : 500);
  }
  const o = data[0];
  const base = { order_number: o.o_order_number, reference: o.o_reference };

  if (isPaid(o.o_payment_status)) return json(req, { ...base, status: "success" });
  if (o.o_authorization_url) return json(req, { ...base, status: "pending", authorization_url: o.o_authorization_url });
  if (o.o_existing && ["failed", "abandoned", "reversed"].includes(o.o_payment_status))
    return json(req, { error: "attempt_closed", message: "That payment attempt has ended. Press Pay again to start a new one." }, 409);

  // Paystack rejects a reused reference, so a retry here can never create a second charge.
  const r = await paystack("/transaction/initialize", "POST", {
    email, amount: o.o_amount, currency: o.o_currency, reference: o.o_reference, callback_url: SITE,
    metadata: { order_id: o.o_order_id, order_number: o.o_order_number },
  });
  const url = r.data?.data?.authorization_url;
  if (r.ok && url) {
    await db.rpc("mark_initialized", { p_ref: o.o_reference, p_access: r.data.data.access_code, p_url: url });
    return json(req, { ...base, status: "pending", authorization_url: url });
  }
  const wait = { ...base, status: "pending", message: "We could not confirm that the payment page opened. Please wait a moment, then press Pay again. You will not be charged twice." };
  if (r.network || r.http >= 500) return json(req, wait, 202);

  // Paystack refused: reconcile first (the reference may already exist there) before treating it as failed.
  const v = await verifyAndApply(o.o_reference, "customer").catch(() => ({ state: "unverified" }));
  if (v.state === "success" || v.state === "already_processed") return json(req, { ...base, status: "success" });
  if (["processing", "abandoned", "unverified"].includes(v.state)) return json(req, wait, 202);
  await db.rpc("set_payment_status", { p_ref: o.o_reference, p_new: "failed", p_actor: "system", p_note: "initialize_rejected" });
  console.error("paystack_initialize_rejected", r.http);
  return json(req, { ...base, status: "failed", message: "We could not start your payment. Please try again." }, 502);
});
