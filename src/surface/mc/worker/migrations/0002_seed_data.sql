-- GA-1 (1.6): Seed data — initial users and agents
-- Source: grove-auth/src/schema/002_seed_data.sql
-- Apply: wrangler d1 execute grove-events --file=./migrations/0002_seed_data.sql

INSERT OR IGNORE INTO users (id, email, display_name, role) VALUES
  ('andreas', 'operator@example.com', 'Andreas', 'admin'),
  ('jc', 'operator@example.com', 'JC', 'operator');

INSERT OR IGNORE INTO agents (id, display_name, owner_id, class, backend) VALUES
  ('luna', 'Luna', 'andreas', 'pet', 'local');
