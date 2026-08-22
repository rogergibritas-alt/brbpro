# BRB Pro — Deploy Final (você já comprou brbpro.com.br)

## ✅ O que você já tem pronto nesta pasta
- `server.js` completo com multi-tenant + auth cookie + proxy fallback
- `brbpro-landing/index.html` — landing de vendas
- `middleware/tenant.js` + `auth-cookie.js`
- `migration.sql` para Postgres
- Tudo pronto para `git push` no Render

---

## PASSO 1 — Cloudflare (5 min)

Você comprou no Registro.br. Agora aponte para Cloudflare (grátis, com wildcard):

1. Crie conta em **cloudflare.com** → Add site → digite `brbpro.com.br` → Free
2. Cloudflare vai mostrar 2 nameservers tipo `jo.ns.cloudflare.com` e `amy.ns.cloudflare.com`
3. Copie eles → vá no **Registro.br** → `brbpro.com.br` → Editar DNS → "Utilizar DNS da Cloudflare" → cole os 2 nameservers → Salvar

Aguarde 5-30 min propagar (Cloudflare avisa por e-mail).

4. No **Cloudflare → DNS**, crie:

| Tipo  | Nome | Conteúdo | Proxy |
|-------|------|----------|-------|
| CNAME | `brbpro.com.br` | `seu-app.onrender.com` | ☁️ Proxied (laranja) |
| CNAME | `www` | `brbpro.com.br` | ☁️ |
| CNAME | `app` | `seu-app.onrender.com` | ☁️ |
| CNAME | `*` | `seu-app.onrender.com` | ☁️ |
| CNAME | `artnaregua` | `seu-app.onrender.com` | ☁️ (opcional, mas já cobre com *) |

> `seu-app.onrender.com` é o domínio que Render te dá (ex: `brbpro.onrender.com`). Você descobre após criar o serviço.

5. Cloudflare → SSL/TLS → **Full (strict)** + **Always Use HTTPS** ON

---

## PASSO 2 — Render (7 min)

### Opção A: Novo serviço (recomendado)
1. https://dashboard.render.com → New → Web Service → conecte seu GitHub
2. Selecione o repo onde você vai subir esta pasta `BRBPRO-FINAL`
3. Config:
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
   - **Node version:** 18+
   - **Environment:** adicione variáveis:
     - `JWT_SECRET` = gere com `openssl rand -hex 32` (ex: `a8f3b2c...`)
     - `ADMIN_SENHA` = `vitinh@continue` (troque depois)
     - `ORIGIN_FALLBACK` = `https://art-na-regua.onrender.com`
     - `NODE_ENV` = `production`

4. Deploy → Render vai te dar `https://brbpro-xxxx.onrender.com`
5. Copie esse host → volte no Cloudflare e use ele nos CNAMEs acima
6. Render → seu serviço → Settings → Custom Domains → Add:
   - `brbpro.com.br`
   - `www.brbpro.com.br`
   - `app.brbpro.com.br`
   - `*.brbpro.com.br` (se seu plano permitir; se não, use Worker)

> Se Render falar que `*.brbpro.com.br` não é permitido no seu plano, não tem problema: mantenha só `brbpro.com.br` e `app.brbpro.com.br` no Render, e ative o `worker-cloudflare.js` (instruções abaixo) — o wildcard vai funcionar igual via Cloudflare.

---

## PASSO 3 — Teste (2 min)

Após DNS propagar:

```bash
# Teste landing
curl -I https://brbpro.com.br

# Teste barbearia
curl -I https://artnaregua.brbpro.com.br
curl https://artnaregua.brbpro.com.br/api/servicos | jq

# Teste app
curl -I https://app.brbpro.com.br/admin/login.html
```

No navegador:
- https://brbpro.com.br → deve abrir a landing dourada/preta
- https://artnaregua.brbpro.com.br → deve abrir seu site Art na Régua (mesmo que art-na-regua.onrender.com, mas com subdomínio)
- https://demo.brbpro.com.br → deve abrir demo com preços diferentes (R$40)
- https://app.brbpro.com.br/admin/login.html → login

Login inicial: senha `vitinh@continue` (ou email `legacy@brbpro.com.br` + senha)

---

## PASSO 4 — Postgres (opcional, mas recomendado para SaaS)

Se for vender para +5 barbearias, use Postgres (Render, Neon ou Supabase grátis):

1. Render → New → PostgreSQL → crie DB → copie `Internal Database URL`
2. No serviço web → Environment → `DATABASE_URL` = cole
3. Localmente: `psql $DATABASE_URL -f migration.sql`
4. Gere hash da senha e crie usuário:
```bash
node -e "console.log(require('bcrypt').hashSync('vitinh@continue',12))"
# copie o hash e no SQL:
# INSERT INTO users (tenant_id, email, nome, senha_hash, role) VALUES ('artnaregua','vitin@brbpro.com.br','Vitin','HASH', 'owner');
```

Sem `DATABASE_URL`, o server funciona em memória (ótimo para testar).

---

## PASSO 5 — Se Render não aceitar wildcard

1. Cloudflare → Workers → Create Worker → cole `worker-cloudflare.js`
2. Edite `originHost = 'seu-app.onrender.com'` no Worker
3. Save → Deploy → Add Route → `*.brbpro.com.br/*` → Worker

Pronto, wildcard funciona mesmo sem Render pagar.

---

## Checklist final
- [ ] Cloudflare nameservers no Registro.br
- [ ] 4 CNAMEs criados (brbpro, www, app, *)
- [ ] Render com Custom Domains
- [ ] `JWT_SECRET` definido
- [ ] Testou artnaregua.brbpro.com.br e demo.brbpro.com.br com dados diferentes
- [ ] Login funciona e seta cookie `__Host-brb_token`

## Próximo passo comercial
1. Crie `demo.brbpro.com.br` como portfólio
2. Grave vídeo 30s: “Fala João da Barbearia X, olha como ficaria joao.brbpro.com.br”
3. Dispare para 30 barbearias de Ouro Preto no WhatsApp com link da landing

Qualquer erro de DNS, me mande print do Cloudflare que eu corrijo na hora.
