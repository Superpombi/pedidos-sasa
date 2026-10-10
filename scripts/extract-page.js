// Se ejecuta DENTRO de la pagina del visor (page.evaluate). Devuelve {rows, stats}.
// Reglas: secciones 3 a 5 del documento metodo-catalogo-avon.md. Argumento: marca ('Avon' | 'Natura').
async (marca) => {
  const clean = (s) => String(s == null ? '' : s)
    .replace(/<[^>]*>/g, ' ')
    .replace(/[\u200B-\u200D\u2060\uFEFF]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  const root = [...document.querySelectorAll('*')].find(e => e.__vue__ && e.__vue__.$store);
  if (!root) throw new Error('No se encontro el store del visor');
  const S = root.__vue__.$store.state.PLP;
  if (!S || !S.products || !S.products.length) throw new Error('PLP.products vacio');
  S.products.forEach(p => { p._should_render = true; });
  for (let i = 0; i < 40; i++) {
    await new Promise(r => setTimeout(r, 1500));
    if (!S.products.some(p => p._api_data_loading)) break;
  }
  const rows = [];
  const marcadores = [];
  const sinPrecio = [];
  const avonPromo = [];
  let variantes = 0;
  for (const p of S.products) {
    const src = p.original && p.original.source;
    for (const v of (p.variations || [])) {
      variantes++;
      const sku = clean(v.sku);
      const titulo = clean(v.title);
      const vol = clean(v.volumetry || v.volume);
      let variante = clean(v.variant);
      if (variante === sku) variante = '';
      const linea = clean(v.brand);
      const partes = marca === 'Natura' ? [titulo, vol, variante, linea] : [titulo, vol, variante];
      const nombre = partes.filter(Boolean).join(' - ');
      const promoPrice = Number(p.promo_price);
      const precio = (promoPrice > 0) ? promoPrice : Number(v.sale_price);
      if (marca === 'Avon' && promoPrice > 0) avonPromo.push(clean(v.sku));
      const promo = clean(v.promotions && v.promotions[0] && v.promotions[0].description);
      const esMarcador = src === 'agents-stock' && (!titulo || /^kit\b/i.test(titulo) || !(precio > 0));
      if (!sku) continue;
      if (esMarcador) { marcadores.push(sku); continue; }
      if (!(precio > 0) || !nombre) { sinPrecio.push(sku); continue; }
      rows.push({ codigo: sku, producto: nombre, precio: Math.round(precio), marca, promo, fuente: src || '' });
    }
  }
  return { rows, stats: { productos: S.products.length, variantes, marcadores, sinPrecio, avonPromo } };
}
