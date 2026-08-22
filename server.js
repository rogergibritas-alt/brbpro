/**
 * BRB Pro — Servidor Multi-Tenant
 * brbpro.com.br (landing) + app.brbpro.com.br (painel) + *.brbpro.com.br (barbearias)
 * 
 * Deploy: Render (Node 18+), Railway, Fly, ou qualquer host com Node.
 * DNS: Cloudflare com wildcard *.brbpro.com.br → seu-app.onrender.com
 * 
 * Este server já funciona sem banco (usa memória) e com Postgres se DATABASE_URL existir.
 * Proxy fallback: assets não encontrados localmente são buscados em ORIGIN_FALLBACK
 */

require('dotenv').config();
const express = require('express');
const cookieParser = require('cookie-parser');
const path = require('path');
const fs = require('fs');

const { tenantResolver, requireTenantOwner } = require('./middleware/tenant');
const { requireAuth, loginLimiter, handleLogin, clearAuthCookies, setAuthCookies } = require('./middleware/auth-cookie');

const app = express();
const PORT = process.env.PORT || 3000;
const ORIGIN = process.env.ORIGIN_FALLBACK || 'https://art-na-regua.onrender.com';
const JWT_SECRET = process.env.JWT_SECRET;

if (!JWT_SECRET && process.env.NODE_ENV === 'production') {
  console.warn('⚠️  JWT_SECRET não definido! Gere com: openssl rand -hex 32');
}

app.set('trust proxy', 1);
app.use(cookieParser());
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));

// CORS para app.brbpro.com.br + *.brbpro.com.br
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && origin.endsWith('brbpro.com.br')) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
  }
  next();
});

// Tenant resolver — TEM que vir antes de estáticos e APIs
app.use(tenantResolver);

// Headers de segurança (complementa CSP do Render/Cloudflare)
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  // CSP já vem do Cloudflare/Render, mas garantimos frame-ancestors
  next();
});

// ===== MOCK DB (use Postgres em produção) =====
// Em produção com DATABASE_URL, troque por pg Pool
let DB = {
  barbershops: new Map([
    ['artnaregua', { id: 'artnaregua', slug: 'artnaregua', nome: 'Art na Régua', whatsapp: '5531997816616', instagram: '@vitin01._', endereco: 'R. Padre Rolim, 945 — São Cristóvão, Ouro Preto - MG', cidade: 'Ouro Preto', plano: 'pro', tema: 'dark' }],
    ['demo', { id: 'demo', slug: 'demo', nome: 'Barbearia Demo', whatsapp: '5511999999999', endereco: 'Rua Demo, 123', cidade: 'São Paulo', plano: 'essencial', tema: 'dark' }],
  ]),
  servicos: new Map(), // tenant_id -> array
  agendamentos: new Map(),
};

// Seed serviços demo
DB.servicos.set('artnaregua', [
  { nome: 'Corte', slots: 1, online: true, preco: 35 },
  { nome: 'Barba', slots: 1, online: true, preco: 25 },
  { nome: 'Sobrancelha', slots: 1, online: true, preco: 10 },
  { nome: 'Cavanhaque', slots: 1, online: true, preco: 15 },
  { nome: 'Combo Corte + Barba', slots: 2, online: true, preco: 60 },
  { nome: 'Pigmentação', slots: 2, online: true, preco: 25 },
  { nome: 'Alisamento', slots: 2, online: true, preco: 25 },
]);
DB.servicos.set('demo', [
  { nome: 'Corte', slots: 1, online: true, preco: 40 },
  { nome: 'Barba', slots: 1, online: true, preco: 30 },
  { nome: 'Combo', slots: 2, online: true, preco: 65 },
]);

// Tenta conectar Postgres se DATABASE_URL existir
let pgPool = null;
if (process.env.DATABASE_URL) {
  try {
    const { Pool } = require('pg');
    pgPool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
    console.log('✅ Postgres conectado');
    // Anexa no req para tenant.js usar
    app.use((req, _res, next) => { req.db = pgPool; next(); });
  } catch (e) {
    console.warn('⚠️  pg não instalado ou DATABASE_URL inválido, usando memória:', e.message);
  }
}

// ===== HELPERS =====
function getTenantId(req) {
  // Preview e2b.app: permite ?tenant=demo ou ?host=brbpro.com.br para testar
  if (req.query.tenant) return req.query.tenant;
  if (req.query.host) {
    const h = req.query.host;
    if (h.includes('brbpro.com.br')) {
      const parts = h.split('.');
      if (h === 'brbpro.com.br' || h === 'www.brbpro.com.br') return 'artnaregua';
      return parts[0];
    }
  }
  return req.tenantId || 'artnaregua'; // fallback demo
}

// Versão para auto-update (troque a cada deploy)
const VERSAO = process.env.RENDER_GIT_COMMIT || Date.now().toString(36);

// ===== APIs PÚBLICAS (por barbearia) =====
app.get('/api/versao', (req, res) => {
  res.json({ ok: true, versao: VERSAO, tenant: req.tenantSlug || null });
});

app.get('/api/servicos', (req, res) => {
  const tid = getTenantId(req);
  let servicos = DB.servicos.get(tid);
  if (!servicos && pgPool) {
    // TODO: SELECT * FROM servicos WHERE tenant_id=$1
    servicos = DB.servicos.get('artnaregua');
  }
  if (!servicos) servicos = DB.servicos.get('artnaregua');
  res.json({ ok: true, servicos, tenant: tid });
});

app.get('/api/slots', (req, res) => {
  const { data } = req.query;
  if (!data) return res.status(400).json({ ok: false, error: 'Informe a data' });
  // Mock: todos disponíveis de terça a sábado, fechado seg/dom
  const d = new Date(data + 'T12:00:00');
  const day = d.getDay(); // 0 dom, 1 seg
  const fechado = (day === 0 || day === 1);
  const slots = fechado ? [] : [
    { horario: '08:40', disponivel: Math.random() > 0.3 },
    { horario: '09:20', disponivel: Math.random() > 0.3 },
    { horario: '10:00', disponivel: true },
    { horario: '10:40', disponivel: true },
    { horario: '11:20', disponivel: true },
    { horario: '13:00', disponivel: true },
    { horario: '13:40', disponivel: true },
    { horario: '14:20', disponivel: true },
    { horario: '15:00', disponivel: true },
    { horario: '15:40', disponivel: true },
    { horario: '16:20', disponivel: true },
    { horario: '17:00', disponivel: true },
  ];
  res.json({ ok: true, data, fechado, slots, tenant: getTenantId(req) });
});

app.get('/api/faq', (req, res) => {
  const tid = getTenantId(req);
  // FAQ corrigido (sem "COMPLETAR" e sem inconsistência)
  const faq = [
    { q: 'Preciso agendar ou posso chegar direto?', a: 'Agende pelo site ou WhatsApp para garantir seu horário. Encaixes só se houver vaga.' },
    { q: 'Quanto tempo dura cada serviço?', a: 'Corte e barba ~40min. Combos e pigmentação ~80min (2 slots).' },
    { q: 'Preciso chegar com antecedência?', a: 'Chegue 10 min antes. Temos tolerância de 10 min; após isso, reagendamos sem custo para não atrasar o próximo cliente. Se for atrasar, chama no WhatsApp que a gente remaneja.' },
    { q: 'Tem estacionamento ou é fácil parar por perto?', a: 'Sim! Na R. Padre Rolim há vagas na rua em frente e nas transversais. Programe 5 min para estacionar — se estiver cheio, avise no WhatsApp que seguramos seu horário por 10 min.' },
    { q: 'Quais formas de pagamento?', a: 'PIX, dinheiro e cartão. Preço transparente, sem taxa escondida.' },
    { q: 'O que é “Nevou”?', a: 'Descoloração global — loiro platinado. Valor R$160, dura ~2h. Agende com antecedência.' },
  ];
  res.json({ ok: true, faq, tenant: tid });
});

app.get('/api/fotos/categorias', (req,res)=>{
  res.json({ ok:true, categorias: ['cortes','barba','ambiente'] });
});
app.get('/api/fotos', (req,res)=>{
  const { categoria } = req.query;
  if(!categoria) return res.status(400).json({ ok:false, error:'Informe a categoria.' });
  // Mock fotos (usa origin)
  const fotos = Array.from({length:6}, (_,i)=> ({ id: i+1, url: `/api/foto/${i+1}`, categoria }));
  res.json({ ok:true, fotos });
});
// Proxy de fotos para origin (evita copiar todas)
app.get('/api/foto/:id', async (req,res)=>{
  try{
    const r = await fetch(`${ORIGIN}/api/foto/${req.params.id}`);
    if(!r.ok) return res.status(r.status).send('Foto não encontrada');
    res.setHeader('Content-Type', r.headers.get('content-type') || 'image/jpeg');
    res.setHeader('Cache-Control', 'public, max-age=86400');
    const buf = Buffer.from(await r.arrayBuffer());
    res.send(buf);
  }catch(e){ res.status(500).json({ok:false, error:'Erro ao buscar foto'})}
});

app.post('/api/agendar', (req,res)=>{
  const { servico, data, horario, nome, whatsapp } = req.body;
  if(!servico || !data || !horario || !nome || !whatsapp) return res.status(400).json({ok:false, error:'Preencha todos os campos'});
  const tid = getTenantId(req);
  // Validação simples
  if(!/^\d{10,13}$/.test(String(whatsapp).replace(/\D/g,''))) return res.status(400).json({ok:false, error:'WhatsApp inválido'});
  // Mock salva
  const key = `${tid}:${data}`;
  if(!DB.agendamentos.has(key)) DB.agendamentos.set(key, []);
  DB.agendamentos.get(key).push({ servico, horario, nome, whatsapp, tenant: tid, createdAt: new Date().toISOString() });
  console.log(`[AGENDAR] ${tid} ${data} ${horario} ${nome} ${servico}`);
  res.json({ ok:true, message:'Agendado! Confirme no WhatsApp.', tenant: tid });
});

app.post('/api/contato', (req,res)=>{
  // Mock contato → abre WhatsApp
  res.json({ ok:true, message:'Mensagem recebida! Em breve retornamos no WhatsApp.' });
});

// ===== AUTH =====
app.post('/api/admin/login', loginLimiter, async (req,res)=>{
  // Se tiver Postgres, usa handleLogin com DB; senão, fallback simples
  if(pgPool){
    req.tenantId = getTenantId(req); // para lookup
    return handleLogin(req,res, pgPool);
  }
  // Fallback memória: aceita ADMIN_SENHA ou email+senha mock
  const { senha, email } = req.body;
  const expected = process.env.ADMIN_SENHA || 'vitinh@continue';
  // Aceita email também (demo)
  if(email){
    if(senha !== expected) return res.status(401).json({ok:false, error:'Senha incorreta.'});
    const user = { id: 'demo', tenant_id: getTenantId(req), role: 'owner', email, nome: 'Dono Demo' };
    setAuthCookies(res, user);
    return res.json({ ok:true, nome: user.nome, tenant: user.tenant_id });
  }
  if(!senha) return res.status(400).json({ok:false, error:'Informe a senha.'});
  if(senha !== expected) return res.status(401).json({ok:false, error:'Senha incorreta.'});
  const user = { id: 'legacy', tenant_id: getTenantId(req), role: 'owner', email: 'legacy@brbpro.com.br', nome: 'Admin' };
  setAuthCookies(res, user);
  res.json({ ok:true, nome: user.nome, tenant: user.tenant_id });
});

app.post('/api/admin/logout', (req,res)=>{
  clearAuthCookies(res);
  res.json({ ok:true });
});

app.get('/api/admin/me', requireAuth, (req,res)=>{
  res.json({ ok:true, user: req.user });
});

// ===== APIs ADMIN PROTEGIDAS =====
app.get('/api/admin/resumo', requireAuth, requireTenantOwner, (req,res)=>{
  const tid = getTenantId(req);
  res.json({ ok:true, tenant: tid, resumo: { agendamentosHoje: 4, clientes: 128, caixaMes: 3420, estoqueBaixo: 2 } });
});
app.get('/api/admin/logs', requireAuth, requireTenantOwner, (req,res)=>{
  res.json({ ok:true, logs: [{ data: new Date().toISOString(), acao: 'login', usuario: req.user.email }] });
});
// Adicione aqui suas outras rotas admin (clientes, caixa, estoque, etc.) filtrando por tenant_id

// ===== ESTÁTICOS =====
// Landing BRB Pro
app.use('/brb-landing', express.static(path.join(__dirname, 'brbpro-landing')));

// Painel admin (se tiver pasta public/admin localmente)
app.use('/admin', express.static(path.join(__dirname, 'public/admin')));
app.use('/css', express.static(path.join(__dirname, 'public/css')));
app.use('/js', express.static(path.join(__dirname, 'public/js')));
app.use('/images', express.static(path.join(__dirname, 'public/images')));
app.use('/video', express.static(path.join(__dirname, 'public/video')));

// Fallback proxy para assets não encontrados localmente (busca no origin)
app.use(async (req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  // Tenta servir arquivo local
  const localPath = path.join(__dirname, 'public', req.path);
  if (fs.existsSync(localPath) && fs.statSync(localPath).isFile()) {
    return res.sendFile(localPath);
  }
  // Se for asset (css/js/png/jpg/mp4) e não existe local, proxy para origin
  if (/\.(css|js|png|jpg|jpeg|webp|mp4|svg|woff2?)$/.test(req.path)) {
    try {
      const r = await fetch(`${ORIGIN}${req.path}`);
      if (r.ok) {
        res.setHeader('Content-Type', r.headers.get('content-type') || 'application/octet-stream');
        res.setHeader('Cache-Control', 'public, max-age=3600');
        const buf = Buffer.from(await r.arrayBuffer());
        return res.send(buf);
      }
    } catch {}
  }
  next();
});

// ===== ROTAS DE PÁGINA (HTML) =====
app.get('/admin/login.html', (req,res)=>{
  // Se já tem pasta public/admin/login.html local, serve; senão proxy
  const p = path.join(__dirname, 'public/admin/login.html');
  if (fs.existsSync(p)) return res.sendFile(p);
  // Proxy para origin (mantém login funcionando até migrar front para cookie)
  fetch(`${ORIGIN}/admin/login.html`).then(r=>r.text()).then(html=>{
    // Injeta credentials: include no fetch de login (hotfix)
    const patched = html.replace(
      "fetch('/api/admin/login'",
      "fetch('/api/admin/login', { credentials: 'include' }".replace("{ credentials: 'include' }","{ method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }")
    ).replace(
      "fetch('/api/admin/login', {",
      "fetch('/api/admin/login', { credentials: 'include',"
    );
    res.setHeader('Content-Type','text/html; charset=UTF-8');
    res.send(patched);
  }).catch(()=> res.redirect(ORIGIN+'/admin/login.html'));
});

// Home — decide: landing, app ou barbearia
app.get('/', (req,res)=>{
  if (req.isLanding) {
    // brbpro.com.br → landing de vendas
    return res.sendFile(path.join(__dirname, 'brbpro-landing/index.html'));
  }
  if (req.isApp) {
    // app.brbpro.com.br → painel
    const p = path.join(__dirname, 'public/admin/login.html');
    if (fs.existsSync(p)) return res.redirect('/admin/login.html');
    return res.redirect('/admin/login.html');
  }
  if (req.tenant) {
    // *.brbpro.com.br → site da barbearia
    const p = path.join(__dirname, 'public/index.html');
    if (fs.existsSync(p)) {
      // Se tiver index tenant-aware, serve; injeta tenant no HTML via script
      let html = fs.readFileSync(p, 'utf8');
      // Injeta config tenant para JS usar
      html = html.replace('</head>', `<script>window.BRB_TENANT=${JSON.stringify(req.tenant)};</script></head>`);
      res.setHeader('Content-Type','text/html; charset=UTF-8');
      return res.send(html);
    }
    // Fallback: proxy para origin e troca nome/whatsapp dinamicamente
    fetch(`${ORIGIN}/`).then(r=>r.text()).then(html=>{
      const t = req.tenant;
      // Troca básica de marca (se quiser, expanda para EJS)
      // html = html.replace(/Art na Régua/g, t.nome);
      html = html.replace('</head>', `<script>window.BRB_TENANT=${JSON.stringify(t)}; console.log('BRB Pro tenant', window.BRB_TENANT);</script></head>`);
      res.setHeader('Content-Type','text/html; charset=UTF-8');
      res.send(html);
    }).catch(()=> res.status(500).send('Erro ao carregar site da barbearia'));
    return;
  }
  next();
});

// Healthcheck para Render
app.get('/health', (req,res)=> res.json({ ok:true, tenant: req.tenantSlug || 'landing', versao: VERSAO }));

// 404 amigável
app.use((req,res)=>{
  if (req.path.startsWith('/api/')) return res.status(404).json({ ok:false, error:'Rota não encontrada' });
  res.status(404).send(`
    <html style="font-family:system-ui;background:#07080A;color:#F2F0EC;text-align:center;padding:60px">
      <h1 style="color:#C9A86A">404 — Página não encontrada</h1>
      <p><a href="/" style="color:#C9A86A">← Voltar ao início</a> • <a href="https://brbpro.com.br" style="color:#C9A86A">brbpro.com.br</a></p>
    </html>
  `);
});

app.listen(PORT, '0.0.0.0', ()=>{
  console.log(`✅ BRB Pro rodando na porta ${PORT}`);
  console.log(`   Landing: http://localhost:${PORT} (Host: brbpro.com.br)`);
  console.log(`   Barbearia: http://artnaregua.localhost:${PORT} (adicione no /etc/hosts)`);
  console.log(`   App: http://app.localhost:${PORT}/admin/login.html`);
  console.log(`   Tenant atual (sem Host): fallback artnaregua`);
});
