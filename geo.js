// Funções geográficas: eixo KMZ, cálculo de km e leitura do ortomosaico GeoTIFF.
const Geo = (() => {
  const R = 6371008.8;
  const rad = d => d * Math.PI / 180;

  function dist(a, b) {
    const x = rad(b[1] - a[1]) * Math.cos(rad((a[0] + b[0]) / 2));
    const y = rad(b[0] - a[0]);
    return Math.hypot(x, y) * R;
  }

  const textoNome = el => {
    const n = [...el.children].find(c => c.localName === 'name');
    return n ? n.textContent.trim() : '';
  };

  // Lê todas as linhas e os rótulos de km ("135+700") de um KMZ ou KML, inclusive os exportados de CAD.
  async function parseKmz(file) {
    let kml;
    if (/\.kml$/i.test(file.name || '')) {
      kml = await file.text();
    } else {
      const zip = await JSZip.loadAsync(file);
      const entry = Object.values(zip.files).find(f => /\.kml$/i.test(f.name));
      if (!entry) throw new Error('O KMZ não contém um arquivo KML.');
      kml = await entry.async('text');
    }
    const doc = new DOMParser().parseFromString(kml, 'text/xml');
    if (doc.querySelector('parsererror')) throw new Error('Não foi possível ler o KML.');
    const lines = [], marks = [];
    for (const pm of doc.getElementsByTagName('Placemark')) {
      const nome = textoNome(pm);
      for (const ls of pm.getElementsByTagName('LineString')) {
        const c = ls.getElementsByTagName('coordinates')[0];
        if (!c) continue;
        const coords = c.textContent.trim().split(/\s+/).map(t => {
          const [lon, lat] = t.split(',').map(Number);
          return [lat, lon];
        }).filter(p => Number.isFinite(p[0]) && Number.isFinite(p[1]));
        if (coords.length >= 2) lines.push({ name: nome, coords });
      }
      const m = /^(\d+)\+(\d{1,3})$/.exec(nome);
      if (m) {
        const pt = pm.getElementsByTagName('Point')[0];
        const c = pt && pt.getElementsByTagName('coordinates')[0];
        if (c) {
          const [lon, lat] = c.textContent.trim().split(',').map(Number);
          if (Number.isFinite(lat) && Number.isFinite(lon)) marks.push({ km: Number(m[1]) + Number(m[2]) / 1000, lat, lon });
        }
      }
    }
    if (!lines.length) throw new Error('Nenhuma linha encontrada no arquivo.');
    const docEl = doc.getElementsByTagName('Document')[0];
    return { nome: docEl ? textoNome(docEl) : '', arquivo: file.name || '', lines, marks };
  }

  function lengthOf(coords) {
    let t = 0;
    for (let i = 1; i < coords.length; i++) t += dist(coords[i - 1], coords[i]);
    return t;
  }

  // Posição mais próxima sobre uma linha: afastamento e distância desde o início dela.
  function project(coords, lat, lon) {
    const k = Math.cos(rad(lat));
    let along = 0, best = null;
    for (let i = 1; i < coords.length; i++) {
      const a = coords[i - 1], b = coords[i];
      const ax = rad(a[1] - lon) * k * R, ay = rad(a[0] - lat) * R;
      const bx = rad(b[1] - lon) * k * R, by = rad(b[0] - lat) * R;
      const dx = bx - ax, dy = by - ay;
      const l2 = dx * dx + dy * dy;
      const t = l2 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / l2)) : 0;
      const d = Math.hypot(ax + t * dx, ay + t * dy);
      const len = Math.sqrt(l2);
      if (!best || d < best.offset) best = { offset: d, along: along + t * len };
      along += len;
    }
    return best;
  }

  const mediana = v => { const o = [...v].sort((a, b) => a - b); return o[Math.floor(o.length / 2)]; };

  // Rótulos em série contínua. Ramais e pátios têm numeração própria (0+000, 100+000...).
  function maiorSerie(marks) {
    const o = [...marks].sort((a, b) => a.km - b.km);
    const series = [];
    for (const m of o) {
      const u = series[series.length - 1];
      if (u && m.km - u[u.length - 1].km <= 1) u.push(m); else series.push([m]);
    }
    return series.sort((a, b) => b.length - a.length)[0] || [];
  }

  // Escolhe a linha do eixo principal: a que melhor acompanha os rótulos de km.
  function buildAxis(parsed, info = {}) {
    const abertas = parsed.lines
      .map(l => ({ coords: l.coords, len: lengthOf(l.coords) }))
      .filter(l => dist(l.coords[0], l.coords[l.coords.length - 1]) > l.len * 0.1)
      .sort((a, b) => b.len - a.len);
    const serie = maiorSerie(parsed.marks);
    let melhor = null;
    if (serie.length >= 3) {
      const extensao = (serie[serie.length - 1].km - serie[0].km) * 1000;
      for (const l of abertas.slice(0, 80)) {
        if (l.len < extensao * 0.7) continue;
        const proj = serie.map(m => ({ km: m.km, ...project(l.coords, m.lat, m.lon) }));
        for (const sinal of [1, -1]) {
          const base = mediana(proj.map(p => p.km * 1000 - sinal * p.along));
          const bons = proj.filter(p => p.offset < 60 && Math.abs(p.km * 1000 - sinal * p.along - base) < 60);
          const erro = bons.reduce((t, p) => t + Math.abs(p.km * 1000 - sinal * p.along - base), 0) / (bons.length || 1);
          if (!melhor || bons.length > melhor.bons.length || (bons.length === melhor.bons.length && erro < melhor.erro)) {
            melhor = { l, bons, erro, sinal };
          }
        }
      }
    }
    const base = { pacote: info.pacote || '', segmento: info.segmento || '', origem: info.origem || parsed.arquivo };
    if (melhor && melhor.bons.length >= Math.max(3, serie.length * 0.5)) {
      const cal = melhor.bons.map(p => [p.along, p.km]).sort((a, b) => a[0] - b[0]);
      return { ...base, coords: melhor.l.coords, cal, sinal: melhor.sinal, marcos: cal.length, erro: melhor.erro, comprimento: melhor.l.len };
    }
    // Sem rótulos utilizáveis: maior linha aberta e km inicial informado no nome do arquivo.
    const linha = abertas[0];
    if (!linha) throw new Error('O arquivo não contém uma linha de eixo aberta.');
    const m = /km[-_ ]?(\d+)\+(\d{1,3})/i.exec(parsed.arquivo || '');
    const ini = m ? Number(m[1]) + Number(m[2]) / 1000 : 0;
    return { ...base, coords: linha.coords, cal: [[0, ini]], sinal: 1, marcos: 0, erro: null, comprimento: linha.len, semMarcos: !m };
  }

  function kmNaPosicao(eixo, along) {
    const c = eixo.cal;
    if (c.length === 1 || along <= c[0][0]) return c[0][1] + eixo.sinal * (along - c[0][0]) / 1000;
    const u = c[c.length - 1];
    if (along >= u[0]) return u[1] + eixo.sinal * (along - u[0]) / 1000;
    let i = 1;
    while (c[i][0] < along) i++;
    const f = (along - c[i - 1][0]) / ((c[i][0] - c[i - 1][0]) || 1);
    return c[i - 1][1] + f * (c[i][1] - c[i - 1][1]);
  }

  // Encontra o eixo mais próximo entre todos os segmentos carregados.
  function locate(eixos, lat, lon) {
    let best = null;
    for (const e of eixos || []) {
      const p = project(e.coords, lat, lon);
      if (p && (!best || p.offset < best.p.offset)) best = { e, p };
    }
    if (!best) return null;
    const km = kmNaPosicao(best.e, best.p.along);
    return { km, kmTexto: formatKm(km), offset: best.p.offset, pacote: best.e.pacote, segmento: best.e.segmento };
  }

  function formatKm(km) {
    const metros = Math.round(km * 1000);
    const k = Math.floor(metros / 1000);
    return `${k}+${String(metros - k * 1000).padStart(3, '0')}`;
  }

  // Sistemas usuais no Brasil: SIRGAS 2000 e WGS 84 em UTM, geográficos e Web Mercator.
  function crsDef(code) {
    if (code === 4326 || code === 4674) return '+proj=longlat +datum=WGS84 +no_defs';
    if (code === 3857) return '+proj=merc +a=6378137 +b=6378137 +lat_ts=0 +lon_0=0 +x_0=0 +y_0=0 +k=1 +units=m +no_defs';
    if (code >= 31978 && code <= 31985) return `+proj=utm +zone=${code - 31960} +south +ellps=GRS80 +units=m +no_defs`;
    if (code >= 32718 && code <= 32725) return `+proj=utm +zone=${code - 32700} +south +datum=WGS84 +units=m +no_defs`;
    return null;
  }

  // Converte o GeoTIFF em blocos de imagem leves, que ficam guardados no aparelho.
  function crsDePrj(prj) {
    const t = String(prj || '');
    const auth = [...t.matchAll(/AUTHORITY\s*\[\s*"EPSG"\s*,\s*"?(\d+)"?\s*\]/gi)].pop();
    if (auth && crsDef(Number(auth[1]))) return Number(auth[1]);
    const z = /UTM[ _]+Zone[ _]+(\d+)[ _]*([NS])?/i.exec(t);
    if (z && (z[2] || 'S').toUpperCase() === 'S') {
      if (/SIRGAS/i.test(t)) return 31960 + Number(z[1]);
      if (/WGS[ _]*(19)?84/i.test(t)) return 32700 + Number(z[1]);
    }
    if (/^\s*GEOGCS/i.test(t) && /(SIRGAS|WGS[ _]*(19)?84)/i.test(t)) return 4326;
    return null;
  }

  // Aceita .tif sozinho, .tif com .tfw e .prj, ou um .zip com esses arquivos.
  async function separarOrto(arquivos) {
    const lista = [];
    for (const f of arquivos) {
      if (/\.zip$/i.test(f.name || '')) {
        const zip = await JSZip.loadAsync(f);
        for (const z of Object.values(zip.files)) {
          if (z.dir || /(^|\/)__MACOSX\//.test(z.name)) continue;
          lista.push(new File([await z.async('blob')], z.name.split('/').pop()));
        }
      } else lista.push(f);
    }
    const tif = lista.find(f => /\.tiff?$/i.test(f.name));
    if (!tif) throw new Error('Nenhum arquivo .tif encontrado.');
    const tfw = lista.find(f => /\.(tfw|tifw|wld)$/i.test(f.name));
    const prj = lista.find(f => /\.prj$/i.test(f.name));
    return { tif, tfw: tfw ? await tfw.text() : null, prj: prj ? await prj.text() : null };
  }

  async function importOrtho(file, maxSide, onProgress, aux = {}) {
    const tiff = await GeoTIFF.fromBlob(file);
    const image = await tiff.getImage();
    const bits = image.getBitsPerSample();
    const format = image.fileDirectory.SampleFormat ? image.fileDirectory.SampleFormat[0] : 1;
    if (format === 3) throw new Error('Este arquivo contém valores numéricos (como um MDT), não uma imagem. Exporte o ortomosaico em RGB.');
    const keys = image.getGeoKeys() || {};
    let code = keys.ProjectedCSTypeGeoKey || keys.GeographicTypeGeoKey;
    if (!crsDef(code) && aux.prj) code = crsDePrj(aux.prj);
    const def = crsDef(code);
    if (!def) throw new Error(`Sistema de coordenadas não suportado (EPSG ${code || 'não informado'}). Exporte em SIRGAS 2000 / UTM ou WGS 84.`);
    const conv = proj4(def, 'WGS84');
    // A posição vem do próprio TIFF ou do arquivo .tfw que o acompanha.
    let box, mundo = null;
    try { box = image.getBoundingBox(); } catch (_) { box = null; }
    if (aux.tfw) {
      const v = aux.tfw.trim().split(/\s+/).map(Number);
      if (v.length >= 6 && v.every(Number.isFinite)) {
        if (Math.abs(v[1]) > 1e-9 || Math.abs(v[2]) > 1e-9) throw new Error('Imagem rotacionada não é suportada. Exporte sem rotação.');
        mundo = { resX: v[0], resY: Math.abs(v[3]), oeste: v[4] - v[0] / 2, norte: v[5] + Math.abs(v[3]) / 2 };
        if (!box || !(image.fileDirectory.ModelTiepoint || image.fileDirectory.ModelTransformation)) {
          box = [mundo.oeste, mundo.norte - mundo.resY * image.getHeight(), mundo.oeste + mundo.resX * image.getWidth(), mundo.norte];
        } else mundo = null;
      }
    }
    if (!box) throw new Error('O arquivo não informa a posição da imagem. Envie o .tif junto com o .tfw e o .prj.');

    // Limites em latitude e longitude, percorrendo as bordas da imagem.
    let w = 180, s = 90, e = -180, n = -90;
    for (let i = 0; i <= 20; i++) {
      const f = i / 20;
      const X = box[0] + f * (box[2] - box[0]), Y = box[1] + f * (box[3] - box[1]);
      for (const [x, y] of [[X, box[1]], [X, box[3]], [box[0], Y], [box[2], Y]]) {
        const [lo, la] = conv.forward([x, y]);
        w = Math.min(w, lo); e = Math.max(e, lo); s = Math.min(s, la); n = Math.max(n, la);
      }
    }
    const larguraM = rad(e - w) * Math.cos(rad((s + n) / 2)) * R;
    const alturaM = rad(n - s) * R;
    const natMax = Math.max(image.getWidth(), image.getHeight());
    const lado = Math.min(maxSide, natMax);
    const esc = lado / Math.max(larguraM, alturaM);
    const totalW = Math.max(1, Math.round(larguraM * esc)), totalH = Math.max(1, Math.round(alturaM * esc));
    const BLOCO = 2048;
    const cols = Math.ceil(totalW / BLOCO), rows = Math.ceil(totalH / BLOCO);
    const pieces = [];
    const nodata = image.getGDALNoData();
    const canvas = document.createElement('canvas');

    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        onProgress && onProgress((r * cols + c) / (rows * cols));
        const pw = Math.min(BLOCO, totalW - c * BLOCO), ph = Math.min(BLOCO, totalH - r * BLOCO);
        const pieceW = w + (e - w) * (c * BLOCO) / totalW;
        const pieceE = w + (e - w) * (c * BLOCO + pw) / totalW;
        const pieceN = n - (n - s) * (r * BLOCO) / totalH;
        const pieceS = n - (n - s) * (r * BLOCO + ph) / totalH;

        // Grade de conversão: 33 x 33 nós, interpolados para ganhar velocidade.
        const G = 32;
        const grid = new Float64Array((G + 1) * (G + 1) * 2);
        let sx0 = Infinity, sy0 = Infinity, sx1 = -Infinity, sy1 = -Infinity;
        for (let j = 0; j <= G; j++) {
          for (let i = 0; i <= G; i++) {
            const lo = pieceW + (pieceE - pieceW) * i / G, la = pieceN + (pieceS - pieceN) * j / G;
            const [x, y] = conv.inverse([lo, la]);
            const k = (j * (G + 1) + i) * 2;
            grid[k] = x; grid[k + 1] = y;
            sx0 = Math.min(sx0, x); sx1 = Math.max(sx1, x); sy0 = Math.min(sy0, y); sy1 = Math.max(sy1, y);
          }
        }
        const src = [Math.max(sx0, box[0]), Math.max(sy0, box[1]), Math.min(sx1, box[2]), Math.min(sy1, box[3])];
        if (src[2] <= src[0] || src[3] <= src[1]) continue;
        const rasters = mundo
          ? await image.readRasters({
              window: [Math.max(0, Math.floor((src[0] - mundo.oeste) / mundo.resX)), Math.max(0, Math.floor((mundo.norte - src[3]) / mundo.resY)),
                Math.min(image.getWidth(), Math.ceil((src[2] - mundo.oeste) / mundo.resX)), Math.min(image.getHeight(), Math.ceil((mundo.norte - src[1]) / mundo.resY))],
              width: pw, height: ph
            })
          : await tiff.readRasters({ bbox: src, width: pw, height: ph });
        const bands = rasters.length;
        const rw = rasters.width, rh = rasters.height;
        const scale = bits > 8 ? 255 / (Math.pow(2, bits) - 1) : 1;

        canvas.width = pw; canvas.height = ph;
        const ctx = canvas.getContext('2d');
        const out = ctx.createImageData(pw, ph);
        let opacos = 0;
        for (let y = 0; y < ph; y++) {
          const gy = y / ph * G, j0 = Math.min(G - 1, Math.floor(gy)), fy = gy - j0;
          for (let x = 0; x < pw; x++) {
            const gx = x / pw * G, i0 = Math.min(G - 1, Math.floor(gx)), fx = gx - i0;
            const a = (j0 * (G + 1) + i0) * 2, b = a + 2, d = a + (G + 1) * 2, f = d + 2;
            const X = (grid[a] * (1 - fx) + grid[b] * fx) * (1 - fy) + (grid[d] * (1 - fx) + grid[f] * fx) * fy;
            const Y = (grid[a + 1] * (1 - fx) + grid[b + 1] * fx) * (1 - fy) + (grid[d + 1] * (1 - fx) + grid[f + 1] * fx) * fy;
            if (X < src[0] || X >= src[2] || Y < src[1] || Y >= src[3]) continue;
            const sx = Math.min(rw - 1, Math.floor((X - src[0]) / (src[2] - src[0]) * rw));
            const sy = Math.min(rh - 1, Math.floor((src[3] - Y) / (src[3] - src[1]) * rh));
            const p = sy * rw + sx;
            const R0 = rasters[0][p], G0 = bands >= 3 ? rasters[1][p] : R0, B0 = bands >= 3 ? rasters[2][p] : R0;
            const alpha = bands === 4 ? rasters[3][p] : bands === 2 ? rasters[1][p] : 1;
            if (alpha === 0 || (R0 === 0 && G0 === 0 && B0 === 0) || (nodata !== null && R0 === nodata && G0 === nodata && B0 === nodata)) continue;
            const o = (y * pw + x) * 4;
            out.data[o] = R0 * scale; out.data[o + 1] = G0 * scale; out.data[o + 2] = B0 * scale; out.data[o + 3] = 255;
            opacos++;
          }
        }
        if (!opacos) continue;
        ctx.putImageData(out, 0, 0);
        let blob = await new Promise(res => canvas.toBlob(res, 'image/webp', 0.8));
        if (!blob || blob.type !== 'image/webp') {
          // O iPhone não gera WebP. O JPEG não tem transparência, então o fundo fica cinza.
          ctx.globalCompositeOperation = 'destination-over';
          ctx.fillStyle = '#d9dfdc';
          ctx.fillRect(0, 0, pw, ph);
          ctx.globalCompositeOperation = 'source-over';
          blob = await new Promise(res => canvas.toBlob(res, 'image/jpeg', 0.8));
        }
        pieces.push({ bounds: [[pieceS, pieceW], [pieceN, pieceE]], blob });
      }
    }
    canvas.width = canvas.height = 0;
    onProgress && onProgress(1);
    if (!pieces.length) throw new Error('A imagem não contém áreas visíveis.');
    const resolucao = Math.max(larguraM / totalW, alturaM / totalH);
    return { bounds: [[s, w], [n, e]], pieces, resolucao };
  }

  return { dist, parseKmz, buildAxis, locate, formatKm, importOrtho, separarOrto, lengthOf };
})();
