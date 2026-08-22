/**
 * BRB Pro — Cloudflare Worker para Wildcard quando Render não aceita *.brbpro.com.br
 * 
 * Use se seu plano Render não permite wildcard.
 * Este worker intercepta *.brbpro.com.br e faz fetch para seu app Render
 * passando o hostname original no header X-Forwarded-Host.
 * 
 * Deploy: Cloudflare Dashboard → Workers → Create Worker → colar este código → Save
 * Rota: *.brbpro.com.br/* → Worker
 */

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const hostname = url.hostname; // artnaregua.brbpro.com.br

    // Não intercepta apex e app (deixe eles irem direto para Render)
    if (hostname === 'brbpro.com.br' || hostname === 'www.brbpro.com.br' || hostname === 'app.brbpro.com.br') {
      return fetch(request);
    }

    // Só intercepta *.brbpro.com.br
    if (!hostname.endsWith('.brbpro.com.br')) {
      return fetch(request);
    }

    // Origem no Render — TROQUE pelo seu
    const originHost = 'art-na-regua.onrender.com';
    const originUrl = `https://${originHost}${url.pathname}${url.search}`;

    // Clona request e troca host
    const newHeaders = new Headers(request.headers);
    newHeaders.set('X-Forwarded-Host', hostname);
    newHeaders.set('X-BRB-Original-Host', hostname);
    newHeaders.set('Host', originHost);

    const newRequest = new Request(originUrl, {
      method: request.method,
      headers: newHeaders,
      body: request.body,
      redirect: 'manual',
    });

    const response = await fetch(newRequest);

    // Clona resposta e adiciona header de tenant para debug
    const newResponse = new Response(response.body, response);
    newResponse.headers.set('X-BRB-Tenant-Slug', hostname.split('.')[0]);
    newResponse.headers.set('X-Robots-Tag', 'noindex'); // opcional

    return newResponse;
  },
};

/**
 * No seu server.js, leia o header quando vier via Worker:
 * 
 * function getSlugFromHost(req){
 *   const forwarded = req.headers['x-forwarded-host'] || req.headers['x-brb-original-host'];
 *   const host = forwarded || req.hostname;
 *   // ... resto do tenantResolver
 * }
 */
