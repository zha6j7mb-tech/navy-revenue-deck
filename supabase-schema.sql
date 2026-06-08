-- =========================================================================
-- NAVY_BLUE Revenue Deck - Supabase schema
-- Supabase の SQL Editor に貼り付けて実行してください。
-- 実行後「Success. No rows returned」と出れば成功です。
-- =========================================================================

-- 案件テーブル
create table if not exists public.revenue_projects (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null default auth.uid() references auth.users (id) on delete cascade,
  client_name   text not null default '',
  project_type  text not null default '',
  amount        bigint not null default 0,
  status        text not null default 'lead'
                  check (status in ('lead','ordered','producing','delivered','invoiced','paid')),
  ordered_at    date,
  deadline      date,
  invoiced_at   date,
  paid_at       date,
  memo          text not null default '',
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  -- クライアント側の編集時刻。トリガで上書きされる updated_at と違い、
  -- 端末をまたいだ「新しい方を採用」マージの判定に使う。
  client_updated_at timestamptz
);

-- ユーザー単位の検索を高速化
create index if not exists revenue_projects_user_idx on public.revenue_projects (user_id);
create index if not exists revenue_projects_paid_idx on public.revenue_projects (user_id, paid_at);

-- 行レベルセキュリティ（自分の行だけ読み書きできるようにする）
alter table public.revenue_projects enable row level security;

drop policy if exists "own rows select" on public.revenue_projects;
create policy "own rows select"
  on public.revenue_projects for select
  using (auth.uid() = user_id);

drop policy if exists "own rows insert" on public.revenue_projects;
create policy "own rows insert"
  on public.revenue_projects for insert
  with check (auth.uid() = user_id);

drop policy if exists "own rows update" on public.revenue_projects;
create policy "own rows update"
  on public.revenue_projects for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists "own rows delete" on public.revenue_projects;
create policy "own rows delete"
  on public.revenue_projects for delete
  using (auth.uid() = user_id);

-- updated_at を自動更新
create or replace function public.set_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists revenue_projects_set_updated_at on public.revenue_projects;
create trigger revenue_projects_set_updated_at
  before update on public.revenue_projects
  for each row execute function public.set_updated_at();
