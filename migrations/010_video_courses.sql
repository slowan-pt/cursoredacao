-- Video courses support.
-- Catalog data stays in the professor CMS for now; these tables store protected
-- access, watch progress and private student notes.

create table if not exists public.video_course_enrollments (
  id uuid primary key default gen_random_uuid(),
  site_id uuid not null references public.sites(id) on delete cascade,
  course_id text not null,
  aluno_id uuid not null references auth.users(id) on delete cascade,
  payment_id uuid references public.payments(id) on delete set null,
  status text not null default 'ACTIVE',
  access_expires_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint video_course_enrollments_status_check
    check (status in ('ACTIVE', 'INACTIVE', 'EXPIRED', 'REFUNDED'))
);

create unique index if not exists video_course_enrollments_unique_student
  on public.video_course_enrollments(site_id, course_id, aluno_id);

create index if not exists video_course_enrollments_site_student_idx
  on public.video_course_enrollments(site_id, aluno_id, status);

create table if not exists public.video_lesson_progress (
  id uuid primary key default gen_random_uuid(),
  site_id uuid not null references public.sites(id) on delete cascade,
  course_id text not null,
  lesson_id text not null default 'principal',
  aluno_id uuid not null references auth.users(id) on delete cascade,
  current_time_seconds integer not null default 0,
  duration_seconds integer not null default 0,
  percent_watched numeric(5,2) not null default 0,
  completed boolean not null default false,
  updated_at timestamptz not null default now()
);

create unique index if not exists video_lesson_progress_unique_student
  on public.video_lesson_progress(site_id, course_id, lesson_id, aluno_id);

create index if not exists video_lesson_progress_site_student_idx
  on public.video_lesson_progress(site_id, aluno_id, course_id);

create table if not exists public.video_lesson_notes (
  id uuid primary key default gen_random_uuid(),
  site_id uuid not null references public.sites(id) on delete cascade,
  course_id text not null,
  lesson_id text not null default 'principal',
  aluno_id uuid not null references auth.users(id) on delete cascade,
  timestamp_seconds integer not null default 0,
  note text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists video_lesson_notes_site_student_idx
  on public.video_lesson_notes(site_id, aluno_id, course_id, lesson_id, created_at desc);

alter table public.video_course_enrollments enable row level security;
alter table public.video_lesson_progress enable row level security;
alter table public.video_lesson_notes enable row level security;

