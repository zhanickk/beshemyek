
-- Roles enum & table
create type public.app_role as enum ('admin', 'user');

create table public.user_roles (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  role app_role not null,
  created_at timestamptz not null default now(),
  unique(user_id, role)
);
grant select on public.user_roles to authenticated;
grant all on public.user_roles to service_role;
alter table public.user_roles enable row level security;

create or replace function public.has_role(_user_id uuid, _role app_role)
returns boolean language sql stable security definer set search_path = public as $$
  select exists(select 1 from public.user_roles where user_id = _user_id and role = _role)
$$;

create policy "users read own roles" on public.user_roles
  for select to authenticated using (user_id = auth.uid());
create policy "admins read all roles" on public.user_roles
  for select to authenticated using (public.has_role(auth.uid(),'admin'));

-- Profiles
create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text,
  display_name text,
  created_at timestamptz not null default now()
);
grant select, insert, update on public.profiles to authenticated;
grant all on public.profiles to service_role;
alter table public.profiles enable row level security;
create policy "users read own profile" on public.profiles for select to authenticated using (id = auth.uid());
create policy "users update own profile" on public.profiles for update to authenticated using (id = auth.uid());
create policy "admins read all profiles" on public.profiles for select to authenticated using (public.has_role(auth.uid(),'admin'));

-- Auto-create profile + first user becomes admin
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  user_count int;
begin
  insert into public.profiles (id, email, display_name)
  values (new.id, new.email, coalesce(new.raw_user_meta_data->>'full_name', new.email));

  select count(*) into user_count from public.user_roles where role = 'admin';
  if user_count = 0 then
    insert into public.user_roles (user_id, role) values (new.id, 'admin');
  else
    insert into public.user_roles (user_id, role) values (new.id, 'user');
  end if;
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- updated_at helper
create or replace function public.tg_set_updated_at()
returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end; $$;

-- Chats
create table public.chats (
  id uuid primary key default gen_random_uuid(),
  telegram_chat_id bigint not null unique,
  title text,
  chat_type text,
  is_active boolean not null default true,
  joined_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
grant select, insert, update, delete on public.chats to authenticated;
grant all on public.chats to service_role;
alter table public.chats enable row level security;
create policy "admins manage chats" on public.chats for all to authenticated
  using (public.has_role(auth.uid(),'admin')) with check (public.has_role(auth.uid(),'admin'));
create trigger chats_updated_at before update on public.chats for each row execute function public.tg_set_updated_at();

-- Bot settings (per chat)
create table public.bot_settings (
  id uuid primary key default gen_random_uuid(),
  chat_id uuid not null unique references public.chats(id) on delete cascade,
  ai_replies_enabled boolean not null default true,
  prompts_enabled boolean not null default true,
  polls_enabled boolean not null default true,
  prompt_frequency text not null default 'daily', -- off | daily | twice_daily | hourly
  prompt_hour_utc int not null default 14, -- when daily fires (UTC)
  quiet_start int, -- hour UTC, optional
  quiet_end int,
  tone text not null default 'Kind, encouraging community host. Warm, inclusive, never sarcastic.',
  updated_at timestamptz not null default now()
);
grant select, insert, update, delete on public.bot_settings to authenticated;
grant all on public.bot_settings to service_role;
alter table public.bot_settings enable row level security;
create policy "admins manage bot_settings" on public.bot_settings for all to authenticated
  using (public.has_role(auth.uid(),'admin')) with check (public.has_role(auth.uid(),'admin'));
create trigger bot_settings_updated_at before update on public.bot_settings for each row execute function public.tg_set_updated_at();

-- Prompts library
create table public.prompts (
  id uuid primary key default gen_random_uuid(),
  text text not null,
  category text not null default 'icebreaker',
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);
grant select, insert, update, delete on public.prompts to authenticated;
grant all on public.prompts to service_role;
alter table public.prompts enable row level security;
create policy "admins manage prompts" on public.prompts for all to authenticated
  using (public.has_role(auth.uid(),'admin')) with check (public.has_role(auth.uid(),'admin'));

-- Incoming messages log (idempotent on update_id)
create table public.messages_log (
  update_id bigint primary key,
  telegram_chat_id bigint not null,
  from_user_id bigint,
  from_username text,
  text text,
  kind text not null default 'message', -- message | command | mention | poll_answer | other
  raw jsonb not null,
  created_at timestamptz not null default now()
);
grant select, insert on public.messages_log to authenticated;
grant all on public.messages_log to service_role;
alter table public.messages_log enable row level security;
create policy "admins read messages" on public.messages_log for select to authenticated using (public.has_role(auth.uid(),'admin'));
create index messages_log_chat_idx on public.messages_log(telegram_chat_id, created_at desc);

-- Outgoing bot sends
create table public.bot_sends (
  id uuid primary key default gen_random_uuid(),
  telegram_chat_id bigint not null,
  kind text not null, -- prompt | ai_reply | poll | trivia | welcome | manual
  content text,
  meta jsonb,
  sent_at timestamptz not null default now()
);
grant select, insert on public.bot_sends to authenticated;
grant all on public.bot_sends to service_role;
alter table public.bot_sends enable row level security;
create policy "admins read sends" on public.bot_sends for select to authenticated using (public.has_role(auth.uid(),'admin'));
create index bot_sends_chat_idx on public.bot_sends(telegram_chat_id, sent_at desc);

-- Trivia/polls state
create table public.polls (
  id uuid primary key default gen_random_uuid(),
  telegram_chat_id bigint not null,
  telegram_poll_id text unique,
  telegram_message_id bigint,
  question text not null,
  options jsonb not null,
  correct_option int,
  kind text not null default 'poll', -- poll | trivia
  is_closed boolean not null default false,
  started_at timestamptz not null default now(),
  closed_at timestamptz
);
grant select, insert, update on public.polls to authenticated;
grant all on public.polls to service_role;
alter table public.polls enable row level security;
create policy "admins manage polls" on public.polls for all to authenticated
  using (public.has_role(auth.uid(),'admin')) with check (public.has_role(auth.uid(),'admin'));

-- Seed prompts
insert into public.prompts (text, category) values
('What''s a small win you had this week?', 'icebreaker'),
('If you could instantly master one skill, what would it be?', 'icebreaker'),
('What''s the best thing you''ve eaten in the last 7 days?', 'icebreaker'),
('Share one song that always lifts your mood.', 'icebreaker'),
('What''s a hobby you want to try but haven''t yet?', 'icebreaker'),
('What''s your go-to comfort movie or show?', 'icebreaker'),
('Describe your perfect Sunday in three words.', 'icebreaker'),
('What''s a book or article that changed how you think?', 'deep'),
('What''s something you''ve changed your mind about recently?', 'deep'),
('What does a great day look like for you?', 'deep'),
('What''s the most underrated app on your phone?', 'tech'),
('Coffee, tea, or something else?', 'fun'),
('What''s a tradition you''d love to start?', 'fun'),
('Mountains or ocean — and why?', 'fun'),
('What''s a piece of advice you''d give your past self?', 'deep'),
('Drop an emoji that describes your mood today.', 'quick'),
('What''s one thing you''re looking forward to this week?', 'quick'),
('Share a photo of your workspace (or describe it!).', 'fun'),
('What''s a small habit that''s made a big difference?', 'deep'),
('If you could host a dinner with any 3 people, who?', 'fun');
