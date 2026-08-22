/**
 * BRB Pro — Middleware Multi-Tenant por Subdomínio
 * Stack: Node.js + Express
 * 
 * O que faz:
 *  - Extrai tenant (slug) do hostname: artnaregua.brbpro.com.br -> "artnaregua"
 *  - Diferencia landing (brbpro.com.br) vs app (app.brbpro.com.br) vs site cliente (*.brbpro.com.br)
 *  - Injeta req.tenant e req.tenantId para uso em todas as rotas/APIs
 *  - Garante isolamento: toda query filtra por tenant_id
 * 
 * Como usar:
 *  app.use(tenantResolver)
 *  app.use('/api/admin', requireTenant, adminRoutes)
 *  app.get('/api/servicos', publicServicos) // usa req.tenant se existir, senão fallback
 */

const RESERVED = new Set(['www', 'app', 'api', 'admin', 'painel', 'dashboard', 'brbpro']);

// Mapa slug -> tenant_id (ideal: buscar no DB/cache). Comece com memória + DB fallback.
const TENANT_CACHE = new Map(); // slug -> { id, slug, nome }
let cacheExpires = 0;
const CACHE_TTL = 60 * 1000; // 60s

// Em produção, troque por query no DB (Postgres/Supabase):
// SELECT id, slug, nome FROM barbershops WHERE slug = $1 AND ativo = true
async function lookupTenant(slug, db) {
  if (!slug) return null;
  slug = slug.toLowerCase().trim();

  // Cache rápido
  if (TENANT_CACHE.has(slug) && Date.now() < cacheExpires) {
    return TENANT_CACHE.get(slug);
  }

  // TODO: descomente quando tiver DB
  // if (db) {
  //   const { rows } = await db.query('SELECT id, slug, nome FROM barbershops WHERE slug = $1 LIMIT 1', [slug]);
  //   if (rows[0]) {
  //     TENANT_CACHE.set(slug, rows[0]);
  //     cacheExpires = Date.now() + CACHE_TTL;
  //     return rows[0];
  //   }
  //   return null;
  // }

  // Fallback DEV: aceita qualquer slug como tenant válido (para testar wildcard sem DB)
  // REMOVA em produção e use DB acima
  const devTenant = { id: slug, slug, nome: slug };
  TENANT_CACHE.set(slug, devTenant);
  cacheExpires = Date.now() + CACHE_TTL;
  return devTenant;
}

function getSlugFromHost(hostname) {
  if (!hostname) return null;
  // Preview e2b / localhost -> trata como sem tenant (landing) para demonstração
  if (hostname.includes('e2b.app') || hostname.includes('e2b.dev') || hostname.includes('amazonaws.com')) return null;
  // Remove porta se houver (localhost:3000)
  hostname = hostname.split(':')[0].toLowerCase();

  // Local dev: artnaregua.localhost, artnaregua.lvh.me, *.test
  if (hostname === 'localhost' || hostname === '127.0.0.1') return null;
  if (hostname.endsWith('.localhost')) return hostname.split('.')[0];

  // Produção: *.brbpro.com.br
  // ex: artnaregua.brbpro.com.br -> artnaregua
  //     brbpro.com.br -> null (landing)
  //     www.brbpro.com.br -> null
  //     app.brbpro.com.br -> "app" (tratado como reservado)
  const parts = hostname.split('.');
  
  // brbpro.com.br tem 3 partes -> sem subdomínio
  if (hostname === 'brbpro.com.br' || hostname === 'www.brbpro.com.br') return null;
  
  // *.brbpro.com.br tem 4 partes: [slug, brbpro, com, br]
  if (hostname.endsWith('.brbpro.com.br')) {
    const slug = parts[0];
    if (!slug || RESERVED.has(slug)) return slug; // retorna "app"/"www" para rotear diferente
    return slug;
  }

  // Fallback genérico: pega primeiro label se tiver 3+ partes (para wildcard em staging)
  if (parts.length >= 3) return parts[0];
  
  return null;
}

// Middleware principal — coloque ANTES de todas as rotas
async function tenantResolver(req, res, next) {
  try {
    const host = req.hostname || req.headers.host || '';
    const slug = getSlugFromHost(host);

    // Landing principal
    if (!slug) {
      req.tenant = null;
      req.tenantSlug = null;
      req.tenantId = null;
      req.isLanding = true;
      req.isApp = false;
      return next();
    }

    // App/painel master
    if (slug === 'app' || slug === 'painel' || slug === 'admin') {
      req.tenant = null;
      req.tenantSlug = 'app';
      req.tenantId = null;
      req.isLanding = false;
      req.isApp = true;
      return next();
    }

    // Site de barbearia cliente
    const tenant = await lookupTenant(slug, req.db);
    if (!tenant) {
      // Subdomínio não existe -> 404 com página de "barbearia não encontrada" + CTA para criar
      return res.status(404).send(`
        <html style="font-family:system-ui;background:#07080A;color:#F2F0EC;text-align:center;padding:60px">
          <h1 style="color:#C9A86A">Barbearia não encontrada</h1>
          <p>O endereço <b>${slug}.brbpro.com.br</b> ainda não existe.</p>
          <p><a href="https://brbpro.com.br" style="color:#C9A86A">→ Criar minha barbearia em 48h</a></p>
        </html>
      `);
    }

    req.tenant = tenant;
    req.tenantSlug = tenant.slug;
    req.tenantId = tenant.id;
    req.isLanding = false;
    req.isApp = false;

    // Header útil para debug/CDN
    res.setHeader('X-BRB-Tenant', tenant.slug);

    next();
  } catch (e) {
    next(e);
  }
}

// Middleware para rotas que EXIGEM tenant (ex: /api/servicos público por barbearia)
function requireTenant(req, res, next) {
  if (!req.tenant) {
    return res.status(400).json({ ok: false, error: 'Barbearia não identificada. Acesse via subdomínio: ex: artnaregua.brbpro.com.br' });
  }
  next();
}

// Middleware para rotas admin — exige auth + tenant do usuário bater com tenant do subdomínio (ou app)
function requireTenantOwner(req, res, next) {
  // req.user deve vir do seu auth middleware (JWT/cookie)
  if (!req.user) return res.status(401).json({ ok: false, error: 'Não autorizado' });
  // Se acessando via app.brbpro.com.br, permite qualquer tenant (master)
  if (req.isApp) return next();
  // Se acessando via *.brbpro.com.br, garante que o dono só vê o próprio tenant
  if (req.tenant && req.user.tenantId && req.tenantId !== req.user.tenantId) {
    return res.status(403).json({ ok: false, error: 'Acesso negado a esta barbearia' });
  }
  next();
}

// Helper para queries: adiciona filtro de tenant automaticamente
function tenantFilter(req) {
  if (!req.tenantId) return {};
  return { tenant_id: req.tenantId };
}

module.exports = {
  tenantResolver,
  requireTenant,
  requireTenantOwner,
  tenantFilter,
  getSlugFromHost,
  lookupTenant,
};

/**
 * EXEMPLO DE INTEGRAÇÃO NO SEU server.js EXISTENTE:
 * 
 * const express = require('express');
 * const { tenantResolver, requireTenant, requireTenantOwner } = require('./middleware/tenant');
 * const cookieParser = require('cookie-parser');
 * 
 * const app = express();
 * app.set('trust proxy', 1); // importante no Render/Cloudflare
 * app.use(cookieParser());
 * app.use(express.json());
 * app.use(tenantResolver); // <--- ANTES de tudo
 * 
 * // Rotas públicas por barbearia (usam tenant do subdomínio)
 * app.get('/api/servicos', async (req,res)=>{
 *   // req.tenant pode ser null se acessando brbpro.com.br -> retorna catálogo demo ou 400
 *   const tenantId = req.tenantId || 'artnaregua'; // fallback demo
 *   const servicos = await db.query('SELECT * FROM servicos WHERE tenant_id=$1 AND online=true', [tenantId]);
 *   res.json({ ok:true, servicos: servicos.rows });
 * });
 * 
 * app.get('/api/slots', async (req,res)=>{
 *   const tenantId = req.tenantId || 'artnaregua';
 *   // ... calcula slots filtrando por tenantId
 * });
 * 
 * // Rotas admin — protegidas por tenant do usuário
 * app.use('/api/admin', requireAuth, requireTenantOwner, adminRouter);
 * 
 * // Landing BRB Pro (sem tenant)
 * app.get('/', (req,res)=>{
 *   if (req.isLanding) return res.sendFile(path.join(__dirname,'brbpro-landing/index.html'));
 *   if (req.tenant) return res.sendFile(path.join(__dirname,'public/index.html')); // site da barbearia
 *   if (req.isApp) return res.redirect('/admin/login.html');
 * });
 * 
 */
