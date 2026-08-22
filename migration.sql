-- BRB Pro — Migração Multi-Tenant
-- Banco: Postgres (Supabase/Neon/Render Postgres)
-- Execute uma vez. Faz backup antes.

-- 1) Tabela de barbearias (tenants)
CREATE TABLE IF NOT EXISTS barbershops (
  id TEXT PRIMARY KEY, -- slug usado como id: 'artnaregua'
  slug TEXT UNIQUE NOT NULL, -- subdomínio: artnaregua
  nome TEXT NOT NULL, -- "Art na Régua"
  whatsapp TEXT, -- 5531997816616
  instagram TEXT,
  endereco TEXT,
  cep TEXT,
  cidade TEXT,
  horario JSONB DEFAULT '{}'::jsonb, -- {"terca_sexta":"08:40-18:00", "sabado":"08:40-18:00"}
  tema TEXT DEFAULT 'dark', -- dark | light | street
  ativo BOOLEAN DEFAULT true,
  plano TEXT DEFAULT 'pro', -- essencial | pro | premium
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- Tenant inicial: Art na Régua (seu case #1)
INSERT INTO barbershops (id, slug, nome, whatsapp, instagram, endereco, cidade, horario)
VALUES (
  'artnaregua',
  'artnaregua',
  'Art na Régua',
  '5531997816616',
  '@vitin01._',
  'R. Padre Rolim, 945 — São Cristóvão, Ouro Preto - MG · CEP 35400-000',
  'Ouro Preto',
  '{"terca_sexta":"08:40-18:00","sabado":"08:40-18:00","segunda":"fechado","domingo":"fechado"}'::jsonb
)
ON CONFLICT (id) DO NOTHING;

-- Tenant demo para testes (teste.brbpro.com.br)
INSERT INTO barbershops (id, slug, nome, whatsapp, endereco, cidade)
VALUES ('demo','demo','Barbearia Demo','5511999999999','Rua Demo, 123 — Centro','São Paulo')
ON CONFLICT (id) DO NOTHING;

-- 2) Adiciona tenant_id em todas as tabelas existentes
-- Ajuste os nomes conforme seu banco atual. Se usa SQLite/JSON, adapte para adicionar campo tenant_id no objeto.

-- Exemplo genérico Postgres:
DO $$ 
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['servicos','agendamentos','clientes','fotos','faq','config','estoque','caixa','logs','users'] LOOP
    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = t) THEN
      EXECUTE format('ALTER TABLE %I ADD COLUMN IF NOT EXISTS tenant_id TEXT REFERENCES barbershops(id) ON DELETE CASCADE', t);
      EXECUTE format('CREATE INDEX IF NOT EXISTS idx_%I_tenant ON %I(tenant_id)', t, t);
      -- Preenche existentes com artnaregua
      EXECUTE format('UPDATE %I SET tenant_id = ''artnaregua'' WHERE tenant_id IS NULL', t);
      -- Torna obrigatório após preencher
      -- EXECUTE format('ALTER TABLE %I ALTER COLUMN tenant_id SET NOT NULL', t); -- habilite após conferir
    END IF;
  END LOOP;
END $$;

-- 3) Tabela de usuários por tenant (substitui senha única global)
CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL REFERENCES barbershops(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  nome TEXT NOT NULL,
  senha_hash TEXT NOT NULL, -- bcrypt
  role TEXT NOT NULL DEFAULT 'owner', -- owner | staff
  ativo BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(tenant_id, email)
);
CREATE INDEX IF NOT EXISTS idx_users_tenant ON users(tenant_id);

-- Cria usuário inicial para artnaregua (senha: vitinh@continue — troque no primeiro login)
-- Gere o hash com: node -e "console.log(require('bcrypt').hashSync('vitinh@continue', 12))"
-- Cole o hash abaixo:
-- INSERT INTO users (tenant_id, email, nome, senha_hash, role)
-- VALUES ('artnaregua','vitin@brbpro.com.br','Vitin', '$2b$12$SEU_HASH_AQUI', 'owner')
-- ON CONFLICT DO NOTHING;

-- 4) View útil para debug
CREATE OR REPLACE VIEW v_tenant_resumo AS
SELECT 
  b.slug,
  b.nome,
  b.plano,
  (SELECT COUNT(*) FROM agendamentos a WHERE a.tenant_id = b.id) as total_agendamentos,
  (SELECT COUNT(*) FROM clientes c WHERE c.tenant_id = b.id) as total_clientes,
  (SELECT COUNT(*) FROM servicos s WHERE s.tenant_id = b.id) as total_servicos
FROM barbershops b;

-- Teste:
-- SELECT * FROM v_tenant_resumo;
-- SELECT * FROM servicos WHERE tenant_id='artnaregua';
-- SELECT * FROM servicos WHERE tenant_id='demo';

-- 5) Rollback (se precisar desfazer — CUIDADO):
-- ALTER TABLE servicos DROP COLUMN IF EXISTS tenant_id;
-- DROP TABLE IF EXISTS users CASCADE;
-- DROP TABLE IF EXISTS barbershops CASCADE;
