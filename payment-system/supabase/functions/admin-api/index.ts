import { db, json, preflight, requireAdmin, paystack, verifyAndApply, runReconcile, sendReceiptEmail } from "../_shared/lib.ts";

const clean = (s: unknown) => String(s ?? "").replace(/[^A-Za-z0-9@._+-]/g, "").slice(0, 80);

Deno.serve(async (req) => {
  const pf = preflight(req); if (pf) return pf;
  if (req.method !== "POST") return json(req, { error: "method_not_allowed" }, 405);
  const admin = await requireAdmin(req);
  if (!admin) return json(req, { error: "forbidden" }, 403);
  const b = await req.json().catch(() => ({}));
  const audit = (ref: string | null, order: string | null, action: string, details: unknown) =>
    db.from("payment_audit_logs").insert({ transaction_reference: ref, order_id: order, action, actor_type: "admin", actor_id: admin.id, details });

  try {
    switch (b.action) {
      case "list": {
        let q = db.from("payments").select("id,transaction_reference,amount,currency,payment_status,needs_review,review_reason,payment_channel,verified_at,created_at,orders(order_number,customer_name,customer_email,order_status)")
          .order("created_at", { ascending: false }).limit(100);
        if (b.status) q = q.eq("payment_status", clean(b.status));
        if (b.review) q = q.eq("needs_review", true);
        if (b.stale) q = q.in("payment_status", ["pending", "processing"]).lte("created_at", new Date(Date.now() - 36e5).toISOString());
        const s = clean(b.search);
        if (s) {
          const { data: os } = await db.from("orders").select("id").or(`order_number.ilike.%${s}%,customer_email.ilike.%${s}%`).limit(50);
          const ids = (os ?? []).map((o) => o.id);
          q = q.or(`transaction_reference.ilike.%${s}%` + (ids.length ? `,order_id.in.(${ids.join(",")})` : ""));
        }
        const { data, error } = await q;
        if (error) throw error;
        return json(req, { payments: data });
      }
      case "detail": {
        const ref = clean(b.reference);
        const { data: payment } = await db.from("payments").select("*,orders(*,order_items(*))").eq("transaction_reference", ref).maybeSingle();
        if (!payment) return json(req, { error: "not_found" }, 404);
        const [audit_logs, webhooks, receipt, refunds] = await Promise.all([
          db.from("payment_audit_logs").select("*").eq("transaction_reference", ref).order("id", { ascending: false }).limit(100),
          db.from("payment_webhook_events").select("*").eq("transaction_reference", ref).order("received_at", { ascending: false }).limit(50),
          db.from("receipts").select("*").eq("payment_id", payment.id).maybeSingle(),
          db.from("refunds").select("*").eq("payment_id", payment.id).order("created_at", { ascending: false }),
        ]);
        return json(req, { payment, audit_logs: audit_logs.data, webhooks: webhooks.data, receipt: receipt.data, refunds: refunds.data });
      }
      case "webhook_failures": {
        const { data } = await db.from("payment_webhook_events").select("*").in("processing_status", ["failed"]).order("received_at", { ascending: false }).limit(100);
        return json(req, { events: data });
      }
      case "verify": { // independent check with Paystack. There is no "mark as paid" action.
        const ref = clean(b.reference);
        const r = await verifyAndApply(ref, "admin");
        await audit(ref, null, "admin_verify", r);
        return json(req, r);
      }
      case "reconcile_all": return json(req, await runReconcile("admin"));
      case "resend_receipt": {
        const status = await sendReceiptEmail(String(b.receipt_id ?? ""));
        await audit(null, null, "receipt_email_retry", { status });
        return json(req, { status });
      }
      case "refund": {
        const ref = clean(b.reference);
        const { data: pay } = await db.from("payments").select("*").eq("transaction_reference", ref).maybeSingle();
        if (!pay || !["success", "partially_refunded"].includes(pay.payment_status) || !pay.paystack_transaction_id)
          return json(req, { error: "not_refundable", message: "Only verified, paid transactions can be refunded." }, 400);
        const { data: rs } = await db.from("refunds").select("amount").eq("payment_id", pay.id).in("status", ["pending", "processing", "success"]);
        const left = pay.amount - (rs ?? []).reduce((s, r) => s + r.amount, 0);
        const amount = b.amount ? Math.round(Number(b.amount)) : left;
        if (!Number.isInteger(amount) || amount <= 0 || amount > left) return json(req, { error: "bad_amount", message: "Amount must be above 0 and within the unrefunded balance (kobo)." }, 400);
        const reason = String(b.reason ?? "").slice(0, 200);
        const { data: rf, error } = await db.from("refunds").insert({ payment_id: pay.id, order_id: pay.order_id, refund_reference: "RF-" + crypto.randomUUID(), amount, reason, created_by: admin.id }).select("id").single();
        if (error) throw error;
        await audit(ref, pay.order_id, "refund_requested", { amount, reason });
        const r = await paystack("/refund", "POST", { transaction: pay.paystack_transaction_id, amount, merchant_note: reason || undefined });
        if (r.ok) {
          await db.rpc("record_refund_status", { p_refund: rf.id, p_status: "processing", p_ps_id: r.data?.data?.id ? String(r.data.data.id) : null });
          return json(req, { status: "processing" }); // final success arrives by webhook
        }
        if (r.network || r.http >= 500) return json(req, { status: "pending", message: "Paystack did not answer. Check the refund before retrying." }, 202);
        await db.rpc("record_refund_status", { p_refund: rf.id, p_status: "failed", p_ps_id: null });
        return json(req, { status: "failed", message: r.data?.message ?? "Refund rejected by Paystack." }, 400);
      }
      default: return json(req, { error: "unknown_action" }, 400);
    }
  } catch (e) {
    console.error("admin_api_error", (e as Error).message);
    return json(req, { error: "server_error" }, 500);
  }
});
