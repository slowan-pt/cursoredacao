-- Video course payments.
-- Non-destructive: keeps existing turma payments untouched and adds explicit
-- product targeting for video course purchases.

alter table public.payments
  add column if not exists product_type text not null default 'TURMA',
  add column if not exists course_id text;

alter table public.payments
  drop constraint if exists payments_product_type_check;

alter table public.payments
  add constraint payments_product_type_check
    check (product_type in ('TURMA', 'VIDEO_COURSE', 'PLATFORM_PLAN'));

create index if not exists idx_payments_site_product
  on public.payments(site_id, product_type, course_id, payer_email, status);

