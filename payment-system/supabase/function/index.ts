import { db, ip, verifyAndApply } from "../_shared/lib.ts";

const enc = new TextEncoder();
const reply = (s: string, status: number) => new Response(s, { status });

function safeEqual(a: string, b: string) {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return reply("method_not_allowed", 405);
  const raw = await req.text(); // raw body first: the signature covers the exact bytes
  const sig = (req.headers.get("x-paystack-signature") ?? "").toLowerCase();
  const key = await crypto.subtle.importKey("raw", enc.encode(Deno.env.get("PAYSTACK_SECRET_KEY") ?? ""), { name: "HMAC", hash: "SHA-512" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(raw)));
  const hex = [...mac].map((b) => b.toString(16).padStart(2, "0")).join("");

  if (!safeEqual(hex, sig)) {
    const ok = await db.rpc("hit_rate_limit", { p_key: "badsig:" + ip(req), p_max: 20, p_window_seconds: 600 });
    if (ok.data === true) await db.from("payment_webhook_events").insert({ dedupe_key: "invalid:" + crypto.randomUUID(), event_type: "invalid_signature", signature_verified: false, processing_status: "ignored" });
    console.error("webhook_invalid_signature");
    return reply("invalid_signature", 401);
  }

  let ev: any;
  try { ev = JSON.parse(raw); } catch { return reply("bad_json", 400); }
  const d = ev.data ?? {};
  const ref: string | null = d.reference ?? d.transaction_reference ?? null;
  const dedupe = `${ev.event}:${d.id ?? ref ?? crypto.randomUUID()}`;

  let evId: string | undefined;
  const ins = await db.from("payment_webhook_events").insert({ dedupe_key: dedupe, event_type: String(ev.event).slice(0, 80), transaction_reference: ref, signature_verified: true }).select("id").single();
  if (ins.error) {
    if (ins.error.code !== "23505") { console.error("webhook_store_failed", ins.error.message); return reply("store_failed", 500); }
    const ex = await db.from("payment_webhook_events").select("id,processing_status").eq("dedupe_key", dedupe).single();
    if (ex.data?.processing_status !== "failed") return reply("duplicate_ok", 200); // already handled: acknowledge, do nothing
    evId = ex.data.id; // earlier attempt failed: process again
  } else evId = ins.data.id;

  const finish = (status: string, error?: string) =>
    db.from("payment_webhook_events").update({ processing_status: status, error: error ?? null, processed_at: new Date().toISOString() }).eq("id", evId!);

  try {
    if (ev.event === "charge.success") {
      if (!ref) { await finish("ignored", "no_reference"); return reply("ok", 200); }
      const r = await verifyAndApply(ref, "webhook"); // never trust the payload: verify with Paystack
      if (r.state === "unverified") { await finish("failed", "paystack_unreachable"); return reply("retry", 500); }
      await finish("processed", r.state);
      return reply("ok", 200);
    }
    if (String(ev.event).startsWith("refund.")) {
      const map: Record<string, string> = { "refund.pending": "processing", "refund.processing": "processing", "refund.processed": "success", "refund.failed": "failed" };
      const status = map[ev.event];
      if (!status) { await finish("ignored", "unhandled_refund_event"); return reply("ok", 200); }
      let { data: rf } = await db.from("refunds").select("id").eq("paystack_refund_id", String(d.id ?? "")).maybeSingle();
      if (!rf && ref) {
        const { data: pay } = await db.from("payments").select("id").eq("transaction_reference", ref).maybeSingle();
        if (pay) rf = (await db.from("refunds").select("id").eq("payment_id", pay.id).in("status", ["pending", "processing"]).order("created_at", { ascending: false }).limit(1).maybeSingle()).data;
      }
      if (!rf) {
        await db.from("payment_audit_logs").insert({ transaction_reference: ref, action: "unmatched_refund_event", actor_type: "webhook", details: { event: ev.event } });
        await finish("ignored", "refund_not_found"); return reply("ok", 200);
      }
      const { error } = await db.rpc("record_refund_status", { p_refund: rf.id, p_status: status, p_ps_id: d.id ? String(d.id) : null });
      if (error) throw new Error(error.message);
      await finish("processed", status);
      return reply("ok", 200);
    }
    await finish("ignored", "unhandled_event");
    return reply("ok", 200);
  } catch (e) {
    console.error("webhook_processing_failed", (e as Error).message);
    await finish("failed", (e as Error).message.slice(0, 200));
    return reply("retry", 500); // non-2xx makes Paystack retry
  }
});
