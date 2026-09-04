/**
 * BRB Pro — Backend Multi-Tenant (Modelo B / SaaS)
 * =====================================================
 * - brbpro.com.br        → landing de vendas
 * - app.brbpro.com.br    → painel master (administra todas as barbearias)
 * - *.brbpro.com.br      → site de cada barbearia (tenant)
 *
 * Stack: Node + Express + helmet + pg (Neon) + bcrypt + jsonwebtoken
 * Custo: R$ 0 (Render Free + Neon Free + Cloudflare Free)
 *
 * Segurança:
 *  - Isolamento de tenant por subdomínio (nunca deixa vazar dados entre barbearias)
 *  - Auth por cookie HttpOnly + JWT curto + bcrypt
 *  - Todas as queries parametrizadas (anti-SQLi), saída escapada (anti-XSS)
 *  - Rate limit por IP com teto de memória
 *  - LGPD: coleta mínima + logs
 */

require('dotenv').config();
const path = require('path');
const crypto = require('crypto');
const fs = require('fs');
const express = require('express');
const helmet = require('helmet');
const cookieParser = require('cookie-parser');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');

const app = express();
const PORT = process.env.PORT || 3000;
const VERSAO = process.env.RENDER_GIT_COMMIT || '1.0.0';

/* ============================ SEGREDOS (nunca padrão) ============================ */
const JWT_SECRET = process.env.JWT_SECRET || crypto.randomBytes(48).toString('hex');
if (!process.env.JWT_SECRET) console.warn('AVISO: JWT_SECRET não definido → sessões invalidadas a cada restart. Defina no Render.');
const JWT_EXPIRES = '30m';
const REFRESH_EXPIRES = '7d';
const COOKIE_SECURE = process.env.NODE_ENV === 'production' || process.env.COOKIE_SECURE === 'true' || !!process.env.RENDER;

/* ============================ BANCO (Neon) ============================ */
let pool = null;
if (process.env.DATABASE_URL) {
  const { Pool } = require('pg');
  pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
    max: 8,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 9000,
  });
  pool.on('error', (e) => console.error('[pg]', e.message));
}
function semBanco(res) { return res.status(503).json({ ok: false, error: 'Banco não configurado.' }); }

/* ============================ MIDDLEWARES ============================ */
app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(helmet({
  contentSecurityPolicy: {
    useDefaults: true,
    directives: {
      'default-src': ["'self'"],
      'script-src': ["'self'", "'unsafe-inline'"],
      'style-src': ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
      'font-src': ["'self'", 'https://fonts.gstatic.com'],
      'img-src': ["'self'", 'data:', 'https:', 'blob:'],
      'media-src': ["'self'", 'https:', 'blob:', 'data:'],
      'connect-src': ["'self'", 'https:', 'http:'],
      'worker-src': ["'self'", 'blob:'],
      'object-src': ["'none'"],
      'frame-ancestors': ["'self'"],
      'base-uri': ["'self'"],
      'form-action': ["'self'"],
    },
  },
  referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
  crossOriginEmbedderPolicy: false,
}));
app.use(cookieParser());
app.use(express.json({ limit: '25mb' }));
app.use(express.urlencoded({ extended: true }));

// CORS restrito ao próprio domínio
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && /\.brbpro\.com\.br$/.test(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Vary', 'Origin');
  }
  next();
});

/* ============================ RATE LIMIT (com teto de memória) ============================ */
const hits = new Map();
const HITS_MAX = 20000;
function rateLimit(max, windowMs) {
  return (req, res, next) => {
    const ip = req.ip || req.socket.remoteAddress || 'unknown';
    const now = Date.now();
    const rec = hits.get(ip) || { count: 0, start: now };
    if (now - rec.start > windowMs) { rec.count = 0; rec.start = now; }
    rec.count += 1;
    hits.set(ip, rec);
    if (hits.size > HITS_MAX) {
      for (const [k, v] of hits) {
        if (now - v.start > Math.max(windowMs, 10 * 60 * 1000)) hits.delete(k);
        if (hits.size <= HITS_MAX * 0.8) break;
      }
    }
    if (rec.count > max) return res.status(429).json({ ok: false, error: 'Muitas requisições. Aguarde um instante.' });
    next();
  };
}
const rlLogin = rateLimit(10, 15 * 60 * 1000);
const rlGeral = rateLimit(120, 60 * 1000);

// Resolve o tenant (landing / app / subdomínio de barbearia) ANTES de todas as rotas
app.use(tenantResolver);

/* ============================ RESOLUÇÃO DE TENANT ============================ */
const RESERVED = new Set(['app', 'www', 'admin', 'painel', 'api', 'mail', 'ws']);
function getSlugFromHost(hostname) {
  if (!hostname) return null;
  hostname = hostname.split(':')[0].toLowerCase();
  if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname.endsWith('.local')) return null;
  if (hostname.endsWith('.localhost')) return hostname.split('.')[0];
  // Header de host original (via Cloudflare Worker) tem prioridade
  return null; // resolvido abaixo usando req
}
let TENANT_CACHE = new Map();
let TENANT_EXP = 0;
// Invalida imediatamente a cache de um tenant (usado quando o gestor ativa/bloqueia).
// Isso faz o site sair/voltar do ar na hora, sem a espera de 60s da cache.
function invalidarTenant(slug) {
  if (slug) TENANT_CACHE.delete(slug);
  TENANT_EXP = 0; // obriga o próximo lookup a reconsultar o banco
}
async function lookupTenant(slug) {
  if (!pool) return null;
  if (TENANT_EXP > Date.now() && TENANT_CACHE.has(slug)) return TENANT_CACHE.get(slug);
  const r = await pool.query('SELECT * FROM barbershops WHERE slug=$1 AND ativo=TRUE', [slug]);
  const t = r.rows[0] || null;
  TENANT_CACHE.set(slug, t);
  TENANT_EXP = Date.now() + 60000;
  return t;
}
async function tenantResolver(req, res, next) {
  try {
    // Preview/segurança: permite forçar um tenant via ?tenant=slug (para demonstrar o produto)
    const qTenant = req.query && req.query.tenant ? String(req.query.tenant).toLowerCase().replace(/[^a-z0-9-]/g, '') : '';
    const fwd = req.headers['x-forwarded-host'] || req.headers['x-brb-original-host'] || '';
    const host = (String(fwd).split(':')[0] || req.hostname || req.headers.host || '').toLowerCase();
    if (qTenant && qTenant !== 'app' && qTenant !== 'www' && !RESERVED.has(qTenant)) {
      const tenant = await lookupTenant(qTenant);
      if (tenant) {
        req.tenant = tenant; req.tenantId = tenant.id; req.tenantSlug = tenant.slug;
        req.isLanding = false; req.isApp = false;
        res.setHeader('X-BRB-Tenant', tenant.slug);
        return next();
      }
    }
    // a partir do host decide landing/app/tenant
    if (host === 'brbpro.com.br' || host === 'www.brbpro.com.br' || host === 'localhost' || host === '127.0.0.1' || host.endsWith('.e2b.app') || host.endsWith('.e2b.dev') || host.endsWith('.onrender.com')) {
      req.tenantId = null; req.tenantSlug = null; req.tenant = null;
      req.isLanding = true; req.isApp = false;
      return next();
    }
    if (host.endsWith('.brbpro.com.br')) {
      const slug = host.split('.')[0];
      if (RESERVED.has(slug)) {
        req.tenantId = null; req.tenantSlug = slug; req.tenant = null;
        req.isLanding = false; req.isApp = (slug === 'app');
        return next();
      }
      const tenant = await lookupTenant(slug);
      if (!tenant) {
        // Site bloqueado/inativo → 404 com no-store p/ não ser cacheado e refletir na hora
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('CDN-Cache-Control', 'no-store');
        return res.status(404).send(build404(slug));
      }
      req.tenant = tenant; req.tenantId = tenant.id; req.tenantSlug = tenant.slug;
      req.isLanding = false; req.isApp = false;
      res.setHeader('X-BRB-Tenant', tenant.slug);
      return next();
    }
    req.tenantId = null; req.tenantSlug = null; req.tenant = null;
    req.isLanding = true; req.isApp = false;
    next();
  } catch (e) { next(e); }
}
function build404(slug) {
  return `<html style="font-family:system-ui;background:#07080A;color:#F2F0EC;text-align:center;padding:60px">
    <h1 style="color:#C9A86A">Barbearia não encontrada</h1>
    <p>O endereço <b>${esc(slug)}.brbpro.com.br</b> ainda não existe.</p>
    <p><a href="https://brbpro.com.br" style="color:#C9A86A">→ Criar minha barbearia em 48h</a></p></html>`;
}

/* ============================ HELPERS ============================ */
// Injeta a versão do deploy nos assets (?v=NUM -> ?v=<commit>) p/ nunca ficar com JS/CSS antigo
function vAssets(html) {
  const v = (VERSAO || '1').replace(/[^a-z0-9]/gi, '').slice(0, 10) || '1';
  return html.replace(/(\?v=)[0-9a-z]+/gi, '$1' + v);
}

function esc(s) { return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;'); }
function validarDataISO(s) {
  const str = String(s || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(str)) return false;
  const [y, m, d] = str.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}
function validarMes(s) {
  const str = String(s || '');
  if (!/^\d{4}-\d{2}$/.test(str)) return false;
  const m = parseInt(str.slice(5, 7), 10);
  return m >= 1 && m <= 12;
}
function validarEmail(s) { return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(String(s || '').trim()); }
function validarTelefone(s) { return /^\d{10,13}$/.test(String(s || '').replace(/\D/g, '')); }
function toNum(v) { const n = parseFloat(String(v).replace(',', '.')); return n; }
function valorValido(v) { const n = toNum(v); return !isNaN(n) && isFinite(n) && n >= 0; }
function hojeBR() { const d = new Date(); d.setHours(d.getHours() - 3); return d.toISOString().slice(0, 10); }
function uidOrNull(v) { const n = parseInt(v, 10); return isNaN(n) && !/^[0-9a-f-]{36}$/i.test(String(v || '')) ? null : String(v); }

/* ============================ GC de logs (leve) ============================ */
async function registrarLog(req, tipo, acao, detalhe) {
  if (!pool) return;
  try {
    const usuario = (req && req.user) ? req.user.email : 'publico';
    const ip = (req && (req.ip || req.socket.remoteAddress)) || '';
    await pool.query('INSERT INTO logs (tenant_id, tipo, acao, detalhe, usuario, ip) VALUES ($1,$2,$3,$4,$5,$6)',
      [req.tenantId || null, tipo, acao, String(detalhe || '').slice(0, 500), usuario, ip]);
  } catch (e) { console.error('[log]', e.message); }
}

/* ============================ AUTH (cookie + JWT) ============================ */
function signToken(payload, exp = JWT_EXPIRES) { return jwt.sign(payload, JWT_SECRET, { expiresIn: exp }); }
function setAuthCookies(res, user) {
  const tok = signToken({ id: user.id, tenantId: user.tenant_id, role: user.role, email: user.email, nome: user.nome });
  res.cookie('brb_token', tok, { httpOnly: true, secure: COOKIE_SECURE, sameSite: 'lax', path: '/', maxAge: 30 * 60 * 1000 });
  res.cookie('brb_refresh', signToken({ id: user.id, type: 'refresh' }, REFRESH_EXPIRES),
    { httpOnly: true, secure: COOKIE_SECURE, sameSite: 'lax', path: '/', maxAge: 7 * 24 * 3600 * 1000 });
}
function clearAuthCookies(res) { res.clearCookie('brb_token', { path: '/' }); res.clearCookie('brb_refresh', { path: '/' }); }
function requireAuth(req, res, next) {
  const token = req.cookies && req.cookies['brb_token'];
  if (!token) return res.status(401).json({ ok: false, error: 'Não autorizado. Faça login novamente.' });
  try { req.user = jwt.verify(token, JWT_SECRET); next(); }
  catch { return res.status(401).json({ ok: false, error: 'Sessão expirada. Faça login novamente.' }); }
}
// Garante que o dono do panel veja apenas o próprio tenant (ou master vê tudo)
function requireTenantOwner(req, res, next) {
  if (!req.user) return res.status(401).json({ ok: false, error: 'Não autorizado.' });
  const isMaster = req.user.role === 'master';
  if (isMaster && req.isApp) return next();
  if (req.tenantId && req.user.tenantId && req.user.tenantId !== req.tenantId) {
    return res.status(403).json({ ok: false, error: 'Acesso negado a esta barbearia.' });
  }
  // admin do tenant acessa via painel do tenant
  return next();
}

/* ============================ API PÚBLICA POR TENANT ============================ */
app.get('/api/saude', (req, res) => res.json({ ok: true, banco: !!pool, tenant: req.tenantSlug || null, hora: new Date().toISOString() }));
app.get('/health', (req, res) => res.json({ ok: true, tenant: req.tenantSlug || 'landing', versao: VERSAO, banco: !!pool }));
app.get('/api/versao', (req, res) => { res.setHeader('Cache-Control', 'no-store'); res.json({ ok: true, versao: VERSAO, tenant: req.tenantSlug || null }); });

// Config pública da barbearia (nome, whatsapp, endereço, horário, social) — para o site do tenant
app.get('/api/config', rlGeral, (req, res) => {
  if (!req.tenant) return res.status(400).json({ ok: false, error: 'Barbearia não identificada.' });
  const t = req.tenant;
  res.json({
    ok: true,
    barbearia: {
      nome: t.nome, whatsapp: t.whatsapp, instagram: t.instagram, endereco: t.endereco,
      cidade: t.cidade, estado: t.estado, cep: t.cep, horario: t.horario,
      tema: t.tema, cor_primaria: t.cor_primaria || '#C9A86A', cor_secundaria: t.cor_secundaria || '#B08D57',
      plano: t.plano,
      slogan: t.slogan || '', hero_titulo: t.hero_titulo || '', hero_sub: t.hero_sub || '',
      sobre_texto: t.sobre_texto || '', logo: t.logo || '', video_hero: t.video_hero || '',
      hero_imagem: t.hero_imagem || '',
      tem_midia: true,
    },
  });
});

// Serviços online do tenant
app.get('/api/servicos', rlGeral, async (req, res) => {
  if (!pool) return semBanco(res);
  if (!req.tenantId) return res.status(400).json({ ok: false, error: 'Barbearia não identificada.' });
  const r = await pool.query('SELECT nome, preco, slots FROM servicos WHERE tenant_id=$1 AND ativo=TRUE AND online=TRUE ORDER BY ordem, nome', [req.tenantId]);
  res.json({ ok: true, servicos: r.rows.map(s => ({ nome: s.nome, slots: s.slots, preco: s.preco == null ? null : Number(s.preco) })) });
});

// Grade de horários por dia
function slotsDoDia(dataISO, tenant) {
  const d = new Date(dataISO + 'T12:00:00');
  const w = d.getDay(); // 0 dom .. 6 sáb
  const base = (tenant && tenant.horario) ? tenant.horario : {};
  // horários padrão (subdomínio), senão fallback
  let slots = [];
  if (Array.isArray(tenant && tenant.slots_semana) && tenant.slots_semana.length) {
    slots = tenant.slots_semana;
  } else if (w === 6) {
    slots = ['08:40','09:20','10:00','10:40','11:20','13:00','13:40','14:20','15:00','15:40','16:20','17:00'];
  } else if (w >= 2 && w <= 5) {
    slots = ['08:40','09:20','10:00','10:40','11:20','13:00','13:40','14:20','15:00','16:20','17:00','17:40','18:20','19:00'];
  } else {
    return []; // fechado (se não definido)
  }
  // já cobre a regra do JSONB de horário apenas para compat; mantém grade fixa acima
  return slots;
}
function ocupadosDoDia(rows, slots) {
  const ocupado = new Set();
  rows.forEach((r) => {
    ocupado.add(r.horario);
    if (Number(r.num_slots) >= 2) {
      const i = slots.indexOf(r.horario);
      if (i >= 0 && i + 1 < slots.length) ocupado.add(slots[i + 1]);
    }
  });
  return ocupado;
}
app.get('/api/slots', rlGeral, async (req, res) => {
  if (!pool) return semBanco(res);
  if (!req.tenantId) return res.status(400).json({ ok: false, error: 'Barbearia não identificada.' });
  const data = String(req.query.data || '').trim();
  if (!validarDataISO(data)) return res.status(400).json({ ok: false, error: 'Data inválida.' });
  const slots = slotsDoDia(data, req.tenant);
  if (!slots.length) return res.json({ ok: true, data, fechado: true, slots: [] });
  const r = await pool.query("SELECT horario, num_slots FROM agendamentos WHERE tenant_id=$1 AND data=$2 AND status <> 'cancelado'", [req.tenantId, data]);
  const ocupado = ocupadosDoDia(r.rows, slots);
  res.json({ ok: true, data, fechado: false, slots: slots.map(h => ({ horario: h, disponivel: !ocupado.has(h) })) });
});

// Agendar
app.post('/api/agendar', rlGeral, async (req, res) => {
  if (!pool) return semBanco(res);
  if (!req.tenantId) return res.status(400).json({ ok: false, error: 'Barbearia não identificada.' });
  if (req.body && req.body.website) return res.json({ ok: true, recebido: false });
  const nome = esc((req.body.nome || '').trim()).slice(0, 80);
  const whatsapp = String(req.body.whatsapp || '').replace(/\D/g, '');
  const servico = esc((req.body.servico || '').trim());
  const data = String(req.body.data || '').trim();
  const horario = String(req.body.horario || '').trim();
  const obs = esc((req.body.obs || '').trim()).slice(0, 300);
  if (nome.length < 2) return res.status(400).json({ ok: false, error: 'Informe seu nome.' });
  if (!validarTelefone(whatsapp)) return res.status(400).json({ ok: false, error: 'Informe um WhatsApp válido com DDD.' });
  if (!validarDataISO(data)) return res.status(400).json({ ok: false, error: 'Data inválida.' });
  if (data < hojeBR()) return res.status(400).json({ ok: false, error: 'Não é possível agendar em data passada.' });
  const svc = (await pool.query('SELECT nome, slots, preco FROM servicos WHERE tenant_id=$1 AND nome=$2 AND ativo=TRUE AND online=TRUE', [req.tenantId, servico])).rows[0];
  if (!svc) return res.status(400).json({ ok: false, error: 'Serviço inválido.' });
  const slots = slotsDoDia(data, req.tenant);
  if (!slots.length) return res.status(400).json({ ok: false, error: 'A barbearia não abre neste dia.' });
  const idx = slots.indexOf(horario);
  if (idx < 0) return res.status(400).json({ ok: false, error: 'Horário inválido para este dia.' });
  if (idx + svc.slots - 1 >= slots.length) return res.status(400).json({ ok: false, error: 'Não há horários seguidos suficientes.' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const r = await client.query("SELECT horario, num_slots FROM agendamentos WHERE tenant_id=$1 AND data=$2 AND status <> 'cancelado' FOR UPDATE", [req.tenantId, data]);
    const ocupado = ocupadosDoDia(r.rows, slots);
    for (let k = 0; k < svc.slots; k++) {
      if (ocupado.has(slots[idx + k])) { await client.query('ROLLBACK'); return res.status(409).json({ ok: false, conflito: true, error: `O horário ${slots[idx + k]} acabou de ser reservado.` }); }
    }
    await client.query(
      'INSERT INTO agendamentos (tenant_id, nome, whatsapp, servico, data, horario, obs, origem, num_slots, valor) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
      [req.tenantId, nome, whatsapp, servico, data, horario, obs, 'site', svc.slots, svc.preco]);
    await client.query('COMMIT');
    registrarLog(req, 'agendamento', 'criado', `${nome} - ${servico} em ${data} ${horario}`);
    res.json({ ok: true, recebido: true, horarios: slots.slice(idx, idx + svc.slots) });
  } catch (e) {
    await client.query('ROLLBACK');
    if (e.code === '23505') return res.status(409).json({ ok: false, conflito: true, error: 'Este horário já está reservado.' });
    console.error('[agendar]', e.message);
    res.status(500).json({ ok: false, error: 'Erro interno.' });
  } finally { client.release(); }
});

// Contato
app.post('/api/contato', rlGeral, async (req, res) => {
  if (!pool) return semBanco(res);
  if (!req.tenantId) return res.status(400).json({ ok: false, error: 'Barbearia não identificada.' });
  if (req.body && req.body.website) return res.json({ ok: true, recebido: false });
  const nome = esc((req.body.nome || '').trim()).slice(0, 80);
  const contatoBruto = String(req.body.contato || '').trim();
  const mensagem = esc((req.body.mensagem || '').trim()).slice(0, 600);
  if (nome.length < 2) return res.status(400).json({ ok: false, error: 'Informe seu nome.' });
  if (mensagem.length < 5) return res.status(400).json({ ok: false, error: 'Escreva sua mensagem.' });
  let contato;
  if (validarEmail(contatoBruto)) contato = contatoBruto.slice(0, 100);
  else if (validarTelefone(contatoBruto)) contato = contatoBruto.replace(/\D/g, '');
  else return res.status(400).json({ ok: false, error: 'Informe um telefone ou e-mail válido.' });
  await pool.query('INSERT INTO contatos (tenant_id, nome, contato, mensagem, origem) VALUES ($1,$2,$3,$4,$5)', [req.tenantId, nome, contato, mensagem, 'site']);
  registrarLog(req, 'contato', 'mensagem', `Contato de ${nome}`);
  res.json({ ok: true, recebido: true });
});

// Galeria
app.get('/api/fotos/categorias', rlGeral, async (req, res) => {
  if (!pool) return semBanco(res);
  if (!req.tenantId) return res.status(400).json({ ok: false, error: 'Barbearia não identificada.' });
  const r = await pool.query('SELECT categoria, COUNT(*)::int AS qtd, MAX(id::text) AS capa_id FROM fotos WHERE tenant_id=$1 GROUP BY categoria ORDER BY categoria', [req.tenantId]);
  res.json({ ok: true, categorias: r.rows });
});
app.get('/api/fotos', rlGeral, async (req, res) => {
  if (!pool) return semBanco(res);
  if (!req.tenantId) return res.status(400).json({ ok: false, error: 'Barbearia não identificada.' });
  const cat = String(req.query.categoria || '').trim();
  if (!cat) return res.status(400).json({ ok: false, error: 'Informe a categoria.' });
  const r = await pool.query('SELECT id, tipo FROM fotos WHERE tenant_id=$1 AND categoria=$2 ORDER BY id DESC', [req.tenantId, cat]);
  res.json({ ok: true, categoria: cat, fotos: r.rows.map(x => ({ id: x.id, tipo: x.tipo || 'imagem' })) });
});
app.get('/api/foto/:id', async (req, res) => {
  if (!pool) return res.status(404).end();
  if (!req.tenantId) return res.status(404).end();
  const id = String(req.params.id || '');
  try {
    const r = await pool.query('SELECT imagem FROM fotos WHERE tenant_id=$1 AND id=$2', [req.tenantId, id]);
    if (!r.rows.length) return res.status(404).end();
    const m = /^data:([a-zA-Z0-9/+.-]+);base64,(.+)$/.exec(r.rows[0].imagem);
    if (!m) return res.status(500).end();
    const buf = Buffer.from(m[2], 'base64');
    res.setHeader('Content-Type', m[1]);
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    if (m[1].startsWith('video/')) { res.setHeader('Accept-Ranges', 'bytes'); res.setHeader('Content-Length', buf.length); }
    res.send(buf);
  } catch (e) { console.error('[foto]', e.message); res.status(500).end(); }
});
// Serve mídia de marca da barbearia (logo / hero_imagem / video_hero / intro) por URL,
// evitando embutir base64 pesado no HTML (deixa o site leve).
app.get('/m/:slug/:tipo', async (req, res) => {
  if (!pool) return res.status(404).end();
  const slug = String(req.params.slug || '').toLowerCase().replace(/[^a-z0-9-]/g, '');
  const tipo = String(req.params.tipo || '');
  const col = tipo === 'logo' ? 'logo' : tipo === 'hero' ? 'hero_imagem' : tipo === 'video' ? 'video_hero' : tipo === 'intro' ? 'intro_video' : null;
  if (!col || !slug) return res.status(404).end();
  try {
    const r = await pool.query('SELECT ' + col + ' AS m FROM barbershops WHERE slug=$1', [slug]);
    const m = r.rows[0] && r.rows[0].m;
    if (!m || typeof m !== 'string') return res.status(404).end();
    const match = /^data:([a-zA-Z0-9/+.-]+);base64,(.+)$/.exec(m);
    if (!match) return res.status(404).end();
    const buf = Buffer.from(match[2], 'base64');
    res.setHeader('Content-Type', match[1]);
    res.setHeader('Cache-Control', 'public, max-age=86400');
    if (match[1].startsWith('video/')) { res.setHeader('Accept-Ranges', 'bytes'); res.setHeader('Content-Length', buf.length); }
    res.send(buf);
  } catch (e) { res.status(404).end(); }
});

app.get('/api/faq', rlGeral, async (req, res) => {
  if (!pool) return semBanco(res);
  if (!req.tenantId) return res.status(400).json({ ok: false, error: 'Barbearia não identificada.' });
  const r = await pool.query('SELECT pergunta, resposta FROM faq WHERE tenant_id=$1 ORDER BY ordem, id', [req.tenantId]);
  res.json({ ok: true, faq: r.rows });
});

/* ============================ LOGIN (tenant ou master) ============================ */
function criarHash(senha) { return bcrypt.hashSync(senha, 12); }
function verificarHash(senha, hash) { try { return bcrypt.compareSync(senha, hash); } catch { return false; } }

app.post('/api/admin/login', rlLogin, async (req, res) => {
  if (!pool) return semBanco(res);
  const email = String(req.body.email || '').trim().toLowerCase();
  const senha = String(req.body.senha || '');
  if (!email || !senha) return res.status(400).json({ ok: false, error: 'Informe e-mail e senha.' });
  let user = null;
  // master: login via app.brbpro.com.br (sem tenant) → busca usuario master
  if (req.isApp || req.userRoleCheck) {
    const r = await pool.query('SELECT * FROM users WHERE email=$1 AND role=$2', [email, 'master']);
    user = r.rows[0] || null;
  }
  if (!user) {
    const tid = req.tenantId || (await pool.query("SELECT id FROM barbershops WHERE slug='artnaregua'")).rows?.[0]?.id;
    // aceita email+tenant, OU se acessar um subdomínio usa o tenant do subdomínio
    if (req.tenantId) {
      const r = await pool.query('SELECT * FROM users WHERE email=$1 AND tenant_id=$2', [email, req.tenantId]);
      user = r.rows[0] || null;
    }
    // fallback: busca por email global (permite master logar de qualquer lugar) — só se for master
    if (!user) {
      const r = await pool.query('SELECT * FROM users WHERE email=$1', [email]);
      const cand = r.rows[0] || null;
      if (cand && (cand.role === 'master' || (req.tenantId && cand.tenant_id === req.tenantId))) user = cand;
    }
  }
  if (!user) return res.status(401).json({ ok: false, error: 'Credenciais inválidas.' });
  if (!user.ativo) return res.status(401).json({ ok: false, error: 'Usuário desativado.' });
  if (!verificarHash(senha, user.senha_hash)) {
    registrarLog(req, 'login', 'falha', `Tentativa com ${email}`);
    return res.status(401).json({ ok: false, error: 'Credenciais inválidas.' });
  }
  setAuthCookies(res, user);
  registrarLog(req, 'login', 'sucesso', `Login ${email}`);
  res.json({ ok: true, nome: user.nome, email: user.email, role: user.role, tenant: user.tenant_id });
});
app.post('/api/admin/logout', (req, res) => { clearAuthCookies(res); res.json({ ok: true }); });
app.get('/api/admin/me', requireAuth, (req, res) => res.json({ ok: true, user: req.user }));

// Trocar senha
app.post('/api/admin/trocar-senha', requireAuth, rlLogin, async (req, res) => {
  if (!pool) return semBanco(res);
  const atual = String(req.body.senhaAtual || '');
  const nova = String(req.body.novaSenha || '');
  if (nova.length < 8) return res.status(400).json({ ok: false, error: 'A nova senha deve ter pelo menos 8 caracteres.' });
  const r = await pool.query('SELECT * FROM users WHERE id=$1', [req.user.id]);
  if (!r.rows.length) return res.status(401).json({ ok: false, error: 'Usuário não encontrado.' });
  if (!verificarHash(atual, r.rows[0].senha_hash)) return res.status(401).json({ ok: false, error: 'Senha atual incorreta.' });
  await pool.query('UPDATE users SET senha_hash=$1 WHERE id=$2', [criarHash(nova), req.user.id]);
  registrarLog(req, 'config', 'senha_alterada', 'Senha alterada');
  res.json({ ok: true });
});

/* ============================ ADMIN — TODAS AS ROTAS (por tenant) ============================ */
// Resumo
app.get('/api/admin/resumo', requireAuth, requireTenantOwner, async (req, res) => {
  if (!pool) return semBanco(res);
  const tid = req.user ? (req.user.tenantId || req.tenantId) : req.tenantId;
  if (!tid) return res.status(400).json({ ok: false, error: 'Tenant não identificado.' });
  const hoje = hojeBR();
  const [ag, caixa, estoque, clientes] = await Promise.all([
    pool.query("SELECT id, nome, servico, horario, num_slots, status, valor, pago FROM agendamentos WHERE tenant_id=$1 AND data=$2 AND status<>'cancelado' ORDER BY horario", [tid, hoje]),
    pool.query("SELECT COALESCE(SUM(valor) FILTER (WHERE tipo='entrada'),0) e, COALESCE(SUM(valor) FILTER (WHERE tipo='saida'),0) s FROM fluxo_caixa WHERE tenant_id=$1 AND data=$2", [tid, hoje]),
    pool.query('SELECT * FROM estoque WHERE tenant_id=$1 AND quantidade <= quantidade_minima ORDER BY produto', [tid]),
    pool.query('SELECT COUNT(*)::int c FROM clientes WHERE tenant_id=$1', [tid]),
  ]);
  res.json({ ok: true, hoje, agendamentos: ag.rows, caixa: { entradas: Number(caixa.rows[0].e) || 0, saidas: Number(caixa.rows[0].s) || 0 }, estoqueBaixo: estoque.rows, totalClientes: Number(clientes.rows[0].c) || 0 });
});

// AGENDA
app.get('/api/admin/agenda', requireAuth, requireTenantOwner, async (req, res) => {
  if (!pool) return semBanco(res);
  const tid = req.user.tenantId || req.tenantId;
  const inicio = String(req.query.inicio || '').trim(), fim = String(req.query.fim || '').trim();
  if (!validarDataISO(inicio) || !validarDataISO(fim)) return res.status(400).json({ ok: false, error: 'Período inválido.' });
  const r = await pool.query("SELECT * FROM agendamentos WHERE tenant_id=$1 AND data BETWEEN $2 AND $3 AND status <> 'cancelado' ORDER BY data, horario", [tid, inicio, fim]);
  res.json({ ok: true, agendamentos: r.rows });
});
app.post('/api/admin/agendamento', requireAuth, requireTenantOwner, async (req, res) => {
  if (!pool) return semBanco(res);
  const tid = req.user.tenantId || req.tenantId;
  const nome = esc((req.body.nome || '').trim()).slice(0, 80);
  const whatsapp = String(req.body.whatsapp || '').replace(/\D/g, '');
  const servico = esc((req.body.servico || '').trim());
  const data = String(req.body.data || '').trim(), horario = String(req.body.horario || '').trim();
  if (!validarDataISO(data)) return res.status(400).json({ ok: false, error: 'Data inválida.' });
  const svc = (await pool.query('SELECT nome, slots, preco FROM servicos WHERE tenant_id=$1 AND nome=$2', [tid, servico])).rows[0];
  const nSlots = svc ? svc.slots : 1;
  const slots = slotsDoDia(data, req.tenant);
  if (slots.indexOf(horario) < 0) return res.status(400).json({ ok: false, error: 'Horário fora da grade do dia.' });
  let valor = svc ? svc.preco : null;
  if (req.body.valor !== '' && req.body.valor != null) { if (!valorValido(req.body.valor)) return res.status(400).json({ ok: false, error: 'Valor inválido.' }); valor = toNum(req.body.valor); }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const r = await client.query("SELECT horario, num_slots FROM agendamentos WHERE tenant_id=$1 AND data=$2 AND status <> 'cancelado' FOR UPDATE", [tid, data]);
    const ocupado = ocupadosDoDia(r.rows, slots);
    const idx = slots.indexOf(horario);
    for (let k = 0; k < nSlots; k++) if (ocupado.has(slots[idx + k])) { await client.query('ROLLBACK'); return res.status(409).json({ ok: false, conflito: true, error: `Horário ocupado.` }); }
    const ins = await client.query('INSERT INTO agendamentos (tenant_id, nome, whatsapp, servico, data, horario, origem, num_slots, status, valor) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id',
      [tid, nome, whatsapp, servico, data, horario, 'admin', nSlots, 'confirmado', valor]);
    await client.query('COMMIT');
    registrarLog(req, 'agendamento', 'criado_admin', `${nome} - ${servico} ${data} ${horario}`);
    res.json({ ok: true, id: ins.rows[0].id });
  } catch (e) { await client.query('ROLLBACK'); if (e.code === '23505') return res.status(409).json({ ok: false, conflito: true, error: 'Já existe.' }); console.error(e.message); res.status(500).json({ ok: false, error: 'Erro interno.' }); }
  finally { client.release(); }
});
app.put('/api/admin/agendamento/:id', requireAuth, requireTenantOwner, async (req, res) => {
  if (!pool) return semBanco(res);
  const tid = req.user.tenantId || req.tenantId;
  const id = String(req.params.id);
  const nome = esc((req.body.nome || '').trim()).slice(0, 80);
  const servico = esc((req.body.servico || '').trim());
  const obs = esc((req.body.obs || '').trim()).slice(0, 300);
  let valor = null;
  if (req.body.valor !== '' && req.body.valor != null) { if (!valorValido(req.body.valor)) return res.status(400).json({ ok: false, error: 'Valor inválido.' }); valor = toNum(req.body.valor); }
  await pool.query('UPDATE agendamentos SET nome=$1, servico=$2, obs=$3, valor=$4 WHERE id=$5 AND tenant_id=$6', [nome, servico, obs, valor, id, tid]);
  res.json({ ok: true });
});
app.delete('/api/admin/agendamento/:id', requireAuth, requireTenantOwner, async (req, res) => {
  if (!pool) return semBanco(res);
  const tid = req.user.tenantId || req.tenantId;
  await pool.query("UPDATE agendamentos SET status='cancelado' WHERE id=$1 AND tenant_id=$2", [String(req.params.id), tid]);
  registrarLog(req, 'agendamento', 'cancelado', `#${req.params.id}`);
  res.json({ ok: true });
});
app.post('/api/admin/agendamento/:id/receber', requireAuth, requireTenantOwner, async (req, res) => {
  if (!pool) return semBanco(res);
  const tid = req.user.tenantId || req.tenantId;
  const id = String(req.params.id);
  const valor = toNum(req.body.valor);
  const forma = esc((req.body.forma_pagamento || '').trim()).slice(0, 30);
  if (!(valor >= 0)) return res.status(400).json({ ok: false, error: 'Valor inválido.' });
  if (!forma) return res.status(400).json({ ok: false, error: 'Informe a forma de pagamento.' });
  const ag = await pool.query('SELECT * FROM agendamentos WHERE id=$1 AND tenant_id=$2', [id, tid]);
  if (!ag.rows.length) return res.status(404).json({ ok: false, error: 'Agendamento não encontrado.' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("UPDATE agendamentos SET pago=TRUE, pago_em=now(), valor=$1, forma_pagamento=$2, status='confirmado' WHERE id=$3", [valor.toFixed(2), forma, id]);
    await client.query("INSERT INTO fluxo_caixa (tenant_id, data, tipo, categoria, descricao, valor, forma_pagamento) VALUES ($1,$2,'entrada','servico',$3,$4,$5)",
      [tid, ag.rows[0].data, `${ag.rows[0].nome} — ${ag.rows[0].servico}`, valor.toFixed(2), forma]);
    await client.query('COMMIT');
    registrarLog(req, 'caixa', 'recebimento', `${ag.rows[0].nome} R$${Number(valor).toFixed(2)}`);
    res.json({ ok: true });
  } catch (e) { await client.query('ROLLBACK'); console.error('[receber]', e.message); res.status(500).json({ ok: false, error: 'Erro.' }); }
  finally { client.release(); }
});

// CLIENTES
app.get('/api/admin/clientes', requireAuth, requireTenantOwner, async (req, res) => {
  if (!pool) return semBanco(res);
  const tid = req.user.tenantId || req.tenantId;
  const r = await pool.query('SELECT * FROM clientes WHERE tenant_id=$1 ORDER BY nome', [tid]);
  res.json({ ok: true, clientes: r.rows });
});
app.post('/api/admin/clientes', requireAuth, requireTenantOwner, async (req, res) => {
  if (!pool) return semBanco(res);
  const tid = req.user.tenantId || req.tenantId;
  const nome = esc((req.body.nome || '').trim()).slice(0, 80);
  const whatsapp = esc((req.body.whatsapp || '').trim()).slice(0, 20);
  const obs = esc((req.body.observacoes || '').trim()).slice(0, 300);
  if (nome.length < 2) return res.status(400).json({ ok: false, error: 'Informe o nome.' });
  const r = await pool.query('INSERT INTO clientes (tenant_id, nome, whatsapp, observacoes) VALUES ($1,$2,$3,$4) RETURNING id', [tid, nome, whatsapp, obs]);
  res.json({ ok: true, id: r.rows[0].id });
});
app.put('/api/admin/clientes/:id', requireAuth, requireTenantOwner, async (req, res) => {
  if (!pool) return semBanco(res);
  const tid = req.user.tenantId || req.tenantId;
  await pool.query('UPDATE clientes SET nome=$1, whatsapp=$2, observacoes=$3 WHERE id=$4 AND tenant_id=$5', [esc((req.body.nome||'').trim()).slice(0,80), esc((req.body.whatsapp||'').trim()).slice(0,20), esc((req.body.observacoes||'').trim()).slice(0,300), String(req.params.id), tid]);
  res.json({ ok: true });
});
app.delete('/api/admin/clientes/:id', requireAuth, requireTenantOwner, async (req, res) => {
  if (!pool) return semBanco(res);
  const tid = req.user.tenantId || req.tenantId;
  await pool.query('DELETE FROM clientes WHERE id=$1 AND tenant_id=$2', [String(req.params.id), tid]);
  res.json({ ok: true });
});

// CAIXA
app.get('/api/admin/caixa', requireAuth, requireTenantOwner, async (req, res) => {
  if (!pool) return semBanco(res);
  const tid = req.user.tenantId || req.tenantId;
  const inicio = String(req.query.inicio || '').trim(), fim = String(req.query.fim || '').trim();
  let r, resumo;
  if (validarDataISO(inicio) && validarDataISO(fim)) {
    r = await pool.query('SELECT * FROM fluxo_caixa WHERE tenant_id=$1 AND data BETWEEN $2 AND $3 ORDER BY data DESC, id DESC', [tid, inicio, fim]);
    resumo = await pool.query("SELECT COALESCE(SUM(valor) FILTER (WHERE tipo='entrada'),0) e, COALESCE(SUM(valor) FILTER (WHERE tipo='saida'),0) s FROM fluxo_caixa WHERE tenant_id=$1 AND data BETWEEN $2 AND $3", [tid, inicio, fim]);
  } else {
    r = await pool.query('SELECT * FROM fluxo_caixa WHERE tenant_id=$1 ORDER BY data DESC, id DESC LIMIT 200', [tid]);
    resumo = await pool.query("SELECT COALESCE(SUM(valor) FILTER (WHERE tipo='entrada'),0) e, COALESCE(SUM(valor) FILTER (WHERE tipo='saida'),0) s FROM fluxo_caixa WHERE tenant_id=$1", [tid]);
  }
  const e = Number(resumo.rows[0].e) || 0, s = Number(resumo.rows[0].s) || 0;
  res.json({ ok: true, lancamentos: r.rows, resumo: { entradas: e, saidas: s, saldo: e - s } });
});
app.post('/api/admin/caixa', requireAuth, requireTenantOwner, async (req, res) => {
  if (!pool) return semBanco(res);
  const tid = req.user.tenantId || req.tenantId;
  const data = String(req.body.data || '').trim();
  const tipo = req.body.tipo === 'saida' ? 'saida' : 'entrada';
  const descricao = esc((req.body.descricao || '').trim()).slice(0, 200);
  const valor = toNum(req.body.valor);
  const forma = esc((req.body.forma_pagamento || '').trim()).slice(0, 30);
  if (!validarDataISO(data)) return res.status(400).json({ ok: false, error: 'Data inválida.' });
  if (!(valor > 0)) return res.status(400).json({ ok: false, error: 'Valor inválido.' });
  const r = await pool.query('INSERT INTO fluxo_caixa (tenant_id, data, tipo, categoria, descricao, valor, forma_pagamento) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id', [tid, data, tipo, 'manual', descricao, valor.toFixed(2), forma]);
  res.json({ ok: true, id: r.rows[0].id });
});
app.delete('/api/admin/caixa/:id', requireAuth, requireTenantOwner, async (req, res) => {
  if (!pool) return semBanco(res);
  const tid = req.user.tenantId || req.tenantId;
  await pool.query('DELETE FROM fluxo_caixa WHERE id=$1 AND tenant_id=$2', [String(req.params.id), tid]);
  res.json({ ok: true });
});

// ESTOQUE
app.get('/api/admin/estoque', requireAuth, requireTenantOwner, async (req, res) => {
  if (!pool) return semBanco(res);
  const tid = req.user.tenantId || req.tenantId;
  const r = await pool.query('SELECT * FROM estoque WHERE tenant_id=$1 ORDER BY produto', [tid]);
  res.json({ ok: true, itens: r.rows });
});
app.post('/api/admin/estoque', requireAuth, requireTenantOwner, async (req, res) => {
  if (!pool) return semBanco(res);
  const tid = req.user.tenantId || req.tenantId;
  const produto = esc((req.body.produto || '').trim()).slice(0, 80);
  const quantidade = parseInt(req.body.quantidade, 10);
  const qmin = parseInt(req.body.quantidade_minima, 10);
  let custo = null, preco = null;
  if (req.body.custo !== '' && req.body.custo != null) { if (!valorValido(req.body.custo)) return res.status(400).json({ ok: false, error: 'Custo inválido.' }); custo = toNum(req.body.custo); }
  if (req.body.preco_venda !== '' && req.body.preco_venda != null) { if (!valorValido(req.body.preco_venda)) return res.status(400).json({ ok: false, error: 'Preço inválido.' }); preco = toNum(req.body.preco_venda); }
  const r = await pool.query('INSERT INTO estoque (tenant_id, produto, quantidade, quantidade_minima, custo, preco_venda) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id', [tid, produto, quantidade, qmin, custo, preco]);
  res.json({ ok: true, id: r.rows[0].id });
});
app.put('/api/admin/estoque/:id', requireAuth, requireTenantOwner, async (req, res) => {
  if (!pool) return semBanco(res);
  const tid = req.user.tenantId || req.tenantId;
  const quantidade = parseInt(req.body.quantidade, 10);
  await pool.query('UPDATE estoque SET quantidade=$1 WHERE id=$2 AND tenant_id=$3', [quantidade, String(req.params.id), tid]);
  res.json({ ok: true });
});
app.delete('/api/admin/estoque/:id', requireAuth, requireTenantOwner, async (req, res) => {
  if (!pool) return semBanco(res);
  const tid = req.user.tenantId || req.tenantId;
  await pool.query('DELETE FROM estoque WHERE id=$1 AND tenant_id=$2', [String(req.params.id), tid]);
  res.json({ ok: true });
});

// SERVIÇOS (admin)
app.get('/api/admin/servicos', requireAuth, requireTenantOwner, async (req, res) => {
  if (!pool) return semBanco(res);
  const tid = req.user.tenantId || req.tenantId;
  const r = await pool.query('SELECT * FROM servicos WHERE tenant_id=$1 ORDER BY ordem, nome', [tid]);
  res.json({ ok: true, servicos: r.rows });
});
app.post('/api/admin/servicos', requireAuth, requireTenantOwner, async (req, res) => {
  if (!pool) return semBanco(res);
  const tid = req.user.tenantId || req.tenantId;
  const nome = esc((req.body.nome || '').trim()).slice(0, 60);
  const slots = parseInt(req.body.slots, 10);
  let preco = null;
  if (req.body.preco !== '' && req.body.preco != null) { if (!valorValido(req.body.preco)) return res.status(400).json({ ok: false, error: 'Preço inválido.' }); preco = toNum(req.body.preco); }
  const r = await pool.query('INSERT INTO servicos (tenant_id, nome, preco, slots, online) VALUES ($1,$2,$3,$4,TRUE) ON CONFLICT (tenant_id, nome) DO UPDATE SET preco=EXCLUDED.preco, slots=EXCLUDED.slots RETURNING id', [tid, nome, preco, slots]);
  res.json({ ok: true, id: r.rows[0].id });
});
app.put('/api/admin/servicos/:id', requireAuth, requireTenantOwner, async (req, res) => {
  if (!pool) return semBanco(res);
  const tid = req.user.tenantId || req.tenantId;
  const nome = esc((req.body.nome || '').trim()).slice(0, 60);
  const slots = parseInt(req.body.slots, 10);
  const online = !!req.body.online, ativo = !!(req.body.ativo !== false);
  let preco = null;
  if (req.body.preco !== '' && req.body.preco != null) { if (!valorValido(req.body.preco)) return res.status(400).json({ ok: false, error: 'Preço inválido.' }); preco = toNum(req.body.preco); }
  await pool.query('UPDATE servicos SET nome=$1, preco=$2, slots=$3, online=$4, ativo=$5 WHERE id=$6 AND tenant_id=$7', [nome, preco, slots, online, ativo, String(req.params.id), tid]);
  res.json({ ok: true });
});
app.delete('/api/admin/servicos/:id', requireAuth, requireTenantOwner, async (req, res) => {
  if (!pool) return semBanco(res);
  const tid = req.user.tenantId || req.tenantId;
  await pool.query('UPDATE servicos SET ativo=FALSE WHERE id=$1 AND tenant_id=$2', [String(req.params.id), tid]);
  res.json({ ok: true });
});

// GALERIA (admin)
app.get('/api/admin/fotos', requireAuth, requireTenantOwner, async (req, res) => {
  if (!pool) return semBanco(res);
  const tid = req.user.tenantId || req.tenantId;
  const r = await pool.query('SELECT id, categoria, tipo, criado_em FROM fotos WHERE tenant_id=$1 ORDER BY id DESC', [tid]);
  res.json({ ok: true, fotos: r.rows });
});
app.post('/api/admin/fotos', requireAuth, requireTenantOwner, async (req, res) => {
  if (!pool) return semBanco(res);
  const tid = req.user.tenantId || req.tenantId;
  const categoria = esc((req.body.categoria || '').trim()).slice(0, 40);
  const tipo = req.body.tipo === 'video' ? 'video' : 'imagem';
  const imagem = String(req.body.imagem || '');
  if (categoria.length < 2) return res.status(400).json({ ok: false, error: 'Informe a categoria.' });
  if (tipo === 'video') { if (!/^data:video\/(mp4|webm|quicktime);base64,[A-Za-z0-9+/=]+$/.test(imagem)) return res.status(400).json({ ok: false, error: 'Vídeo inválido.' }); if (Math.ceil((imagem.length - imagem.indexOf(',') - 1) * 0.75) > 20 * 1024 * 1024) return res.status(400).json({ ok: false, error: 'Vídeo muito grande.' }); }
  else { if (!/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(imagem)) return res.status(400).json({ ok: false, error: 'Imagem inválida.' }); if (Math.ceil((imagem.length - imagem.indexOf(',') - 1) * 0.75) > 5 * 1024 * 1024) return res.status(400).json({ ok: false, error: 'Imagem muito grande.' }); }
  const r = await pool.query('INSERT INTO fotos (tenant_id, categoria, imagem, tipo) VALUES ($1,$2,$3,$4) RETURNING id', [tid, categoria, imagem, tipo]);
  registrarLog(req, 'galeria', 'publicado', `Foto em "${categoria}"`);
  res.json({ ok: true, id: r.rows[0].id });
});
app.delete('/api/admin/fotos/:id', requireAuth, requireTenantOwner, async (req, res) => {
  if (!pool) return semBanco(res);
  const tid = req.user.tenantId || req.tenantId;
  await pool.query('DELETE FROM fotos WHERE id=$1 AND tenant_id=$2', [String(req.params.id), tid]);
  res.json({ ok: true });
});

// FAQ (admin)
app.get('/api/admin/faq', requireAuth, requireTenantOwner, async (req, res) => {
  if (!pool) return semBanco(res);
  const tid = req.user.tenantId || req.tenantId;
  const r = await pool.query('SELECT id, pergunta, resposta, ordem FROM faq WHERE tenant_id=$1 ORDER BY ordem, id', [tid]);
  res.json({ ok: true, faq: r.rows });
});
app.post('/api/admin/faq', requireAuth, requireTenantOwner, async (req, res) => {
  if (!pool) return semBanco(res);
  const tid = req.user.tenantId || req.tenantId;
  const pergunta = esc((req.body.pergunta || '').trim()).slice(0, 300);
  const resposta = esc((req.body.resposta || '').trim()).slice(0, 1000);
  const r = await pool.query('INSERT INTO faq (tenant_id, pergunta, resposta, ordem) VALUES ($1,$2,$3,999) RETURNING id', [tid, pergunta, resposta]);
  res.json({ ok: true, id: r.rows[0].id });
});
app.put('/api/admin/faq/:id', requireAuth, requireTenantOwner, async (req, res) => {
  if (!pool) return semBanco(res);
  const tid = req.user.tenantId || req.tenantId;
  await pool.query('UPDATE faq SET pergunta=$1, resposta=$2 WHERE id=$3 AND tenant_id=$4', [esc((req.body.pergunta||'').trim()).slice(0,300), esc((req.body.resposta||'').trim()).slice(0,1000), String(req.params.id), tid]);
  res.json({ ok: true });
});
app.delete('/api/admin/faq/:id', requireAuth, requireTenantOwner, async (req, res) => {
  if (!pool) return semBanco(res);
  const tid = req.user.tenantId || req.tenantId;
  await pool.query('DELETE FROM faq WHERE id=$1 AND tenant_id=$2', [String(req.params.id), tid]);
  res.json({ ok: true });
});

// RELATÓRIO mensal
app.get('/api/admin/relatorio-mensal', requireAuth, requireTenantOwner, async (req, res) => {
  if (!pool) return semBanco(res);
  const tid = req.user.tenantId || req.tenantId;
  const mes = String(req.query.mes || '').trim();
  if (!validarMes(mes)) return res.status(400).json({ ok: false, error: 'Informe o mês (AAAA-MM).' });
  const [ano, m] = mes.split('-').map(Number);
  const inicio = mes + '-01';
  const fim = mes + '-' + String(new Date(ano, m, 0).getDate()).padStart(2, '0');
  const caixa = await pool.query("SELECT to_char(data,'YYYY-MM-DD') data, COALESCE(SUM(valor) FILTER (WHERE tipo='entrada'),0) e, COALESCE(SUM(valor) FILTER (WHERE tipo='saida'),0) s FROM fluxo_caixa WHERE tenant_id=$1 AND data BETWEEN $2 AND $3 GROUP BY data ORDER BY data", [tid, inicio, fim]);
  const servicos = await pool.query('SELECT data, servico, COUNT(*)::int qtd, COALESCE(SUM(valor),0) total FROM agendamentos WHERE tenant_id=$1 AND pago=TRUE AND data BETWEEN $2 AND $3 GROUP BY data, servico ORDER BY data, servico', [tid, inicio, fim]);
  const map = {};
  caixa.rows.forEach(r => { const d=String(r.data).slice(0,10); map[d] = { data: d, entradas: Number(r.e), saidas: Number(r.s), servicos: [] }; });
  servicos.rows.forEach(s => { const d=String(s.data).slice(0,10); if (!map[d]) map[d]={data:d, entradas:0, saidas:0, servicos:[]}; map[d].servicos.push({ servico: s.servico, qtd: Number(s.qtd), total: Number(s.total) }); });
  const porDia = Object.values(map).sort((a,b)=>a.data<b.data?-1:1);
  const te = porDia.reduce((a,d)=>a+d.entradas,0), ts = porDia.reduce((a,d)=>a+d.saidas,0), tsn = porDia.reduce((a,d)=>a+d.servicos.reduce((x,s)=>x+s.qtd,0),0);
  res.json({ ok: true, mes, inicio, fim, porDia, totalEntradas: te, totalSaidas: ts, saldo: te-ts, totalServicos: tsn });
});

// LOGS
app.get('/api/admin/logs', requireAuth, requireTenantOwner, async (req, res) => {
  if (!pool) return semBanco(res);
  const tid = req.user.tenantId || req.tenantId;
  const limite = Math.min(parseInt(req.query.limite, 10) || 200, 1000);
  const r = await pool.query('SELECT id, tipo, acao, detalhe, usuario, ip, criado_em FROM logs WHERE tenant_id=$1 ORDER BY id DESC LIMIT $2', [tid, limite]);
  res.json({ ok: true, logs: r.rows });
});

/* ============================ MASTER — GERENCIAR TENANTS (app.brbpro.com.br) ============================ */
app.get('/api/master/tenants', requireAuth, requireTenantOwner, async (req, res) => {
  if (!pool) return semBanco(res);
  if (req.user.role !== 'master') return res.status(403).json({ ok: false, error: 'Apenas master.' });
  const r = await pool.query('SELECT id, slug, nome, cidade, plano, ativo, created_at FROM barbershops ORDER BY created_at DESC');
  res.json({ ok: true, tenants: r.rows });
});
app.post('/api/master/tenants', requireAuth, requireTenantOwner, async (req, res) => {
  if (!pool) return semBanco(res);
  if (req.user.role !== 'master') return res.status(403).json({ ok: false, error: 'Apenas master.' });
  const slug = String(req.body.slug || '').trim().toLowerCase().replace(/[^a-z0-9-]/g, '');
  const nome = esc((req.body.nome || '').trim()).slice(0, 80);
  const whatsapp = String(req.body.whatsapp || '').replace(/\D/g, '');
  const cidade = esc((req.body.cidade || '').trim()).slice(0, 60);
  const plano = ['essencial', 'pro', 'premium'].includes(req.body.plano) ? req.body.plano : 'pro';
  if (!/^[a-z0-9-]{3,30}$/.test(slug)) return res.status(400).json({ ok: false, error: 'Slug inválido (3-30, letras/números/hífen).' });
  if (nome.length < 2) return res.status(400).json({ ok: false, error: 'Informe o nome.' });
  if (RESERVED.has(slug)) return res.status(400).json({ ok: false, error: 'Slug reservado.' });
  try {
    const r = await pool.query('INSERT INTO barbershops (id, slug, nome, whatsapp, cidade, plano) VALUES ($1,$1,$2,$3,$4,$5) RETURNING id', [slug, nome, whatsapp || null, cidade || null, plano]);
    registrarLog(req, 'master', 'tenant_criado', `${nome} (${slug})`);
    res.json({ ok: true, id: r.rows[0].id });
  } catch (e) { if (e.code === '23505') return res.status(409).json({ ok: false, error: 'Slug já existe.' }); console.error(e.message); res.status(500).json({ ok: false, error: 'Erro.' }); }
});
app.put('/api/master/tenants/:id', requireAuth, requireTenantOwner, async (req, res) => {
  if (!pool) return semBanco(res);
  if (req.user.role !== 'master') return res.status(403).json({ ok: false, error: 'Apenas master.' });
  const id = String(req.params.id);
  const ativo = !!(req.body.ativo);
  await pool.query('UPDATE barbershops SET ativo=$1, plano=$2, updated_at=now() WHERE id=$3', [ativo, req.body.plano || 'pro', id]);
  // Invalida a cache na hora: o site sai (bloqueio) ou volta (ativação) imediatamente.
  invalidarTenant(id);
  res.json({ ok: true });
});

// Detalhe completo de uma barbearia (para o painel de personalização do master)
app.get('/api/master/tenants/:id', requireAuth, requireTenantOwner, async (req, res) => {
  if (!pool) return semBanco(res);
  if (req.user.role !== 'master') return res.status(403).json({ ok: false, error: 'Apenas master.' });
  const id = String(req.params.id);
  const r = await pool.query('SELECT * FROM barbershops WHERE id=$1', [id]);
  if (!r.rows.length) return res.status(404).json({ ok: false, error: 'Barbearia não encontrada.' });
  const t = r.rows[0];
  const servicos = await pool.query('SELECT * FROM servicos WHERE tenant_id=$1 ORDER BY ordem, nome', [id]);
  const fotos = await pool.query('SELECT id, categoria, tipo, criado_em FROM fotos WHERE tenant_id=$1 ORDER BY id DESC', [id]);
  const faq = await pool.query('SELECT * FROM faq WHERE tenant_id=$1 ORDER BY ordem, id', [id]);
  // remove strings gigantes (logo/base64) da resposta para não pesar; envia só presença
  const resumo = { ...t, logo: t.logo ? 'presente' : null, video_hero: t.video_hero ? t.video_hero.slice(0,50)+'…' : null, hero_imagem: t.hero_imagem ? 'presente' : null };
  res.json({ ok: true, tenant: resumo, servicos: servicos.rows, fotos: fotos.rows, faq: faq.rows });
});

// Personalizar o site de um cliente (logo, vídeo, imagem, textos, cores, dados)
app.put('/api/master/tenants/:id/personalizar', requireAuth, requireTenantOwner, async (req, res) => {
  if (!pool) return semBanco(res);
  if (req.user.role !== 'master') return res.status(403).json({ ok: false, error: 'Apenas master.' });
  const id = String(req.params.id);
  const b = req.body || {};
  // valida limite de mídias (evita payload gigante)
  const limita = (val, max) => {
    if (val === undefined || val === null || val === '') return val;
    if (String(val).startsWith('data:') && String(val).length > max) {
      throw new Error('mídia muito grande (máx. ' + Math.round(max / 1024 / 1024) + 'MB)');
    }
    return String(val);
  };
  const so = (v, n) => (v === undefined || v === null ? undefined : String(v).slice(0, n));
  let midias = {};
  try {
    midias = {
      logo: limita(b.logo, 400000),          // logo comprimida ~600px
      hero_imagem: limita(b.hero_imagem, 2200000), // hero ~1600px
      video_hero: limita(b.video_hero, 16000000),  // vídeo até ~16MB
      intro_video: limita(b.intro_video, 20000000), // vídeo de introdução até ~20MB
    };
  } catch (e) { return res.status(400).json({ ok: false, error: e.message }); }
  const cols = [
    ['nome', so(b.nome, 80)], ['whatsapp', so(b.whatsapp, 20)?.replace(/\D/g, '')],
    ['instagram', so(b.instagram, 80)], ['endereco', so(b.endereco, 240)],
    ['cidade', so(b.cidade, 80)], ['estado', so(b.estado, 4)], ['cep', so(b.cep, 12)],
    ['cor_primaria', so(b.cor_primaria, 20)], ['cor_secundaria', so(b.cor_secundaria, 20)],
    ['slogan', so(b.slogan, 140)], ['hero_titulo', so(b.hero_titulo, 80)],
    ['hero_sub', so(b.hero_sub, 200)], ['sobre_texto', so(b.sobre_texto, 1200)],
    ['tema', so(b.tema, 20)],
    ['logo', midias.logo], ['hero_imagem', midias.hero_imagem], ['video_hero', midias.video_hero], ['intro_video', midias.intro_video],
  ];
  const setClause = [];
  const params = [];
  let qi = 0;
  for (const [col, val] of cols) {
    if (val !== undefined) { qi++; params.push(val); setClause.push(`${col}=$${qi}`); }
  }
  if (!setClause.length) return res.status(400).json({ ok: false, error: 'Nada para alterar.' });
  params.push(id);
  const q = `UPDATE barbershops SET ${setClause.join(', ')}, updated_at=now() WHERE id=$${params.length}`;
  try {
    await pool.query(q, params);
    invalidarTenant(id); // reflete na hora
    registrarLog(req, 'master', 'personalizou', `Tenant ${id}`);
    res.json({ ok: true });
  } catch (e) { console.error('[personalizar]', e.message); res.status(500).json({ ok: false, error: 'Erro ao salvar.' }); }
});

/* ============================ PÁGINAS ============================ */
// Landings / painel / blocos de caminho sensíveis
const CAMINHOS_SENSIVEIS = /^\/(\.env|\.git|server\.js|package(-lock)?\.json|db\/|node_modules|render\.yaml|\.gitignore|Procfile|migration)/i;
app.use((req, res, next) => {
  if (CAMINHOS_SENSIVEIS.test(req.path)) return res.status(404).end();
  next();
});
app.use('/admin', (req, res, next) => { res.setHeader('X-Robots-Tag', 'noindex, nofollow'); next(); });

async function serveTenantSite(req, res) {
  const p = path.join(__dirname, 'public', 'index.html');
  if (!fs.existsSync(p)) return res.status(404).send(build404(''));
  let html = fs.readFileSync(p, 'utf8');
  const t = req.tenant;
  // Fotos da galeria do cliente — usadas para substituir as imagens de fundo fixas (Art na Régua)
  let fotosDoSite = [];
  try {
    if (pool && req.tenantId) {
      const fr = await pool.query("SELECT id FROM fotos WHERE tenant_id=$1 ORDER BY id ASC", [req.tenantId]);
      fotosDoSite = fr.rows.map(r => `/api/foto/${r.id}`);
    }
  } catch (e) {}
  // Substitui as imagens de fundo fixas (foto1..foto8/hero-real) pelas fotos do cliente,
  // aplicando um overlay bem mais claro para a foto aparecer (não ficar preta).
  if (fotosDoSite.length) {
    const fotoUrl = (i) => fotosDoSite[i % fotosDoSite.length];
    const claro = 'linear-gradient(rgba(11,11,13,0.30), rgba(11,11,13,0.42))';
    // (1) Troca os gradientes escuros fixos (0.70/0.80) por um overlap CLARO, para a foto aparecer
    html = html.replace(/linear-gradient\(rgba\(11,11,13,\s*0\.70\),\s*rgba\(11,11,13,\s*0\.80\)\)/gi, claro);
    html = html.replace(/linear-gradient\(rgba\(11,11,13,\s*0\.55\),\s*rgba\(11,11,13,\s*0\.70\)\)/gi, claro);
    // (2) Troca cada url('/images/real/fotoN.jpg') pela foto do cliente (uma distinta por seção)
    let sec = 0;
    html = html.replace(/url\(['"]?\/images\/real\/[a-z0-9_\-]+\.jpg['"]?\)/gi, function () {
      sec++;
      return `url('${fotoUrl(sec - 1)}')`;
    });
    // <img> da seção sobre que mostra uma foto fixa
    html = html.replace(/<img src="\/images\/real\/[a-z0-9_\-]+\.jpg"[^>]*>/i, `<img src="${fotoUrl(0)}" alt="${esc(t.nome)}" loading="lazy" />`);
    // se alguma section ficou só com url sem gradiente (fallback), garante gradiente claro
    html = html.replace(/(background-image:[^;]*url\('\/api\/foto\/[0-9]+'\))/gi, function (m) {
      return m; // já foi tratado acima
    });
    // og:image e JSON-LD "image" (compartilhamento/Rich Results)
    html = html.replace(/(<meta property="og:image" content=")[^"]*(")/i, `$1${fotoUrl(0)}$2`);
    html = html.replace(/(<meta name="twitter:image" content=")[^"]*(")/i, `$1${fotoUrl(0)}$2`);
    html = html.replace(/("image":\s*")[^"]*(")/, `$1${fotoUrl(0)}$2`);
  }
  const nome = t.nome || 'Barbearia';
  const cidade = t.cidade ? ' em ' + t.cidade : '';
  const cor1 = t.cor_primaria || '#C9A86A';
  const cor2 = t.cor_secundaria || '#B08D57';
  // hero: usa imagem/vídeo do cliente; senão mantém o padrão (genérico, não da Art na Régua)
  const heroImg = t.hero_imagem && t.hero_imagem.startsWith('data:') ? t.hero_imagem : (t.hero_imagem || '');
  const heroTitulo = t.hero_titulo || nome;
  const heroSub = t.hero_sub || 'Corte, barba e estilo com acabamento impecável. Agende pelo WhatsApp.';
  const slogan = t.slogan ? `<span class="hero-kicker" data-reveal>${esc(t.slogan)}</span>` : `<span class="hero-kicker" data-reveal>${esc(cidade ? 'Barbearia em ' + (t.cidade||'') : 'Barbearia')}</span>`;
  const sobre = t.sobre_texto || `Na ${esc(nome)}, cada atendimento é feito com atenção total. O objetivo é simples — você sair se sentindo a melhor versão de si.`;
  // Mídia por URL (evita embutir base64 pesado no HTML)
  const logoUrl = t.logo && String(t.logo).startsWith('data:') ? `/m/${t.slug}/logo` : '';
  const heroUrl = t.hero_imagem && String(t.hero_imagem).startsWith('data:') ? `/m/${t.slug}/hero` : '';
  const videoUrl = t.video_hero && String(t.video_hero).startsWith('data:') ? `/m/${t.slug}/video` : '';
  const introUrl = t.intro_video && String(t.intro_video).startsWith('data:') ? `/m/${t.slug}/intro` : '';
  const cfg = JSON.stringify({ nome: nome, whatsapp: t.whatsapp, instagram: t.instagram, endereco: t.endereco, cidade: t.cidade, estado: t.estado, horario: t.horario, tema: t.tema, cor_primaria: cor1, cor_secundaria: cor2, slug: t.slug, slogan: t.slogan||'', hero_titulo: heroTitulo, hero_sub: heroSub, sobre_texto: t.sobre_texto||'', logo_url: logoUrl, hero_url: heroUrl, video_url: videoUrl, intro_url: introUrl });
  // Vídeo de introdução do cliente: substitui o intro.mp4 padrão (da Art na Régua)
  if (introUrl) {
    // Troca TODO o bloco <video id="introVideo">...</video> pelo vídeo do cliente com muted (autoplay desbloqueado)
    const blobIntro = `<video id="introVideo" playsinline autoplay muted loop preload="auto"><source src="${introUrl}" type="video/mp4" /></video>`;
    html = html.replace(/<video id="introVideo"[\s\S]*?<\/video>/i, blobIntro);
  }
  // Título e meta dinâmicos por tenant (SEO / aba do navegador / compartilhamento)
  const titulo = `${heroTitulo}${cidade} | Corte, Barba e Estilo`;
  html = html.replace(/<title>.*?<\/title>/i, `<title>${esc(titulo)}</title>`);
  html = html.replace(/(<meta name="description" content=")[^"]*(")/i, `$1${esc(titulo + '. ' + heroSub)}$2`);
  html = html.replace(/(<meta property="og:title" content=")[^"]*(")/i, `$1${esc(titulo)}$2`);
  html = html.replace(/(<meta property="og:site_name" content=")[^"]*(")/i, `$1${esc(nome)}$2`);
  html = html.replace(/(<meta name="twitter:title" content=")[^"]*(")/i, `$1${esc(titulo)}$2`);
  // Logo do cliente (por URL — evita embutir base64 pesado no HTML)
  if (logoUrl) {
    // troca o bloco nav-logo INTEIRO (imagem + texto "Art na Régua" quebrado) pela marca do cliente
    html = html.replace(/(<a class="nav-logo"[^>]*>)[\s\S]*?(<\/a>)/i, `$1<img class="logo-mark" src="${logoUrl}" alt="${esc(nome)}" /> <span class="logo-nome">${esc(nome)}</span>$2`);
    // ainda substitui qualquer imagem logo-mark/logo-icon remanescente
    html = html.replace(/<img class="logo-mark"[^>]*>/i, `<img class="logo-mark" src="${logoUrl}" alt="${esc(nome)}" />`);
    html = html.replace(/<img src="\/images\/logo-icon\.png"[^>]*>/i, `<img src="${logoUrl}" alt="${esc(nome)}" />`);
    html = html.replace(/<img src="\/images\/logo-completa\.png"[^>]*>/i, `<img src="${logoUrl}" alt="${esc(nome)}" />`);
  }
  // Hero: substitui imagem de fundo (por URL) e texto
  if (heroUrl) {
    // troca a URL do hero-bg pela imagem do cliente (fecha corretamente com '))
    html = html.replace(/(<div class="hero-bg"[^>]*style="[^"]*url\('?)[^')]*(?:'?\))/i, `$1${heroUrl}')`);
  }
  // Título / subtítulo / kicker / sobre
  html = html.replace(/(<h1 class="hero-title"[^>]*>)[\s\S]*?(<\/h1>)/i, `$1<span id="brandNome">${esc(heroTitulo)}</span>$2`);
  html = html.replace(/(<p class="hero-desc"[^>]*>)[\s\S]*?(<\/p>)/i, `$1${esc(heroSub)}$2`);
  html = html.replace(/(<p class="hero-kicker"[^>]*>)[\s\S]*?(<\/p>)/i, slogan);
  html = html.replace(/(<p class="kicker"[^>]*>Por que a )[^<]*(<\/p>)/, `$1${esc(nome)}$2`);
  // Sobre: troca o(s) parágrafo(s) de "sobre" da marca genérica pelo texto do cliente
  html = html.replace(/(<p>Na Art na Régua[\s\S]*?<\/p>)/, `<p>${esc(sobre)}</p>`);
  html = html.replace(/© 2026 Art na Régua\./gi, `© 2026 ${esc(nome)}.`);
  // Remove QUALQUER resíduo da marca padrão (Art na Régua / "na régua") no site do cliente,
  // inclusive em caixas variadas. Substitui por termos neutros ou pelo nome do cliente.
  html = html.replace(/Art\s+na\s+R[eé]gua/gi, esc(nome));
  // frases fixas do template que citam "na régua"
  html = html.replace(/Precis[ãa]o "na r[eé]gua"/gi, 'Precisão no corte');
  html = html.replace(/O corte sai na r[eé]gua/gi, 'O corte sai no ponto');
  html = html.replace(/o corte sai na r[eé]gua/gi, 'o corte sai no ponto');
  html = html.replace(/corte sai na r[eé]gua/gi, 'corte sai no ponto');
  html = html.replace(/na r[eé]gua\s*[—]?\s*n[ãa]o é s[óo] um nome/gi, 'não é só um nome');
  html = html.replace(/nã[oa] é s[óo] um nome\s*[—]?\s*é a forma como cada corte sai daqui/gi, 'é a forma como cada corte sai daqui');
  html = html.replace(/N[ãa] r[eé]gua/gi, esc(nome));
  html = html.replace(/na r[eé]gua/gi, 'no ponto');
  html = html.replace(/A r[eé]gua/gi, 'A régua'); // mantém se for nome próprio residual
  // Cores do tema: mapeia a cor do cliente para as variáveis douradas do layout
  // (calcula tom claro e escuro a partir da cor primária escolhida)
  let r=200,g=161,b=92;
  const m=/#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})/i.exec(cor1);
  if (m){r=parseInt(m[1],16);g=parseInt(m[2],16);b=parseInt(m[3],16);}
  const mistura=(alvo,peso)=>{const c=(a)=>Math.round(a+(alvo-a)*peso);return `rgb(${c(r)},${c(g)},${c(b)})`;};
  const claro = cor1;
  const bemClaro = mistura(255, 0.35);
  const escuro = mistura(0, 0.28);
  const corVar = `:root{--dourado:${claro};--dourado-claro:${bemClaro};--dourado-escuro:${escuro};}`;
  html = html.replace('</head>', `<style>${corVar}</style></head>`);
  html = html.replace('</head>', `<script>window.BRB_TENANT=${cfg};</script></head>`);
  res.setHeader('Content-Type', 'text/html; charset=UTF-8');
  res.setHeader('Cache-Control', 'no-store'); // nunca cachear: bloqueio/ativação reflete na hora
  res.setHeader('CDN-Cache-Control', 'no-store');
  res.setHeader('Cloudflare-CDN-Cache-Control', 'no-store');
  res.send(html);
}

/* ============================ PAINEL DA TV (por barbearia) ============================ */
// Exibe na TV o cliente sendo atendido AGORA e o próximo, da agenda DO TENANT.
app.get('/api/tv/agora', async (req, res) => {
  if (!pool) return res.json({ ok: true, fechado: false, atual: null, proximo: null, tenant: req.tenantId || null });
  if (!req.tenantId) return res.redirect('/');
  const br = new Date(Date.now() - 3 * 3600 * 1000);
  const hoje = br.toISOString().slice(0, 10);
  const agoraMin = br.getUTCHours() * 60 + br.getUTCMinutes();
  const r = await pool.query(
    "SELECT nome, servico, horario, num_slots FROM agendamentos WHERE tenant_id=$1 AND data=$2 AND status <> 'cancelado' ORDER BY horario",
    [req.tenantId, hoje]
  );
  let atual = null, proximo = null;
  for (let i = 0; i < r.rows.length; i++) {
    const a = r.rows[i];
    const [h, m] = a.horario.split(':').map(Number);
    const inicio = h * 60 + m;
    const fim = inicio + 40 * (Number(a.num_slots) || 1);
    if (agoraMin >= inicio && agoraMin < fim) { atual = a; if (i + 1 < r.rows.length) proximo = r.rows[i + 1]; break; }
    if (agoraMin < inicio) { proximo = a; break; }
  }
  res.json({
    ok: true, hoje, agora: br.toISOString(), tenant: req.tenantId,
    nome: req.tenant ? req.tenant.nome : '',
    atual: atual ? { nome: atual.nome, servico: atual.servico, horario: atual.horario, num_slots: atual.num_slots } : null,
    proximo: proximo ? { nome: proximo.nome, servico: proximo.servico, horario: proximo.horario, num_slots: proximo.num_slots } : null,
  });
});

// Vídeo persistido por tenant (configuracoes chave tv_video_url)
app.get('/api/tv/video', async (req, res) => {
  if (!pool) return res.json({ ok: true, url: '' });
  const r = await pool.query("SELECT valor FROM configuracoes WHERE tenant_id=$1 AND chave='tv_video_url'", [req.tenantId])
    .catch(() => ({ rows: [] }));
  res.json({ ok: true, url: (r.rows[0] && r.rows[0].valor) || '' });
});
app.post('/api/tv/video', requireAuth, async (req, res) => {
  if (!pool) return res.json({ ok: true });
  const url = String(req.body.url || '').trim().slice(0, 300);
  if (!req.tenantId) return res.json({ ok: false, error: 'Sem tenant.' });
  if (url && !/^https?:\/\/(www\.)?(youtube\.com|youtu\.be)\//i.test(url)) return res.status(400).json({ ok: false, error: 'Cole um link válido do YouTube.' });
  await pool.query("INSERT INTO configuracoes (tenant_id, chave, valor) VALUES ($1,'tv_video_url',$2) ON CONFLICT (tenant_id, chave) DO UPDATE SET valor=EXCLUDED.valor", [req.tenantId, url]);
  res.json({ ok: true });
});

// Proxy HLS (para o player da TV)
const httpMod = require('http'), httpsMod = require('https');
function buscarRemoto(url, redirects, headers) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? httpsMod : httpMod;
    const req = lib.get(url, { headers: Object.assign({ 'User-Agent': 'Mozilla/5.0', 'Accept': '*/*' }, headers || {}) }, (r) => {
      if (r.statusCode >= 300 && r.statusCode < 400 && r.headers.location) {
        const next = new URL(r.headers.location, url).toString();
        if ((redirects || 0) > 5) return reject(new Error('redirects'));
        r.resume(); return buscarRemoto(next, (redirects || 0) + 1).then(resolve).catch(reject);
      }
      if (r.statusCode !== 200) { r.resume(); return reject(new Error('status ' + r.statusCode)); }
      const chunks = []; r.on('data', (c) => chunks.push(c));
      r.on('end', () => resolve({ tipo: r.headers['content-type'] || '', buf: Buffer.concat(chunks) }));
    });
    req.on('error', reject); req.setTimeout(15000, () => req.destroy(new Error('timeout')));
  });
}
const rlProxy = rateLimit(240, 60 * 1000);
app.get('/api/tv/proxy', rlProxy, async (req, res) => {
  const alvo = String(req.query.url || '').trim();
  if (!/^https?:\/\//.test(alvo)) return res.status(400).end();
  try {
    const u = new URL(alvo), host = u.hostname.toLowerCase();
    const privado = !host || host === 'localhost' || host === '0.0.0.0' || /^127\./.test(host) || /^10\./.test(host) || /^192\.168\./.test(host) || /^169\.254\./.test(host) || /^172\.(1[6-9]|2\d|3[01])\./.test(host) || host === '::1' || host === '[::1]' || /\.local$/.test(host) || /\.internal$/.test(host) || /\.lan$/.test(host) || host.endsWith('.onion');
    if (privado) return res.status(403).end();
  } catch { return res.status(400).end(); }
  try {
    const { tipo, buf } = await buscarRemoto(alvo, 0);
    const texto = buf.toString('utf8');
    if (tipo.includes('mpegurl') || texto.trim().startsWith('#EXTM3U')) {
      const base = new URL(alvo), baseDir = base.toString().slice(0, base.toString().lastIndexOf('/') + 1);
      const linhas = texto.split('\n').map((linha) => { const l = linha.trim(); if (!l || l.startsWith('#')) return linha; const urlAbs = new URL(l, baseDir).toString(); return '/api/tv/proxy?url=' + encodeURIComponent(urlAbs); });
      res.setHeader('Content-Type', 'application/vnd.apple.mpegurl'); res.setHeader('Cache-Control', 'no-cache');
      return res.send(linhas.join('\n'));
    }
    const ct = tipo || 'video/mp2t';
    res.setHeader('Content-Type', ct); res.setHeader('Cache-Control', 'no-cache'); res.send(buf);
  } catch (e) { res.status(502).end(); }
});

// Canais
const CANAIS_FIXOS = [
  { nome: 'Sony Movies', categoria: 'Filmes (TV)', url: 'http://45.162.64.114/SONY_MOVIES/index.m3u8' },
  { nome: 'Studio Universal', categoria: 'Filmes (TV)', url: 'http://177.52.24.163/STUDIO-UNIVERSAL-HD/index.m3u8' },
  { nome: 'Sony Channel', categoria: 'Filmes (TV)', url: 'http://45.190.28.50/SONY_HD/index.m3u8' },
  { nome: 'AXN', categoria: 'Ação & Aventura', url: 'http://45.190.28.50/AXN_HD/index.m3u8' },
  { nome: 'Lifetime', categoria: 'Ação & Aventura', url: 'http://138.255.2.6:8084/LIFETIME/index.m3u8' },
];
app.get('/api/tv/canais', async (req, res) => { res.setHeader('Cache-Control', 'no-store'); res.json({ ok: true, canais: CANAIS_FIXOS }); });

// Rota /tv -> serve o tv.html do painel (com no-cache e marca do tenant)
app.get('/tv', (req, res) => {
  const p = path.join(__dirname, 'public', 'tv.html');
  if (!fs.existsSync(p)) return res.status(404).send('Painel da TV indisponível.');
  let html = fs.readFileSync(p, 'utf8');
  const nome = (req.tenant && req.tenant.nome) || 'Barbearia';
  html = html.replace(/Art\s+na\s+R[eé]gua/gi, esc(nome));
  html = html.replace(/<title>[^<]*<\/title>/i, `<title>Painel TV — ${esc(nome)}</title>`);
  // Marca do tenant no topo do Painel TV (logo + nome), troca o bloco .marca inteiro
  if (req.tenant) {
    const logo = (req.tenant.logo && String(req.tenant.logo).startsWith('data:')) ? `/m/${req.tenant.slug}/logo` : '';
    const marca = logo
      ? `<div class="marca"><img src="${logo}" alt="" /> ${esc(nome)}</div>`
      : `<div class="marca">${esc(nome)}</div>`;
    html = html.replace(/(<div class="marca"[^>]*>)[\s\S]*?(<\/div>)/i, marca);
  }
  res.setHeader('Content-Type', 'text/html; charset=UTF-8');
  res.setHeader('Cache-Control', 'no-store');
  res.send(vAssets(html));
});


// Estáticos (css/js/images)
app.use('/css', express.static(path.join(__dirname, 'public/css'), { setHeaders: function(res){ res.setHeader('Cache-Control','no-cache'); } }));
app.use('/js', express.static(path.join(__dirname, 'public/js'), { setHeaders: function(res){ res.setHeader('Cache-Control','no-cache'); } }));
app.use('/images', express.static(path.join(__dirname, 'public/images'), { maxAge: '1h' }));

app.get('/', async (req, res) => {
  if (req.isApp) {
    // painel master
    const p = path.join(__dirname, 'public', 'admin', 'login.html');
    if (fs.existsSync(p)) return res.sendFile(p);
    return res.redirect('/admin/login.html');
  }
  if (req.tenantSlug === 'admin' || req.tenantSlug === 'painel') {
    return res.sendFile(path.join(__dirname, 'public', 'admin', 'login.html'));
  }
  if (req.tenant) return await serveTenantSite(req, res);
  // landing
  const lp = path.join(__dirname, 'brbpro-landing', 'index.html');
  if (fs.existsSync(lp)) return res.sendFile(lp);
  return res.send(`<h1>BRB Pro</h1><p>Plataforma de sites para barbearias.</p>`);
});

// Painel admin — HTMLs com cache-busting (JS/CSS sempre na versão do deploy) e no-cache
app.use('/admin', function (req, res, next) {
  const rel = req.path.replace(/^\//, '');
  const fp = path.join(__dirname, 'public', 'admin', rel);
  if ((/login\.html$|\.html$/i.test(req.path)) && fs.existsSync(fp) && fs.statSync(fp).isFile()) {
    res.setHeader('Content-Type', 'text/html; charset=UTF-8');
    res.setHeader('Cache-Control', 'no-cache');
    return res.send(vAssets(fs.readFileSync(fp, 'utf8')));
  }
  next();
});
app.use('/admin', express.static(path.join(__dirname, 'public', 'admin'), { setHeaders: function(res){ res.setHeader('Cache-Control','no-cache'); } }));

// Fallback: qualquer .html do tenant
app.get('*', async (req, res) => {
  const p = path.join(__dirname, 'public', req.path.replace(/^\//, ''));
  if (fs.existsSync(p) && fs.statSync(p).isFile()) return res.sendFile(p);
  if (req.tenant) return await serveTenantSite(req, res);
  res.status(404).send(build404(''));
});

// 404 API
app.use(async (req, res) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ ok: false, error: 'Rota não encontrada.' });
  if (req.tenant) return await serveTenantSite(req, res);
  res.status(404).send(build404(''));
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ BRB Pro SaaS rodando na porta ${PORT}`);
  console.log(`   Landing: brbpro.com.br | Painel master: app.brbpro.com.br | Tenant: *.brbpro.com.br`);
  console.log(`   Banco: ${pool ? 'conectado (Neon)' : 'NÃO configurado'}`);
});

module.exports = { app };
