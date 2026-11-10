-- Payment system schema. All money amounts are integers in kobo (NGN minor units).
create extension if not exists pgcrypto;

create table public.app_settings(key text primary key, value text not null);
insert into public.app_settings values
 ('business_name','Your Brand'),('business_email','hello@example.com'),
 ('business_phone','+234 000 000 0000'),('business_address','Your address');

create table public.admin_users(user_id uuid primary key references auth.users(id) on delete cascade, created_at timestamptz not null default now());

create table public.products(
 id uuid primary key default gen_random_uuid(),
 slug text not null unique check (slug ~ '^[a-z0-9-]{1,60}$'),
 name text not null,
 price bigint not null check (price > 0),
 currency text not null default 'NGN' check (currency = 'NGN'),
 active boolean not null default true,
 created_at timestamptz not null default now());
insert into public.products(slug,name,price) values
 ('featured-product','Featured Product',500000),('community-product','Community Product',250000);

create sequence public.order_seq; create sequence public.receipt_seq;

create table public.orders(
 id uuid primary key default gen_random_uuid(),
 idempotency_key text not null unique,
 customer_id uuid references auth.users(id) on delete set null,
 order_number text not null unique,
 customer_name text not null, customer_email text not null,
 subtotal bigint not null check (subtotal > 0),
 discount bigint not null default 0 check (discount >= 0),
 total_amount bigint not null check (total_amount > 0),
 currency text not null default 'NGN' check (currency = 'NGN'),
 order_status text not null default 'pending_payment' check (order_status in
  ('pending_payment','paid','payment_review','cancelled','refunded','partially_refunded','reversed')),
 created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
 check (total_amount = subtotal - discount));
create index on public.orders(customer_id); create index on public.orders(lower(customer_email));

create table public.order_items(
 id uuid primary key default gen_random_uuid(),
 order_id uuid not null references public.orders(id) on delete cascade,
 product_id uuid references public.products(id) on delete set null,
 product_name_snapshot text not null,
 quantity int not null check (quantity between 1 and 100),
 unit_price bigint not null check (unit_price > 0),
 line_total bigint not null check (line_total = quantity * unit_price));
create index on public.order_items(order_id);

create table public.payments(
 id uuid primary key default gen_random_uuid(),
 order_id uuid not null references public.orders(id),
 transaction_reference text not null unique,
 paystack_transaction_id text unique,
 amount bigint not null check (amount > 0),
 currency text not null default 'NGN',
 payment_status text not null default 'pending' check (payment_status in
  ('pending','processing','success','failed','abandoned','reversed','refunded','partially_refunded')),
 payment_channel text, access_code text, authorization_url text,
 needs_review boolean not null default false, review_reason text,
 verified_at timestamptz, last_checked_at timestamptz,
 created_at timestamptz not null default now(), updated_at timestamptz not null default now());
create index on public.payments(order_id);
create index on public.payments(payment_status, created_at);
-- An order can be fulfilled by only one payment.
create unique index payments_one_success_per_order on public.payments(order_id)
 where payment_status in ('success','partially_refunded','refunded');

create table public.payment_webhook_events(
 id uuid primary key default gen_random_uuid(),
 dedupe_key text not null unique,
 event_type text not null, transaction_reference text,
 signature_verified boolean not null,
 processing_status text not null default 'received' check (processing_status in ('received','processed','failed','ignored')),
 error text, received_at timestamptz not null default now(), processed_at timestamptz);
create index on public.payment_webhook_events(transaction_reference);

create table public.receipts(
 id uuid primary key default gen_random_uuid(),
 receipt_number text not null unique,
 order_id uuid not null references public.orders(id),
 payment_id uuid not null unique references public.payments(id),
 verification_ref text not null unique,
 receipt_data jsonb not null,
 generated_at timestamptz not null default now(),
 email_delivery_status text not null default 'pending' check (email_delivery_status in ('pending','sent','failed','not_configured')),
 email_attempts int not null default 0, email_last_error text);

create table public.refunds(
 id uuid primary key default gen_random_uuid(),
 payment_id uuid not null references public.payments(id),
 order_id uuid not null references public.orders(id),
 refund_reference text not null unique,
 paystack_refund_id text,
 amount bigint not null check (amount > 0),
 status text not null default 'pending' check (status in ('pending','processing','success','failed')),
 reason text, created_by uuid,
 created_at timestamptz not null default now(), updated_at timestamptz not null default now());

create table public.payment_audit_logs(
 id bigint generated always as identity primary key,
 transaction_reference text, order_id uuid, action text not null,
 previous_status text, new_status text,
 actor_type text not null check (actor_type in ('customer','system','webhook','admin','reconciler')),
 actor_id uuid, details jsonb, created_at timestamptz not null default now());
create index on public.payment_audit_logs(transaction_reference);

create table public.rate_limits(key text primary key, window_start timestamptz not null, count int not null);

create or replace function public.set_updated_at() returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end $$;
create trigger t_orders_u before update on public.orders for each row execute function public.set_updated_at();
create trigger t_payments_u before update on public.payments for each row execute function public.set_updated_at();
create trigger t_refunds_u before update on public.refunds for each row execute function public.set_updated_at();

-- Audit logs are append-only, even for the service role.
create or replace function public.audit_immutable() returns trigger language plpgsql as $$
begin raise exception 'audit logs are append-only'; end $$;
create trigger t_audit_immutable before update or delete on public.payment_audit_logs
 for each row execute function public.audit_immutable();

create or replace function public.is_admin() returns boolean language sql stable security definer set search_path = public as $$
 select exists(select 1 from public.admin_users where user_id = auth.uid()) $$;

create or replace function public._audit(p_ref text,p_order uuid,p_action text,p_prev text,p_new text,p_actor text,p_details jsonb default null)
returns void language sql security definer set search_path = public as $$
 insert into public.payment_audit_logs(transaction_reference,order_id,action,previous_status,new_status,actor_type,details)
 values(p_ref,p_order,p_action,p_prev,p_new,p_actor,p_details) $$;

create or replace function public.hit_rate_limit(p_key text,p_max int,p_window_seconds int)
returns boolean language plpgsql security definer set search_path = public as $$
declare c int;
begin
 insert into public.rate_limits(key,window_start,count) values(p_key,now(),1)
 on conflict(key) do update set
  count = case when rate_limits.window_start < now() - make_interval(secs => p_window_seconds) then 1 else rate_limits.count + 1 end,
  window_start = case when rate_limits.window_start < now() - make_interval(secs => p_window_seconds) then now() else rate_limits.window_start end
 returning count into c;
 return c <= p_max;
end $$;

-- Prices and totals are calculated here, from the products table only.
create or replace function public.create_order(p_idem text,p_name text,p_email text,p_customer uuid,p_items jsonb)
returns table(o_order_id uuid,o_order_number text,o_payment_id uuid,o_reference text,o_amount bigint,o_currency text,
 o_payment_status text,o_access_code text,o_authorization_url text,o_existing boolean)
language plpgsql security definer set search_path = public as $$
declare v_order uuid; v_sub bigint; v_cnt int; v_found int; v_ref text; v_pay uuid; v_num text; v_existing boolean := true;
begin
 select id into v_order from orders where idempotency_key = p_idem;
 if v_order is null then
  v_existing := false;
  with req as (select i->>'slug' as slug, sum((i->>'quantity')::int) as qty from jsonb_array_elements(p_items) i group by 1)
  select count(*), count(p.id), coalesce(sum(p.price * req.qty),0) into v_cnt, v_found, v_sub
  from req left join products p on p.slug = req.slug and p.active;
  if v_cnt = 0 or v_cnt <> v_found or v_sub <= 0 then raise exception 'invalid_items'; end if;
  v_num := 'ORD-' || to_char(now(),'YYMMDD') || '-' || lpad(nextval('order_seq')::text,6,'0');
  insert into orders(idempotency_key,customer_id,order_number,customer_name,customer_email,subtotal,discount,total_amount,currency,order_status)
  values(p_idem,p_customer,v_num,p_name,p_email,v_sub,0,v_sub,'NGN','pending_payment') returning id into v_order;
  with req as (select i->>'slug' as slug, sum((i->>'quantity')::int) as qty from jsonb_array_elements(p_items) i group by 1)
  insert into order_items(order_id,product_id,product_name_snapshot,quantity,unit_price,line_total)
  select v_order,p.id,p.name,req.qty,p.price,p.price * req.qty from req join products p on p.slug = req.slug and p.active;
  v_ref := 'PAY-' || replace(gen_random_uuid()::text,'-','');
  insert into payments(order_id,transaction_reference,amount,currency,payment_status)
  values(v_order,v_ref,v_sub,'NGN','pending') returning id into v_pay;
  perform _audit(v_ref,v_order,'order_created',null,'pending','customer',jsonb_build_object('amount',v_sub));
 end if;
 return query select o.id,o.order_number,p.id,p.transaction_reference,p.amount,p.currency,p.payment_status,p.access_code,p.authorization_url,v_existing
  from orders o join payments p on p.order_id = o.id where o.id = v_order order by p.created_at desc limit 1;
end $$;

create or replace function public.mark_initialized(p_ref text,p_access text,p_url text)
returns void language plpgsql security definer set search_path = public as $$
declare v_order uuid;
begin
 update payments set access_code = p_access, authorization_url = p_url where transaction_reference = p_ref returning order_id into v_order;
 perform _audit(p_ref,v_order,'initialized','pending','pending','system');
end $$;

-- The only place a payment becomes "success". One transaction, row-locked, idempotent.
create or replace function public.finalize_payment(p_ref text,p_ps_id text,p_amount bigint,p_currency text,p_channel text,p_actor text)
returns text language plpgsql security definer set search_path = public as $$
declare pay payments%rowtype; ord orders%rowtype; v_prev text; v_num text; v_ver text; v_data jsonb;
begin
 select * into pay from payments where transaction_reference = p_ref for update;
 if not found then return 'unknown_reference'; end if;
 if pay.payment_status in ('success','partially_refunded','refunded') then return 'already_processed'; end if;
 select * into ord from orders where id = pay.order_id for update;
 v_prev := pay.payment_status;
 if p_amount <> pay.amount or p_currency <> pay.currency or pay.amount <> ord.total_amount or pay.currency <> ord.currency then
  update payments set needs_review = true, review_reason = 'amount_or_currency_mismatch', last_checked_at = now() where id = pay.id;
  update orders set order_status = 'payment_review' where id = ord.id;
  perform _audit(p_ref,ord.id,'verification_mismatch',v_prev,v_prev,p_actor,
   jsonb_build_object('expected',pay.amount,'received',p_amount,'currency',p_currency));
  return 'mismatch';
 end if;
 begin
  update payments set payment_status='success', paystack_transaction_id=p_ps_id, payment_channel=p_channel,
   verified_at=now(), last_checked_at=now(), needs_review=false, review_reason=null where id = pay.id;
 exception when unique_violation then
  update payments set needs_review = true, review_reason = 'duplicate_payment_detected', last_checked_at = now() where id = pay.id;
  perform _audit(p_ref,ord.id,'duplicate_payment_detected',v_prev,v_prev,p_actor);
  return 'duplicate';
 end;
 update orders set order_status = 'paid' where id = ord.id;
 v_num := 'RCT-' || to_char(now(),'YYYY') || '-' || lpad(nextval('receipt_seq')::text,6,'0');
 v_ver := upper(substr(encode(gen_random_bytes(8),'hex'),1,12));
 v_data := jsonb_build_object(
  'business', jsonb_build_object('name',(select value from app_settings where key='business_name'),
   'email',(select value from app_settings where key='business_email'),
   'phone',(select value from app_settings where key='business_phone'),
   'address',(select value from app_settings where key='business_address')),
  'receipt_number',v_num,'verification_ref',v_ver,'order_number',ord.order_number,
  'customer_name',ord.customer_name,'customer_email',ord.customer_email,
  'transaction_reference',p_ref,'paid_at',now(),
  'items',(select jsonb_agg(jsonb_build_object('name',oi.product_name_snapshot,'quantity',oi.quantity,'unit_price',oi.unit_price,'line_total',oi.line_total) order by oi.id) from order_items oi where oi.order_id = ord.id),
  'subtotal',ord.subtotal,'discount',ord.discount,'total',ord.total_amount,'currency',ord.currency,
  'payment_channel',p_channel,'status','PAID');
 insert into receipts(receipt_number,order_id,payment_id,verification_ref,receipt_data)
 values(v_num,ord.id,pay.id,v_ver,v_data) on conflict (payment_id) do nothing;
 perform _audit(p_ref,ord.id,'payment_verified',v_prev,'success',p_actor,jsonb_build_object('paystack_id',p_ps_id));
 return 'success';
end $$;

create or replace function public.set_payment_status(p_ref text,p_new text,p_actor text,p_note text default null)
returns text language plpgsql security definer set search_path = public as $$
declare pay payments%rowtype;
begin
 if p_new not in ('processing','failed','abandoned','reversed') then raise exception 'bad_status'; end if;
 select * into pay from payments where transaction_reference = p_ref for update;
 if not found then return 'unknown_reference'; end if;
 if p_new = 'reversed' then
  if pay.payment_status not in ('success','partially_refunded','refunded') then return 'ignored'; end if;
 elsif pay.payment_status in ('success','partially_refunded','refunded','reversed') then return 'ignored';
 end if;
 if pay.payment_status = p_new then return 'unchanged'; end if;
 update payments set payment_status = p_new, last_checked_at = now() where id = pay.id;
 if p_new = 'reversed' then update orders set order_status = 'reversed' where id = pay.order_id; end if;
 perform _audit(p_ref,pay.order_id,'status_changed',pay.payment_status,p_new,p_actor,jsonb_build_object('note',p_note));
 return p_new;
end $$;

create or replace function public.flag_payment(p_ref text,p_reason text,p_actor text)
returns void language plpgsql security definer set search_path = public as $$
declare pay payments%rowtype;
begin
 select * into pay from payments where transaction_reference = p_ref for update;
 if not found then return; end if;
 update payments set needs_review = true, review_reason = p_reason where id = pay.id;
 update orders set order_status = 'payment_review' where id = pay.order_id and order_status = 'pending_payment';
 perform _audit(p_ref,pay.order_id,'flagged_for_review',pay.payment_status,pay.payment_status,p_actor,jsonb_build_object('reason',p_reason));
end $$;

create or replace function public.record_refund_status(p_refund uuid,p_status text,p_ps_id text)
returns text language plpgsql security definer set search_path = public as $$
declare rf refunds%rowtype; pay payments%rowtype; v_total bigint; v_new text;
begin
 if p_status not in ('processing','success','failed') then raise exception 'bad_status'; end if;
 select * into rf from refunds where id = p_refund for update;
 if not found then return 'unknown_refund'; end if;
 if rf.status = 'success' then return 'unchanged'; end if;
 update refunds set status = p_status, paystack_refund_id = coalesce(p_ps_id, paystack_refund_id) where id = rf.id;
 if p_status = 'success' then
  select * into pay from payments where id = rf.payment_id for update;
  select coalesce(sum(amount),0) into v_total from refunds where payment_id = pay.id and status = 'success';
  v_new := case when v_total >= pay.amount then 'refunded' else 'partially_refunded' end;
  update payments set payment_status = v_new where id = pay.id;
  update orders set order_status = v_new where id = pay.order_id;
  perform _audit(pay.transaction_reference,pay.order_id,'refund_succeeded',pay.payment_status,v_new,'system',jsonb_build_object('amount',rf.amount));
 else
  perform _audit(null,rf.order_id,'refund_'||p_status,null,null,'system',jsonb_build_object('refund',rf.refund_reference));
 end if;
 return p_status;
end $$;

-- Only the service role (Edge Functions) may run the money-moving functions.
revoke all on function public.create_order(text,text,text,uuid,jsonb), public.mark_initialized(text,text,text),
 public.finalize_payment(text,text,bigint,text,text,text), public.set_payment_status(text,text,text,text),
 public.flag_payment(text,text,text), public.record_refund_status(uuid,text,text),
 public.hit_rate_limit(text,int,int), public._audit(text,uuid,text,text,text,text,jsonb)
 from public, anon, authenticated;
grant execute on function public.create_order(text,text,text,uuid,jsonb), public.mark_initialized(text,text,text),
 public.finalize_payment(text,text,bigint,text,text,text), public.set_payment_status(text,text,text,text),
 public.flag_payment(text,text,text), public.record_refund_status(uuid,text,text),
 public.hit_rate_limit(text,int,int), public._audit(text,uuid,text,text,text,text,jsonb) to service_role;

-- Row Level Security
alter table public.app_settings enable row level security;
alter table public.admin_users enable row level security;
alter table public.rate_limits enable row level security;
alter table public.products enable row level security;
alter table public.orders enable row level security;
alter table public.order_items enable row level security;
alter table public.payments enable row level security;
alter table public.payment_webhook_events enable row level security;
alter table public.receipts enable row level security;
alter table public.refunds enable row level security;
alter table public.payment_audit_logs enable row level security;

revoke all on all tables in schema public from anon, authenticated;
grant select on public.products to anon, authenticated;
grant select on public.orders, public.order_items, public.receipts, public.refunds,
 public.payment_audit_logs, public.payment_webhook_events to authenticated;
grant select (id,order_id,transaction_reference,amount,currency,payment_status,payment_channel,verified_at,created_at)
 on public.payments to authenticated;

create policy products_read on public.products for select to anon, authenticated using (active);
create policy orders_read on public.orders for select to authenticated using (customer_id = auth.uid() or public.is_admin());
create policy items_read on public.order_items for select to authenticated using
 (exists(select 1 from public.orders o where o.id = order_id and (o.customer_id = auth.uid() or public.is_admin())));
create policy payments_read on public.payments for select to authenticated using
 (exists(select 1 from public.orders o where o.id = order_id and (o.customer_id = auth.uid() or public.is_admin())));
create policy receipts_read on public.receipts for select to authenticated using
 (exists(select 1 from public.orders o where o.id = order_id and (o.customer_id = auth.uid() or public.is_admin())));
create policy refunds_admin_read on public.refunds for select to authenticated using (public.is_admin());
create policy audit_admin_read on public.payment_audit_logs for select to authenticated using (public.is_admin());
create policy webhook_admin_read on public.payment_webhook_events for select to authenticated using (public.is_admin());
-- No insert/update/delete policies exist for anon or authenticated: only Edge Functions (service role) can write.
