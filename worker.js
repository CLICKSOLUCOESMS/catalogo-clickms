/*
 * Cloudflare Worker para o catálogo Click Soluções.
 *
 * Rotas:
 *   /__status        → "Worker is running" (verificação rápida que o worker subiu)
 *   /foto/{id}[/{n}] → serve a foto do aparelho como JPEG (decodifica base64
 *                      do catalogo.json e devolve como imagem real)
 *   /produto/{id}    → serve catalogo.html com meta tags Open Graph
 *                      personalizadas (foto + nome + preço do aparelho).
 *                      É o link de compartilhamento usado pelo botão "🔗 Copiar link".
 *   tudo o resto     → repassa pros arquivos estáticos (catalogo.html, .json, logo)
 *
 * Importante: para evitar parsear o JSON inteiro (que pode ter ~10MB com
 * fotos em base64), fazemos uma busca textual pelo ID do aparelho e
 * extraímos só o objeto daquele dispositivo via brace-matching.
 */

const ALLOWED_MIME = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // -------- Verificação rápida que o worker está rodando --------
    if (url.pathname === '/__status') {
      return new Response('Worker is running (v3 - diagnostics)', {
        headers: { 'Content-Type': 'text/plain; charset=utf-8' },
      });
    }

    // -------- Diagnóstico: /__list lista todos os IDs no catálogo --------
    if (url.pathname === '/__list') {
      try {
        const res = await env.ASSETS.fetch(new Request(`${url.origin}/catalogo.json`));
        if (!res.ok) {
          return new Response('catalogo.json: status=' + res.status, { status: 500 });
        }
        const text = await res.text();
        // Extrai todos os "id":"..." do JSON via regex
        const idMatches = [...text.matchAll(/"id"\s*:\s*"([^"]+)"/g)];
        const ids = idMatches.map(m => m[1]);
        // Extrai também os modelos para identificação
        const items = [];
        for (const id of ids) {
          const p = findProductInText(text, id);
          if (p) {
            items.push({
              id,
              model: p.model,
              storage: p.storage,
              color: p.color,
              hasPhoto: Array.isArray(p.photos) && p.photos.length > 0,
            });
          }
        }
        return new Response(JSON.stringify({
          count: items.length,
          catalogoSize: text.length,
          items,
        }, null, 2), {
          headers: { 'Content-Type': 'application/json; charset=utf-8' },
        });
      } catch (e) {
        return new Response('Erro: ' + (e && e.message || e), { status: 500 });
      }
    }

    // -------- Diagnóstico: /__test/{id} mostra o que o findProduct retorna --------
    const testMatch = url.pathname.match(/^\/__test\/([^/]+)\/?$/);
    if (testMatch) {
      const id = decodeURIComponent(testMatch[1]);
      const result = {
        deviceId: id,
        catalogoFetch: null,
        catalogoSize: null,
        idFoundInText: null,
        productFound: null,
        productSummary: null,
        error: null,
      };
      try {
        const res = await env.ASSETS.fetch(new Request(`${url.origin}/catalogo.json`));
        result.catalogoFetch = `status=${res.status} ok=${res.ok}`;
        if (res.ok) {
          const text = await res.text();
          result.catalogoSize = text.length;
          const needle = `"id":"${id}"`;
          result.idFoundInText = text.indexOf(needle) !== -1;
          const product = findProductInText(text, id);
          result.productFound = product !== null;
          if (product) {
            result.productSummary = {
              model: product.model,
              storage: product.storage,
              color: product.color,
              price: product.price,
              photosCount: Array.isArray(product.photos) ? product.photos.length : 0,
              firstPhotoPrefix: Array.isArray(product.photos) && product.photos[0]
                ? String(product.photos[0]).slice(0, 30)
                : null,
            };
          }
        }
      } catch (e) {
        result.error = String(e && e.message || e);
      }
      return new Response(JSON.stringify(result, null, 2), {
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
      });
    }

    // -------- Endpoint de foto: /foto/{id} ou /foto/{id}/{index} --------
    if (url.pathname.startsWith('/foto/')) {
      return servePhoto(url, env);
    }

    // -------- Link individual: /produto/{id} --------
    // Serve catalogo.html com meta tags personalizadas (preview do WhatsApp/Instagram).
    const produtoMatch = url.pathname.match(/^\/produto\/([^/]+)\/?$/);
    if (produtoMatch) {
      const deviceId = decodeURIComponent(produtoMatch[1]);
      return serveProductPage(env, url, deviceId);
    }

    // -------- (compat) ?aparelho=ID em catalogo.html --------
    // Caso o link antigo ainda esteja em circulação, tenta reescrever também.
    const assetResponse = await env.ASSETS.fetch(request);
    const aparelhoId = url.searchParams.get('aparelho');
    if (aparelhoId) {
      const isHtml = (assetResponse.headers.get('content-type') || '').includes('text/html');
      if (isHtml) {
        const product = await findProduct(env, url.origin, aparelhoId);
        if (product) {
          return rewriteHtml(assetResponse, product, url, aparelhoId);
        }
      }
    }

    return assetResponse;
  },
};

/* -------- /produto/{id} → catalogo.html com OG tags personalizadas -------- */

async function serveProductPage(env, url, deviceId) {
  // Busca a página HTML base
  const htmlReq = new Request(`${url.origin}/catalogo.html`);
  const assetResponse = await env.ASSETS.fetch(htmlReq);
  if (!assetResponse.ok) {
    return new Response('Catálogo não encontrado', { status: 404 });
  }

  // Busca o produto
  const product = await findProduct(env, url.origin, deviceId);
  if (!product) {
    // Produto não encontrado → devolve a página normal
    return new Response(await assetResponse.text(), {
      headers: assetResponse.headers,
    });
  }

  return rewriteHtml(assetResponse, product, url, deviceId);
}

/* -------- HTMLRewriter: troca <title>, og:*, twitter:* -------- */

function rewriteHtml(response, product, url, deviceId) {
  const priceFmt = Number(product.price || 0).toLocaleString('pt-BR', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });

  const titleParts = [product.model, product.storage, product.color]
    .filter(Boolean)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
  const title = (titleParts || 'Aparelho') + ' — Click Soluções';

  const descParts = [];
  if (priceFmt !== '0,00') descParts.push(`R$ ${priceFmt} à vista`);
  if (product.battery) descParts.push(`Bateria ${product.battery}%`);
  if (product.warranty) descParts.push(`Garantia ${product.warranty}`);
  const description = descParts.join(' · ') || 'Aparelho semi-novo revisado.';

  // URL da foto servida pelo próprio worker
  const imageUrl = `${url.origin}/foto/${encodeURIComponent(deviceId)}`;
  const canonical = `${url.origin}/produto/${encodeURIComponent(deviceId)}`;

  const set = (attr, value) => ({
    element(el) { el.setAttribute(attr, value); },
  });

  return new HTMLRewriter()
    .on('title', { element(el) { el.setInnerContent(title); } })
    .on('meta[name="description"]', set('content', description))
    .on('meta[property="og:type"]', set('content', 'product'))
    .on('meta[property="og:title"]', set('content', title))
    .on('meta[property="og:description"]', set('content', description))
    .on('meta[property="og:image"]', set('content', imageUrl))
    .on('meta[property="og:url"]', set('content', canonical))
    .on('meta[name="twitter:card"]', set('content', 'summary_large_image'))
    .on('meta[name="twitter:title"]', set('content', title))
    .on('meta[name="twitter:description"]', set('content', description))
    .on('meta[name="twitter:image"]', set('content', imageUrl))
    .transform(response);
}

/* -------- Endpoint /foto/{id}[/{index}] -------- */

async function servePhoto(url, env) {
  const parts = url.pathname.split('/').filter(Boolean); // ['foto', id, index?]
  const deviceId = parts[1] ? decodeURIComponent(parts[1]) : '';
  const index = parts[2] ? Math.max(0, parseInt(parts[2], 10) || 0) : 0;
  if (!deviceId) return new Response('Bad request', { status: 400 });

  const product = await findProduct(env, url.origin, deviceId);
  if (!product) {
    return fallbackToLogo(url, env);
  }

  const photos = Array.isArray(product.photos) ? product.photos.filter(Boolean) : [];
  if (photos.length === 0) {
    return fallbackToLogo(url, env);
  }

  const photo = photos[Math.min(index, photos.length - 1)] || photos[0];

  // URL externa → redireciona
  if (!photo.startsWith('data:')) {
    return Response.redirect(photo, 302);
  }

  // data:image/...;base64,XXX → decodifica e devolve como imagem
  const m = photo.match(/^data:([^;]+);base64,(.+)$/);
  if (!m) return fallbackToLogo(url, env);

  let mime = m[1].toLowerCase();
  if (!ALLOWED_MIME.has(mime)) mime = 'image/jpeg';
  const b64 = m[2];

  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);

  return new Response(bytes, {
    headers: {
      'Content-Type': mime,
      'Cache-Control': 'public, max-age=300, s-maxage=300',
    },
  });
}

async function fallbackToLogo(url, env) {
  const logoReq = new Request(`${url.origin}/logo.png`);
  return env.ASSETS.fetch(logoReq);
}

/* -------- Busca eficiente do produto no catalogo.json -------- */

async function findProduct(env, origin, deviceId) {
  try {
    const res = await env.ASSETS.fetch(new Request(`${origin}/catalogo.json`));
    if (!res.ok) return null;
    const text = await res.text();
    return findProductInText(text, deviceId);
  } catch (e) {
    return null;
  }
}

/* Encontra o objeto JSON com "id":"X" usando text search + brace matching.
   Assim evitamos JSON.parse no catálogo inteiro (que pode ter dezenas de MB
   com fotos em base64) — parseamos apenas o objeto do dispositivo encontrado. */
function findProductInText(text, deviceId) {
  const safeId = deviceId.replace(/[\\"]/g, m => '\\' + m);
  const needle = `"id":"${safeId}"`;
  const idx = text.indexOf(needle);
  if (idx === -1) return null;

  let start = idx;
  while (start >= 0 && text[start] !== '{') start--;
  if (start < 0) return null;

  let depth = 0;
  let i = start;
  let inStr = false;
  let escaped = false;
  while (i < text.length) {
    const c = text[i];
    if (escaped) {
      escaped = false;
    } else if (inStr) {
      if (c === '\\') escaped = true;
      else if (c === '"') inStr = false;
    } else {
      if (c === '"') inStr = true;
      else if (c === '{') depth++;
      else if (c === '}') {
        depth--;
        if (depth === 0) {
          try {
            return JSON.parse(text.slice(start, i + 1));
          } catch (e) {
            return null;
          }
        }
      }
    }
    i++;
  }
  return null;
}
