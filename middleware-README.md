# BRB Pro — Middleware Multi-Tenant + Auth

## O que está neste pacote
- `tenant.js` — resolver de subdomínio `*.brbpro.com.br` + isolamento
- `auth-cookie.js` — troca `localStorage` por cookie `HttpOnly Secure SameSite=Lax` + rate limit
- `migration.sql` — cria `barbershops` + `users` + adiciona `tenant_id` em todas as tabelas
- `worker-cloudflare.js` — caso Render não aceite wildcard (plano free)

## Instalação (5 min)

```bash
npm i jsonwebtoken bcrypt cookie-parser express-rate-limit
```

### 1. Server.js — adicione no topo
```js
const cookieParser = require('cookie-parser');
const { tenantResolver, requireTenantOwner } = require('./middleware/tenant');
const { requireAuth, loginLimiter, handleLogin, clearAuthCookies } = require('./middleware/auth-cookie');

app.set('trust proxy', 1);
app.use(cookieParser());
app.use(express.json());
app.use(tenantResolver); // ANTES de todas as rotas
```

### 2. Rotas

```js
// Públicas por barbearia (usa subdomínio)
app.get('/api/servicos', async (req,res)=>{
  const tenantId = req.tenantId || 'artnaregua'; // fallback demo
  const { rows } = await db.query('SELECT * FROM servicos WHERE tenant_id=$1', [tenantId]);
  res.json({ok:true, servicos: rows});
});
app.get('/api/slots', /* igual, filtra por tenantId */);
app.post('/api/agendar', /* cria agendamento com tenant_id */);

// Auth novo
app.post('/api/admin/login', loginLimiter, (req,res)=> handleLogin(req,res, db));
app.post('/api/admin/logout', (req,res)=> { clearAuthCookies(res); res.json({ok:true}) });
app.get('/api/admin/me', requireAuth, (req,res)=> res.json({ok:true, user:req.user}));

// Admin — exige auth + tenant correto
app.use('/api/admin', requireAuth, requireTenantOwner, adminRoutes);
```

### 3. Front — troque 3 linhas

**admin/login.html** — antes:
```js
localStorage.setItem('art_token', j.token);
fetch('/api/admin/me', { headers:{Authorization:'Bearer '+token}})
```

**depois:**
```js
await fetch('/api/admin/login', {
  method:'POST',
  credentials:'include', // <--- ESSENCIAL para cookie
  headers:{'Content-Type':'application/json'},
  body: JSON.stringify({ email: form.email.value, senha: form.senha.value })
});
// ...
await fetch('/api/admin/me', { credentials:'include' })
```

**admin/admin.js** — troque:
```js
// antes:
var token = localStorage.getItem('art_token');
opts.headers.Authorization = 'Bearer '+token;

// depois: remova token, use credentials
async function api(url, opts){
  opts = opts || {};
  opts.credentials = 'include';
  opts.headers = Object.assign({'Content-Type':'application/json'}, opts.headers||{});
  // ...
}
```

E no logout:
```js
await fetch('/api/admin/logout', {method:'POST', credentials:'include'});
location.href='/admin/login.html';
```

### 4. Banco — rode `migration.sql`
No Supabase/Neon/Render Postgres, execute o arquivo. Ele cria `barbershops` com `artnaregua` e `demo`, e adiciona `tenant_id` nas tabelas existentes.

Gere o hash da senha inicial:
```bash
node -e "console.log(require('bcrypt').hashSync('vitinh@continue',12))"
```
Cole no INSERT de `users` comentado no SQL.

### 5. Teste local
```
# /etc/hosts (ou use lvh.me que já resolve para 127.0.0.1)
127.0.0.1 artnaregua.localhost
127.0.0.1 demo.localhost
127.0.0.1 app.localhost
```
Acesse:
- http://artnaregua.localhost:3000 → site Art na Régua
- http://demo.localhost:3000 → site demo (dados diferentes)
- http://app.localhost:3000/admin → painel master

Se um não vazar dados do outro, o isolamento está OK.

### 6. Produção — DNS

Se Render aceitar wildcard:
- Render → Custom Domains → adicione `*.brbpro.com.br`
- Cloudflare → CNAME `*` → `seu-app.onrender.com` (proxied)

Se Render NÃO aceitar wildcard (plano free), use o `worker-cloudflare.js` incluso.

## Checklist de deploy
- [ ] `JWT_SECRET` com 32+ chars no ENV do Render
- [ ] `ADMIN_SENHA` removido após migrar para `users`
- [ ] `SameSite=Lax` + `Secure` só funciona com HTTPS (Cloudflare Full Strict ON)
- [ ] Testar `curl -v https://artnaregua.brbpro.com.br/api/servicos` vs `https://demo.brbpro.com.br/api/servicos`
