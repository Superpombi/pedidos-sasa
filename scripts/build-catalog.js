// Lee las revistas Avon y Natura, arma el catalogo y lo publica en site/ solo si pasa los controles.
// Reglas de extraccion: secciones 3 a 5 de metodo-catalogo-avon.md (ver scripts/extract-page.js).
// Si un control falla: NO toca site/, escribe informes/ultimo.md con el motivo y termina con error
// (GitHub avisa por mail), asi la app sigue con el ultimo catalogo bueno.
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
const extractSrc = fs.readFileSync(path.join(__dirname, 'extract-page.js'), 'utf8');
const SITE = path.join(ROOT, 'site');
const INFORMES = path.join(ROOT, 'informes');
const JSON_PATH = path.join(SITE, 'catalogo.json');
const CSV_PATH = path.join(SITE, `catalogo-ciclo-${cfg.ciclo}.csv`);
const FIXTURE = process.env.CATALOGO_FIXTURE; // solo para pruebas locales sin navegador

// ---------- lectura ----------
async function leerRevista(browser, rev) {
  if (FIXTURE) {
    return JSON.parse(fs.readFileSync(path.join(FIXTURE, rev.marca.toLowerCase() + '.json'), 'utf8'));
  }
  const ctx = await browser.newContext({ locale: 'es-AR' });
  const page = await ctx.newPage();
  try {
    await page.goto(rev.url + '?module=plp', { waitUntil: 'domcontentloaded', timeout: 90000 });
    await page.waitForFunction(() => {
      const e = [...document.querySelectorAll('*')].find(x => x.__vue__ && x.__vue__.$store);
      const S = e && e.__vue__.$store.state.PLP;
      return !!(S && S.products && S.products.length > 0);
    }, null, { timeout: 120000 });
    await page.waitForTimeout(3000);
    const res = await page.evaluate(`(${extractSrc})(${JSON.stringify(rev.marca)})`);
    // C1: codigos de hotspots de las paginas (common/data/maps.json)
    const hotspots = await page.evaluate(async (base) => {
      const j = await (await fetch(base + 'common/data/maps.json')).json();
      const set = new Set();
      Object.values(j.maps || {}).forEach(pg => (pg || []).forEach(h => (h.skus || []).forEach(s => {
        set.add(String(typeof s === 'object' && s ? (s.sku || s.id) : s));
      })));
      return [...set];
    }, rev.url);
    return { ...res, hotspots };
  } finally {
    await ctx.close();
  }
}

// ---------- controles ----------
function pct(n, d) { return d ? (100 * n / d) : 0; }

function controlar(lectura, prev) {
  const fallas = [];
  const avisos = [];
  const rows = [];
  for (const l of lectura) rows.push(...l.rows);

  // C2 unicidad
  const vistos = new Map();
  for (const r of rows) {
    if (vistos.has(r.codigo)) fallas.push(`C2: codigo repetido ${r.codigo} (${vistos.get(r.codigo)} y ${r.marca})`);
    vistos.set(r.codigo, r.marca);
  }
  // C3 completitud
  for (const r of rows) {
    if (!r.codigo || !r.producto || !(r.precio > 0)) fallas.push(`C3: fila incompleta ${JSON.stringify(r)}`);
  }
  for (const l of lectura) {
    const marca = l.marca;
    const n = l.rows.length;
    if (n < cfg.limites.minimoPorMarca) fallas.push(`${marca}: solo ${n} productos (minimo ${cfg.limites.minimoPorMarca})`);
    // C1 cobertura de hotspots
    const codigos = new Set(l.rows.map(r => r.codigo));
    const faltan = (l.hotspots || []).filter(c => !codigos.has(c));
    if (!l.hotspots || !l.hotspots.length) fallas.push(`C1: ${marca} no devolvio hotspots (no se puede verificar cobertura)`);
    else if (faltan.length) fallas.push(`C1: ${marca} tiene ${faltan.length} codigos de hotspots que no entraron al catalogo: ${faltan.slice(0, 15).join(', ')}`);
    if (l.stats.sinPrecio.length) avisos.push(`${marca}: ${l.stats.sinPrecio.length} variantes sin precio quedaron afuera (${l.stats.sinPrecio.slice(0, 10).join(', ')})`);
    if (l.stats.avonPromo && l.stats.avonPromo.length) avisos.push(`${marca}: ${l.stats.avonPromo.length} productos de Avon traen promo_price y se uso ese precio (el metodo dice sale_price para Avon): revisar contra la revista (${l.stats.avonPromo.slice(0, 8).join(', ')})`);
    if (l.stats.codigosExcluidos && l.stats.codigosExcluidos.length) avisos.push(`${marca}: ${l.stats.codigosExcluidos.length} codigos que no son solo digitos quedaron afuera (${l.stats.codigosExcluidos.slice(0, 6).join('; ')})`);
    if (l.stats.marcadores.length) avisos.push(`${marca}: ${l.stats.marcadores.length} marcadores del feed de stock quedaron afuera (${l.stats.marcadores.slice(0, 6).join(', ')})`);
  }

  // comparacion contra el catalogo publicado
  let diff = null;
  if (prev && prev.ciclo === cfg.ciclo) {
    const antes = new Map(prev.productos.map(p => [p[0], p]));
    const ahora = new Map(rows.map(r => [r.codigo, r]));
    const nuevos = [], quitados = [], precios = [], nombres = [];
    for (const r of rows) {
      const a = antes.get(r.codigo);
      if (!a) { nuevos.push(r); continue; }
      if (a[2] !== r.precio) precios.push({ codigo: r.codigo, producto: r.producto, antes: a[2], ahora: r.precio });
      if (a[1] !== r.producto) nombres.push({ codigo: r.codigo, antes: a[1], ahora: r.producto });
    }
    for (const [c, a] of antes) if (!ahora.has(c)) quitados.push({ codigo: c, producto: a[1], precio: a[2], marca: a[3] });
    // nombres cruzados: un codigo toma el nombre que tenia otro codigo (aviso, no frena)
    const nombreAntesDe = new Map();
    for (const p of prev.productos) if (!nombreAntesDe.has(p[1])) nombreAntesDe.set(p[1], p[0]);
    const cruzados = [];
    const vistosCruce = new Set();
    for (const n of nombres) {
      const otro = nombreAntesDe.get(n.ahora);
      if (otro && otro !== n.codigo && !vistosCruce.has(n.codigo)) {
        const tambien = nombres.find(m => m.codigo === otro && m.ahora === n.antes);
        if (tambien) { vistosCruce.add(n.codigo); vistosCruce.add(otro); cruzados.push([n.codigo, otro]); }
      }
    }
    diff = { nuevos, quitados, precios, nombres, cruzados };
    const L = cfg.limites;
    const base = prev.productos.length;
    if (pct(Math.abs(rows.length - base), base) > L.variacionTotalMaxPct) fallas.push(`C7: la cantidad paso de ${base} a ${rows.length} (mas de ${L.variacionTotalMaxPct}%)`);
    if (pct(quitados.length, base) > L.quitadosMaxPct) fallas.push(`Quitados: ${quitados.length} de ${base} (mas de ${L.quitadosMaxPct}%)`);
    if (pct(nuevos.length, base) > L.nuevosMaxPct) fallas.push(`Nuevos: ${nuevos.length} (mas de ${L.nuevosMaxPct}% del catalogo)`);
    if (pct(precios.length, base) > L.preciosCambiadosMaxPct) fallas.push(`Precios cambiados: ${precios.length} (mas de ${L.preciosCambiadosMaxPct}% del catalogo)`);
    if (cruzados.length) avisos.push(`NOMBRES CRUZADOS: ${cruzados.map(c => c[0] + ' y ' + c[1]).join('; ')} intercambiaron nombres respecto del catalogo publicado (se publica igual, la revista manda; conviene mirarlo)`);
    if (L.nombresCambiadosMaxPct && pct(nombres.length, base) > L.nombresCambiadosMaxPct) fallas.push(`Nombres cambiados: ${nombres.length} (mas de ${L.nombresCambiadosMaxPct}% del catalogo): probable lectura rota`);
    // una marca no puede desaparecer ni caer a la mitad
    const marcas = {};
    for (const p of prev.productos) marcas[p[3]] = (marcas[p[3]] || 0) + 1;
    for (const l of lectura) {
      const antesN = marcas[l.marca] || 0;
      if (antesN && l.rows.length < antesN * 0.5) fallas.push(`${l.marca}: bajo de ${antesN} a ${l.rows.length} productos`);
    }
  } else if (prev) {
    avisos.push(`Ciclo nuevo (${prev.ciclo} -> ${cfg.ciclo}): no se comparan cantidades contra el catalogo anterior.`);
  } else {
    avisos.push('Primera corrida: no hay catalogo anterior para comparar.');
  }
  return { fallas, avisos, diff, rows };
}

// ---------- salidas ----------
function csvCampo(v) {
  const s = String(v == null ? '' : v);
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

function armarCsv(rows) {
  const out = ['Código,Producto,Precio,Marca,Promo'];
  for (const r of rows) out.push([r.codigo, r.producto, r.precio, r.marca, r.promo].map(csvCampo).join(','));
  return '﻿' + out.join('\r\n') + '\r\n';
}

function armarInforme({ ok, fallas, avisos, diff, rows, lectura }) {
  const hoy = new Date().toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
  const L = [];
  L.push(`# Informe del catalogo, ciclo ${cfg.ciclo}`);
  L.push('');
  L.push(`Corrida: ${hoy}. Resultado: **${ok ? 'PUBLICADO' : 'NO PUBLICADO (se conserva el ultimo catalogo bueno)'}**.`);
  L.push('');
  const por = {};
  rows.forEach(r => { por[r.marca] = (por[r.marca] || 0) + 1; });
  L.push(`Productos: ${rows.length} (${Object.entries(por).map(([m, n]) => `${m} ${n}`).join(', ')}). Suma de precios: ${rows.reduce((a, r) => a + r.precio, 0)}.`);
  L.push('');
  if (fallas.length) { L.push('## Controles que fallaron'); fallas.forEach(f => L.push('- ' + f)); L.push(''); }
  if (avisos.length) { L.push('## Avisos'); avisos.forEach(a => L.push('- ' + a)); L.push(''); }
  const stock = rows.filter(r => r.fuente === 'agents-stock');
  if (stock.length) {
    L.push('## Productos del feed de stock incluidos (volatiles)');
    stock.forEach(r => L.push(`- ${r.codigo} ${r.producto} $${r.precio} (${r.marca})`));
    L.push('');
  }
  if (diff) {
    const lista = (t, arr, f) => { if (arr.length) { L.push(`## ${t} (${arr.length})`); arr.slice(0, 80).forEach(x => L.push('- ' + f(x))); if (arr.length > 80) L.push(`- ... y ${arr.length - 80} mas`); L.push(''); } };
    lista('Productos nuevos', diff.nuevos, r => `${r.codigo} ${r.producto} $${r.precio} (${r.marca})`);
    lista('Productos quitados', diff.quitados, r => `${r.codigo} ${r.producto} $${r.precio} (${r.marca})`);
    lista('Precios cambiados', diff.precios, r => `${r.codigo} ${r.producto}: $${r.antes} -> $${r.ahora}`);
    lista('Nombres cambiados', diff.nombres, r => `${r.codigo}: "${r.antes}" -> "${r.ahora}"`);
    if (!diff.nuevos.length && !diff.quitados.length && !diff.precios.length && !diff.nombres.length) { L.push('Sin cambios respecto del catalogo publicado.'); L.push(''); }
  }
  return L.join('\n');
}

// ---------- principal ----------
(async () => {
  fs.mkdirSync(SITE, { recursive: true });
  fs.mkdirSync(INFORMES, { recursive: true });
  let browser = null;
  if (!FIXTURE) {
    const { chromium } = require('playwright');
    browser = await chromium.launch();
  }
  const lectura = [];
  try {
    for (const rev of cfg.revistas) {
      console.log('Leyendo', rev.marca, rev.url);
      const l = await leerRevista(browser, rev);
      l.marca = rev.marca;
      // Avon: solo codigos de digitos. Los codigos con guion (ej. 10509-8, "- Contado") vienen del feed de stock, no figuran en la revista y no sirven para pedir.
      l.stats.codigosExcluidos = [];
      if (rev.marca === 'Avon') {
        const buenas = [];
        for (const r of l.rows) { if (/^\d+$/.test(String(r.codigo))) buenas.push(r); else l.stats.codigosExcluidos.push(`${r.codigo} ${r.producto}`); }
        l.rows = buenas;
      }
      console.log(`  ${rev.marca}: ${l.rows.length} productos, ${l.stats.marcadores.length} marcadores, ${l.stats.sinPrecio.length} sin precio`);
      lectura.push(l);
    }
  } catch (e) {
    const msg = `No se pudo leer la revista: ${e.message}`;
    fs.writeFileSync(path.join(INFORMES, 'ultimo.md'), `# Informe del catalogo, ciclo ${cfg.ciclo}\n\nResultado: **NO PUBLICADO**\n\n## Error\n- ${msg}\n`);
    console.error(msg);
    if (browser) await browser.close();
    process.exit(1);
  }
  if (browser) await browser.close();

  const prev = fs.existsSync(JSON_PATH) ? JSON.parse(fs.readFileSync(JSON_PATH, 'utf8')) : null;
  const { fallas, avisos, diff, rows } = controlar(lectura, prev);
  const ok = fallas.length === 0;
  const informe = armarInforme({ ok, fallas, avisos, diff, rows, lectura });
  fs.writeFileSync(path.join(INFORMES, 'ultimo.md'), informe);
  console.log(informe);

  if (!ok) { console.error('Controles fallidos: no se publica.'); process.exit(1); }

  const productos = rows.map(r => [r.codigo, r.producto, r.precio, r.marca, r.promo, r.fuente === 'agents-stock' ? 'stock' : '']);
  const mismo = prev && prev.ciclo === cfg.ciclo && JSON.stringify(prev.productos) === JSON.stringify(productos);
  if (mismo) { console.log('Sin cambios: se conserva el archivo publicado.'); return; }
  const marcas = {};
  rows.forEach(r => { marcas[r.marca] = (marcas[r.marca] || 0) + 1; });
  const salida = {
    version: 1,
    generado: new Date().toISOString(),
    ciclo: cfg.ciclo,
    total: rows.length,
    marcas,
    // cada producto: [codigo, nombre, precio, marca, promo, "stock" si viene del feed de stock]
    productos
  };
  fs.writeFileSync(JSON_PATH, JSON.stringify(salida));
  fs.writeFileSync(CSV_PATH, armarCsv(rows));
  console.log(`Publicado: ${rows.length} productos.`);
})().catch(e => { console.error(e); process.exit(1); });
