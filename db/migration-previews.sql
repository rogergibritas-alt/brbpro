-- ============================================================
-- BRB Pro — Prévias personalizadas por prospect (Fase 3)
-- Idempotente.
-- ============================================================
CREATE TABLE IF NOT EXISTS previews (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug          TEXT UNIQUE NOT NULL,
  nome          TEXT NOT NULL,
  cidade        TEXT,
  endereco      TEXT,
  instagram     TEXT,
  whatsapp      TEXT,
  cor_primaria  TEXT DEFAULT '#C9A86A',
  servicos      JSONB NOT NULL DEFAULT '[]'::jsonb,
  observacoes   TEXT,
  ativa         BOOLEAN DEFAULT TRUE,
  visitas       INT DEFAULT 0,
  ctas          INT DEFAULT 0,
  criada_em     TIMESTAMPTZ DEFAULT now(),
  atualizada_em TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_previews_slug ON previews(slug);
