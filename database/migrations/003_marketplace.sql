-- Home-services marketplace domain. Idempotent; preserves existing accounts and auth records.
INSERT INTO roles (name, description) VALUES
  ('customer', 'Customer who browses and books home services'),
  ('provider', 'Service provider with approved marketplace access'),
  ('support_agent', 'Support staff with ticket-scoped access')
ON CONFLICT (name) DO NOTHING;

UPDATE users SET role_id = (SELECT id FROM roles WHERE name = 'customer')
WHERE role_id = (SELECT id FROM roles WHERE name = 'user');

CREATE TABLE IF NOT EXISTS customer_profiles (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  phone TEXT,
  address TEXT,
  city TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS provider_profiles (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  business_name TEXT NOT NULL,
  bio TEXT NOT NULL DEFAULT '',
  phone TEXT,
  service_area TEXT[] NOT NULL DEFAULT '{}',
  years_experience SMALLINT NOT NULL DEFAULT 0 CHECK (years_experience BETWEEN 0 AND 80),
  approval_status TEXT NOT NULL DEFAULT 'pending' CHECK (approval_status IN ('pending','approved','rejected','suspended')),
  reviewed_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  reviewed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS provider_applications (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  business_name TEXT NOT NULL,
  bio TEXT NOT NULL,
  service_area TEXT[] NOT NULL DEFAULT '{}',
  years_experience SMALLINT NOT NULL DEFAULT 0 CHECK (years_experience BETWEEN 0 AND 80),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  reviewed_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  admin_notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  reviewed_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_provider_applications_status ON provider_applications(status, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_one_pending_provider_application ON provider_applications(user_id) WHERE status='pending';

CREATE TABLE IF NOT EXISTS service_categories (
  id SERIAL PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL UNIQUE,
  description TEXT NOT NULL DEFAULT '',
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO service_categories (slug, name, description) VALUES
  ('plumbing','Plumbing','Leaks, fixtures, pipes, and water systems'),
  ('electrical','Electrical','Safe electrical repairs and installations'),
  ('cleaning','Cleaning','Home and deep cleaning services'),
  ('painting','Painting','Interior and exterior painting'),
  ('carpentry','Carpentry','Furniture, fittings, and woodwork'),
  ('appliance-repair','Appliance repair','Diagnosis and repair of home appliances'),
  ('gardening','Gardening','Garden care and outdoor maintenance'),
  ('air-conditioning','Air conditioning','Installation and maintenance of cooling systems')
ON CONFLICT (slug) DO NOTHING;

CREATE TABLE IF NOT EXISTS service_listings (
  id SERIAL PRIMARY KEY,
  provider_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  category_id INTEGER NOT NULL REFERENCES service_categories(id) ON DELETE RESTRICT,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  base_price NUMERIC(10,2) NOT NULL CHECK (base_price > 0),
  price_unit TEXT NOT NULL DEFAULT 'per job',
  service_area TEXT[] NOT NULL DEFAULT '{}',
  approval_status TEXT NOT NULL DEFAULT 'pending' CHECK (approval_status IN ('pending','approved','rejected','suspended')),
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_service_listings_public ON service_listings(approval_status, is_active, category_id);
CREATE INDEX IF NOT EXISTS idx_service_listings_provider ON service_listings(provider_id, created_at DESC);

CREATE TABLE IF NOT EXISTS provider_availability (
  id SERIAL PRIMARY KEY,
  provider_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  weekday SMALLINT NOT NULL CHECK (weekday BETWEEN 0 AND 6),
  starts_at TIME NOT NULL,
  ends_at TIME NOT NULL,
  is_available BOOLEAN NOT NULL DEFAULT TRUE,
  CHECK (ends_at > starts_at),
  UNIQUE (provider_id, weekday, starts_at, ends_at)
);

CREATE TABLE IF NOT EXISTS bookings (
  id SERIAL PRIMARY KEY,
  customer_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  provider_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  service_id INTEGER NOT NULL REFERENCES service_listings(id) ON DELETE RESTRICT,
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','CONFIRMED','REJECTED','IN_PROGRESS','COMPLETED','CANCELLED')),
  requested_at TIMESTAMPTZ NOT NULL,
  agreed_price NUMERIC(10,2) NOT NULL CHECK (agreed_price > 0),
  description TEXT NOT NULL DEFAULT '',
  cancellation_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (customer_id <> provider_id)
);
CREATE INDEX IF NOT EXISTS idx_bookings_customer ON bookings(customer_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_bookings_provider ON bookings(provider_id, status, requested_at);

CREATE TABLE IF NOT EXISTS service_reviews (
  id SERIAL PRIMARY KEY,
  booking_id INTEGER NOT NULL UNIQUE REFERENCES bookings(id) ON DELETE RESTRICT,
  customer_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  provider_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  rating SMALLINT NOT NULL CHECK (rating BETWEEN 1 AND 5),
  comment TEXT NOT NULL DEFAULT '',
  moderation_status TEXT NOT NULL DEFAULT 'visible' CHECK (moderation_status IN ('visible','hidden')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_service_reviews_provider ON service_reviews(provider_id, created_at DESC);

CREATE TABLE IF NOT EXISTS notifications (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  notification_type TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  data JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  read_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS support_tickets (
  id SERIAL PRIMARY KEY,
  requester_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  assigned_agent_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  category TEXT NOT NULL,
  priority TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('low','normal','high','urgent')),
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','in_progress','waiting','resolved','closed')),
  subject TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_support_tickets_assignee ON support_tickets(assigned_agent_id, status, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_support_tickets_requester ON support_tickets(requester_id, created_at DESC);

CREATE TABLE IF NOT EXISTS support_ticket_messages (
  id SERIAL PRIMARY KEY,
  ticket_id INTEGER NOT NULL REFERENCES support_tickets(id) ON DELETE CASCADE,
  sender_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  message TEXT NOT NULL,
  is_internal BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_support_messages_ticket ON support_ticket_messages(ticket_id, created_at);
