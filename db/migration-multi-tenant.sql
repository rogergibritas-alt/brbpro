-- ============================================================
-- BRB Pro — Migração Multi-Tenant (Modelo B)
-- Executar em qualquer banco do Zero ou por cima do existente.
-- Idempotente: pode rodar várias vezes sem quebrar.
-- ============================================================

-- Extensão p/ UUID (a tabela users já usa gen_random_uuid)
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ---------- 1) BARBEARIAS (tenants) ----------
CREATE TABLE IF NOT EXISTS barbershops (
  id          TEXT PRIMARY KEY,             -- slug (ex: 'artnaregua')
  slug        TEXT UNIQUE NOT NULL,          -- subdomínio
  nome        TEXT NOT NULL,
  whatsapp    TEXT,
  instagram   TEXT,
  endereco    TEXT,
  cep         TEXT,
  cidade      TEXT,
  estado      TEXT,
  horario     JSONB NOT NULL DEFAULT '{}'::jsonb,   -- {"terca_sexta":"08:40-18:00","sabado":"...","segunda":"fechado",...}
  slots_semana JSONB NOT NULL DEFAULT '[]'::jsonb,  -- lista de horários padrão
  tema        TEXT DEFAULT 'dark',
  plano       TEXT DEFAULT 'pro',
  ativo       BOOLEAN DEFAULT TRUE,
  email_contato TEXT,
  cor_primaria TEXT DEFAULT '#C9A86A',
  created_at  TIMESTAMPTZ DEFAULT now(),
  updated_at  TIMESTAMPTZ DEFAULT now()
);

-- ---------- 2) USUÁRIOS por tenant ----------
CREATE TABLE IF NOT EXISTS users (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   TEXT NOT NULL REFERENCES barbershops(id) ON DELETE CASCADE,
  email       TEXT NOT NULL,
  nome        TEXT NOT NULL,
  senha_hash  TEXT NOT NULL,
  role        TEXT NOT NULL DEFAULT 'owner',   -- owner | staff | master
  ativo       BOOLEAN DEFAULT TRUE,
  created_at  TIMESTAMPTZ DEFAULT now(),
  UNIQUE(tenant_id, email)
);
CREATE INDEX IF NOT EXISTS idx_users_tenant ON users(tenant_id);

-- ---------- 3) SERVIÇOS ----------
CREATE TABLE IF NOT EXISTS servicos (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   TEXT NOT NULL REFERENCES barbershops(id) ON DELETE CASCADE,
  nome        TEXT NOT NULL,
  preco       NUMERIC(10,2),
  slots       INT NOT NULL DEFAULT 1,
  online      BOOLEAN DEFAULT TRUE,
  ativo       BOOLEAN DEFAULT TRUE,
  ordem       INT DEFAULT 0,
  created_at  TIMESTAMPTZ DEFAULT now(),
  UNIQUE(tenant_id, nome)
);
CREATE INDEX IF NOT EXISTS idx_servicos_tenant ON servicos(tenant_id);

-- ---------- 4) AGENDAMENTOS ----------
CREATE TABLE IF NOT EXISTS agendamentos (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     TEXT NOT NULL REFERENCES barbershops(id) ON DELETE CASCADE,
  nome          TEXT NOT NULL,
  whatsapp      TEXT,
  servico       TEXT,
  data          DATE NOT NULL,
  horario       TEXT,
  obs           TEXT,
  origem        TEXT DEFAULT 'site',
  num_slots     INT DEFAULT 1,
  status        TEXT DEFAULT 'confirmado',    -- confirmado | cancelado | concluido
  valor         NUMERIC(10,2),
  forma_pagamento TEXT,
  pago          BOOLEAN DEFAULT FALSE,
  pago_em       TIMESTAMPTZ,
  cliente_id    UUID,
  created_at    TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_agendamentos_tenant_data ON agendamentos(tenant_id, data);
-- (índice único de bloqueio é criado mais abaixo, após as colunas existirem)

-- ---------- 5) CLIENTES ----------
CREATE TABLE IF NOT EXISTS clientes (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   TEXT NOT NULL REFERENCES barbershops(id) ON DELETE CASCADE,
  nome        TEXT NOT NULL,
  whatsapp    TEXT,
  observacoes TEXT,
  criado_em   TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_clientes_tenant ON clientes(tenant_id);

-- ---------- 6) FLUXO DE CAIXA ----------
CREATE TABLE IF NOT EXISTS fluxo_caixa (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      TEXT NOT NULL REFERENCES barbershops(id) ON DELETE CASCADE,
  data           DATE NOT NULL DEFAULT CURRENT_DATE,
  tipo           TEXT NOT NULL CHECK (tipo IN ('entrada','saida')),
  categoria      TEXT,
  descricao      TEXT,
  valor          NUMERIC(10,2) NOT NULL,
  forma_pagamento TEXT,
  criado_em      TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_caixa_tenant ON fluxo_caixa(tenant_id, data);

-- ---------- 7) ESTOQUE ----------
CREATE TABLE IF NOT EXISTS estoque (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         TEXT NOT NULL REFERENCES barbershops(id) ON DELETE CASCADE,
  produto           TEXT NOT NULL,
  quantidade        INT DEFAULT 0,
  quantidade_minima INT DEFAULT 0,
  custo             NUMERIC(10,2),
  preco_venda       NUMERIC(10,2),
  criado_em         TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_estoque_tenant ON estoque(tenant_id);

-- ---------- 8) GALERIA ----------
CREATE TABLE IF NOT EXISTS fotos (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   TEXT NOT NULL REFERENCES barbershops(id) ON DELETE CASCADE,
  categoria   TEXT NOT NULL,
  imagem      TEXT NOT NULL,        -- data URL base64
  tipo        TEXT DEFAULT 'imagem',-- imagem | video
  criado_em   TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_fotos_tenant ON fotos(tenant_id, categoria);

-- ---------- 9) FAQ ----------
CREATE TABLE IF NOT EXISTS faq (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   TEXT NOT NULL REFERENCES barbershops(id) ON DELETE CASCADE,
  pergunta    TEXT NOT NULL,
  resposta    TEXT NOT NULL,
  ordem       INT DEFAULT 0,
  criado_em   TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_faq_tenant ON faq(tenant_id);

-- ---------- 10) CONFIGURAÇÕES ----------
CREATE TABLE IF NOT EXISTS configuracoes (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   TEXT NOT NULL REFERENCES barbershops(id) ON DELETE CASCADE,
  chave       TEXT NOT NULL,
  valor       TEXT,
  UNIQUE(tenant_id, chave)
);
CREATE INDEX IF NOT EXISTS idx_config_tenant ON configuracoes(tenant_id);

-- ---------- 11) LOGS / AUDITORIA ----------
CREATE TABLE IF NOT EXISTS logs (
  id          BIGSERIAL PRIMARY KEY,
  tenant_id   TEXT,
  tipo        TEXT,
  acao        TEXT,
  detalhe     TEXT,
  usuario     TEXT,
  ip          TEXT,
  criado_em   TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_logs_tenant ON logs(tenant_id, id DESC);

-- ---------- 12) CONTATOS ----------
CREATE TABLE IF NOT EXISTS contatos (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   TEXT NOT NULL REFERENCES barbershops(id) ON DELETE CASCADE,
  nome        TEXT,
  contato     TEXT,
  mensagem    TEXT,
  origem      TEXT DEFAULT 'site',
  criado_em   TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_contatos_tenant ON contatos(tenant_id);

-- ============================================================
-- AJUSTES IDEMPOTENTES p/ tabelas que já existem com schema anterior
-- (garante todas as colunas em qualquer base, nova ou antiga)
-- ============================================================
ALTER TABLE barbershops ADD COLUMN IF NOT EXISTS estado TEXT;
ALTER TABLE barbershops ADD COLUMN IF NOT EXISTS slots_semana JSONB DEFAULT '[]'::jsonb;
ALTER TABLE barbershops ADD COLUMN IF NOT EXISTS email_contato TEXT;
ALTER TABLE barbershops ADD COLUMN IF NOT EXISTS cor_primaria TEXT DEFAULT '#C9A86A';

ALTER TABLE servicos ADD COLUMN IF NOT EXISTS ativo BOOLEAN DEFAULT TRUE;
ALTER TABLE servicos ADD COLUMN IF NOT EXISTS ordem INT DEFAULT 0;

ALTER TABLE agendamentos ADD COLUMN IF NOT EXISTS obs TEXT;
ALTER TABLE agendamentos ADD COLUMN IF NOT EXISTS origem TEXT DEFAULT 'site';
ALTER TABLE agendamentos ADD COLUMN IF NOT EXISTS num_slots INT DEFAULT 1;
ALTER TABLE agendamentos ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'confirmado';
ALTER TABLE agendamentos ADD COLUMN IF NOT EXISTS valor NUMERIC(10,2);
ALTER TABLE agendamentos ADD COLUMN IF NOT EXISTS forma_pagamento TEXT;
ALTER TABLE agendamentos ADD COLUMN IF NOT EXISTS pago BOOLEAN DEFAULT FALSE;
ALTER TABLE agendamentos ADD COLUMN IF NOT EXISTS pago_em TIMESTAMPTZ;
ALTER TABLE agendamentos ADD COLUMN IF NOT EXISTS cliente_id UUID;

-- Reforça o índice único de bloqueio de horário por tenant (idempotente)
CREATE UNIQUE INDEX IF NOT EXISTS idx_agendamento_unico_tenant
  ON agendamentos (tenant_id, data, horario) WHERE status <> 'cancelado';

-- ============================================================
-- SEED — Cria usuário master se não existir (email: admin@brbpro.com.br)
-- Senha inicial definida por hash (gerar com: npm run hash "senha")
-- ============================================================

-- ============================================================
-- PERSONALIZAÇÃO DO SITE POR CLIENTE (v2)
-- Cada barbearia tem seu próprio conteúdo (não herda da Art na Régua)
-- ============================================================
ALTER TABLE barbershops ADD COLUMN IF NOT EXISTS logo         TEXT;            -- data URL (base64) do logo do cliente
ALTER TABLE barbershops ADD COLUMN IF NOT EXISTS video_hero   TEXT;            -- data URL (mp4/webm) ou URL do vídeo de fundo
ALTER TABLE barbershops ADD COLUMN IF NOT EXISTS hero_imagem  TEXT;            -- data URL da imagem de fundo do hero
ALTER TABLE barbershops ADD COLUMN IF NOT EXISTS slogan       TEXT;            -- hashtag/frase curta
ALTER TABLE barbershops ADD COLUMN IF NOT EXISTS hero_titulo  TEXT;            -- título principal (fallback = nome)
ALTER TABLE barbershops ADD COLUMN IF NOT EXISTS hero_sub     TEXT;            -- subtítulo do hero
ALTER TABLE barbershops ADD COLUMN IF NOT EXISTS sobre_texto  TEXT;            -- parágrafo "sobre"
ALTER TABLE barbershops ADD COLUMN IF NOT EXISTS cor_secundaria TEXT DEFAULT '#B08D57';
ALTER TABLE barbershops ADD COLUMN IF NOT EXISTS fonte_titulo TEXT;            -- nome da fonte p/ títulos
ALTER TABLE barbershops ADD COLUMN IF NOT EXISTS ia_ativo BOOLEAN DEFAULT FALSE; -- reservado
ALTER TABLE barbershops ADD COLUMN IF NOT EXISTS intro_video TEXT;        -- vídeo de introdução do site (data URL)

-- ============================================================
-- IDENTIDADE / FRASES DE IMPACTO POR CLIENTE (v3)
-- Cada barbearia tem seus próprios textos (não herda da Art na Régua)
-- ============================================================
ALTER TABLE barbershops ADD COLUMN IF NOT EXISTS diferenciais JSONB;   -- [{titulo,texto} x4]
ALTER TABLE barbershops ADD COLUMN IF NOT EXISTS depoimentos JSONB;    -- [{texto,autor} x3]
ALTER TABLE barbershops ADD COLUMN IF NOT EXISTS hero_sub_personalizado TEXT;
