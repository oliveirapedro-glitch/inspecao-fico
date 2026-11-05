'use strict';
/* App de inspeção: os dados ficam primeiro no aparelho (IndexedDB) e seguem para o Drive ao sincronizar. */
const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const agora = () => new Date().toISOString();
const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : 'id-' + Date.now() + '-' + Math.random().toString(16).slice(2));
const dataBR = iso => iso ? new Date(iso).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' }) : '';
const STATUS_COR = { 'A verificar': 's-averificar', 'Verificado': 's-verificado', 'Requer ação': 's-requeracao' };

/* ---------- Banco local ---------- */
let db;
function abrirDB() {
  return new Promise((res, rej) => {
    const r = indexedDB.open('inspecao-fico', 1);
    r.onupgradeneeded = () => {
      const d = r.result;
      d.createObjectStore('pontos', { keyPath: 'id' });
      d.createObjectStore('fotos', { keyPath: 'id' }).createIndex('pontoId', 'pontoId');
      d.createObjectStore('kv');
      d.createObjectStore('ortos', { keyPath: 'id' });
      d.createObjectStore('ortoBlocos');
    };
    r.onsuccess = () => { db = r.result; res(); };
    r.onerror = () => rej(r.error);
  });
}
function req(store, modo, fn) {
  return new Promise((res, rej) => {
    const tx = db.transaction(store, modo);
    const q = fn(tx.objectStore(store));
    tx.oncomplete = () => res(q && q.result);
    tx.onerror = tx.onabort = () => rej(tx.error);
  });
}
const dbGet = (s, k) => req(s, 'readonly', o => o.get(k));
const dbAll = s => req(s, 'readonly', o => o.getAll());
const dbPut = (s, v, k) => req(s, 'readwrite', o => k === undefined ? o.put(v) : o.put(v, k));
const dbDel = (s, k) => req(s, 'readwrite', o => o.delete(k));
const fotosDoPonto = id => req('fotos', 'readonly', o => o.index('pontoId').getAll(id));

/* ---------- Estado ---------- */
const S = { nome: '', url: '', chave: '', etapa: 'Pré-inspeção', cursor: 0, eixos: [], catalogo: [] };
let pontos = [];
let atual = null;       // ponto aberto na ficha
let novoAtual = false;  // ficha de ponto ainda não salvo
let kmManual = false;
let localAuto = false;   // local veio do GPS do aparelho, não de uma escolha do usuário
let minhaPos = null;
let sincronizando = false;

async function carregar() {
  for (const k of Object.keys(S)) {
    const v = await dbGet('kv', k);
    if (v !== undefined) S[k] = v;
  }
  pontos = (await dbAll('pontos')).filter(p => !p.excluido);
}
const salvarS = k => dbPut('kv', S[k], k);

function toast(msg, ms = 3500) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toast.t);
  toast.t = setTimeout(() => { t.hidden = true; }, ms);
}

/* ---------- Mapa ---------- */
let map, camadaEixo, camadaPontos, camadaFotos, camadaProjeto, camadaKm, marcadorEu;
const blocosVisiveis = new Map();
let blocosMeta = [];

function iniciarMapa() {
  map = L.map('map', { zoomControl: true, maxZoom: 22 }).setView([-13.5, -50.5], 7);
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 22, maxNativeZoom: 19, attribution: '© OpenStreetMap' }).addTo(map);
  map.createPane('orto').style.zIndex = 300;
  map.createPane('projeto').style.zIndex = 350;
  camadaProjeto = L.layerGroup().addTo(map);
  camadaKm = L.layerGroup().addTo(map);
  camadaEixo = L.layerGroup().addTo(map);
  camadaFotos = L.layerGroup().addTo(map);
  camadaPontos = L.layerGroup().addTo(map);
  L.control.layers(null, { 'Projeto (KMZ)': camadaProjeto, 'Rótulos de km': camadaKm, 'Eixo principal': camadaEixo, 'Local de cada foto': camadaFotos }, { position: 'topright' }).addTo(map);
  map.on('moveend', atualizarBlocos);
  const rotulos = () => map.getContainer().classList.toggle('sem-km', map.getZoom() < 15);
  map.on('zoomend', rotulos);
  rotulos();
  map.on('click', e => { if (escolhendo) concluirEscolha(e.latlng); });
  desenharEixo();
  desenharProjeto();
  desenharPontos();
  carregarOrtos();
  enquadrar();
}
function enquadrar() {
  const coords = pontos.filter(p => temLoc(p)).map(p => [Number(p.lat), Number(p.lon)]);
  if (coords.length) map.fitBounds(coords, { maxZoom: 17, padding: [40, 40] });
  else if (S.eixos.length) map.fitBounds(S.eixos.flatMap(e => e.coords));
}
const temLoc = p => p.lat !== '' && p.lon !== '' && Number.isFinite(Number(p.lat)) && Number.isFinite(Number(p.lon));
function desenharEixo() {
  if (!camadaEixo) return;
  camadaEixo.clearLayers();
  for (const e of S.eixos) L.polyline(e.coords, { color: '#f7890a', weight: 4 }).bindTooltip([e.pacote, e.segmento].filter(Boolean).join(' · ') || 'Eixo').addTo(camadaEixo);
}
const chaveDesenho = x => `desenho|${x.pacote}|${x.segmento}`;
async function salvarDesenho(eixo, parsed) {
  await dbPut('kv', { grupos: parsed.desenho, marcos: parsed.marks }, chaveDesenho(eixo));
}
async function desenharProjeto() {
  if (!camadaProjeto) return;
  camadaProjeto.clearLayers();
  camadaKm.clearLayers();
  const renderer = L.canvas({ pane: 'projeto', padding: 0.2 });
  for (const e of S.eixos) {
    const d = await dbGet('kv', chaveDesenho(e));
    if (!d) continue;
    for (const [cor, linhas] of Object.entries(d.grupos)) {
      L.polyline(linhas, { color: cor, weight: 1.2, opacity: 0.95, interactive: false, renderer }).addTo(camadaProjeto);
    }
    for (const m of d.marcos) {
      L.marker([m.lat, m.lon], { interactive: false, keyboard: false, icon: L.divIcon({ className: 'kmrot', html: esc(m.texto), iconSize: null }) }).addTo(camadaKm);
    }
  }
}
async function desenharFotosMapa() {
  if (!camadaFotos) return;
  const ids = new Set(pontos.map(p => p.id));
  const fotos = (await dbAll('fotos')).filter(f => !f.excluido && ids.has(f.pontoId) && f.lat !== '' && f.lon !== '' && Number.isFinite(Number(f.lat)));
  camadaFotos.clearLayers();
  for (const f of fotos) {
    L.circleMarker([Number(f.lat), Number(f.lon)], { radius: 5, color: '#fff', weight: 1.5, fillColor: '#0f6cbd', fillOpacity: 1 }).on('click', () => abrirPonto(f.pontoId)).addTo(camadaFotos);
  }
}
function desenharPontos() {
  if (!camadaPontos) return;
  desenharFotosMapa();
  camadaPontos.clearLayers();
  for (const p of pontos) {
    if (!temLoc(p)) continue;
    const icon = L.divIcon({ className: '', html: `<div class="pin ${STATUS_COR[p.status] || 's-averificar'}"></div>`, iconSize: [22, 22], iconAnchor: [11, 11] });
    L.marker([Number(p.lat), Number(p.lon)], { icon, title: p.resumo }).on('click', () => abrirPonto(p.id)).addTo(camadaPontos);
  }
}
async function carregarOrtos() {
  blocosMeta = [];
  for (const o of await dbAll('ortos')) for (const b of o.blocos) blocosMeta.push(b);
  for (const [, v] of blocosVisiveis) { map.removeLayer(v.layer); URL.revokeObjectURL(v.url); }
  blocosVisiveis.clear();
  atualizarBlocos();
}
async function atualizarBlocos() {
  if (!map) return;
  const vista = map.getBounds().pad(0.3);
  for (const b of blocosMeta) {
    const visivel = vista.intersects(L.latLngBounds(b.bounds));
    const ativo = blocosVisiveis.get(b.id);
    if (visivel && !ativo) {
      blocosVisiveis.set(b.id, { pending: true });
      const blob = await dbGet('ortoBlocos', b.id);
      if (!blob) { blocosVisiveis.delete(b.id); continue; }
      const url = URL.createObjectURL(blob);
      const layer = L.imageOverlay(url, b.bounds, { pane: 'orto' }).addTo(map);
      blocosVisiveis.set(b.id, { layer, url });
    } else if (!visivel && ativo && ativo.layer) {
      map.removeLayer(ativo.layer);
      URL.revokeObjectURL(ativo.url);
      blocosVisiveis.delete(b.id);
    }
  }
}

/* GPS */
function iniciarGps() {
  if (!navigator.geolocation) return;
  navigator.geolocation.watchPosition(pos => {
    minhaPos = { lat: pos.coords.latitude, lon: pos.coords.longitude, prec: pos.coords.accuracy };
    if (map) {
      if (!marcadorEu) marcadorEu = L.marker([minhaPos.lat, minhaPos.lon], { interactive: false, icon: L.divIcon({ className: '', html: '<div class="eu"></div>', iconSize: [16, 16], iconAnchor: [8, 8] }) }).addTo(map);
      else marcadorEu.setLatLng([minhaPos.lat, minhaPos.lon]);
    }
    if (atual) mostrarDist();
  }, () => {}, { enableHighAccuracy: true, maximumAge: 5000 });
}
function posicaoAtual() {
  return new Promise(res => {
    if (!navigator.geolocation) return res(minhaPos);
    navigator.geolocation.getCurrentPosition(
      p => { minhaPos = { lat: p.coords.latitude, lon: p.coords.longitude, prec: p.coords.accuracy }; res(minhaPos); },
      () => res(minhaPos), { enableHighAccuracy: true, timeout: 15000, maximumAge: 10000 });
  });
}

/* ---------- Navegação ---------- */
function abrirAba(id) {
  document.querySelectorAll('.tab').forEach(t => { t.hidden = t.id !== id; });
  document.querySelectorAll('nav button').forEach(b => b.classList.toggle('on', b.dataset.tab === id));
  if (id === 'tabMapa' && map) setTimeout(() => { map.invalidateSize(); atualizarBlocos(); }, 30);
  if (id === 'tabPontos') desenharLista();
  if (id === 'tabRelatorio') prepararRelatorio();
  if (id === 'tabAjustes') mostrarAjustes();
}
function mostrarEtapa() {
  $('#etapaPre').classList.toggle('on', S.etapa === 'Pré-inspeção');
  $('#etapaCampo').classList.toggle('on', S.etapa === 'Campo');
}

/* ---------- Lista ---------- */
function desenharLista() {
  const termo = $('#busca').value.trim().toLowerCase();
  const st = $('#filtroStatus').value;
  const sel = pontos
    .filter(p => (!st || p.status === st) && (!termo || [p.pacote, p.segmento, p.km, p.resumo, p.descricao, p.codigo].join(' ').toLowerCase().includes(termo)))
    .sort(ordemPontos);
  $('#lista').innerHTML = sel.length ? sel.map(p => `
    <li data-id="${esc(p.id)}"${modoAgrupar && selecionadosGrupo.has(p.id) ? ' class="sel"' : ''}>
      ${modoAgrupar ? `<span class="marca">${selecionadosGrupo.has(p.id) ? '✓' : ''}</span>` : `<span class="bola ${STATUS_COR[p.status] || ''}"></span>`}
      <div class="corpo">
        <div class="tit">${esc(p.resumo || '(sem resumo)')}</div>
        <div class="meta">${[p.pacote, p.segmento, p.km && 'km ' + p.km].filter(Boolean).map(esc).join(' · ') || 'Sem localização na obra'}</div>
        <div class="meta">${esc(p.status)} · ${esc(p.origem)}${minhaPos && temLoc(p) ? ' · ' + distTxt(Geo.dist([minhaPos.lat, minhaPos.lon], [Number(p.lat), Number(p.lon)])) : ''}</div>
      </div>
      ${p.dirty ? '<span class="chip">não enviado</span>' : ''}
    </li>`).join('') : '<li class="vazio">Nenhum ponto. Crie um ponto ou importe fotos de drone.</li>';
}
function ordemPontos(a, b) {
  const k = x => { const m = /^(\d+)\+(\d+)$/.exec(x.km || ''); return m ? Number(m[1]) * 1000 + Number(m[2]) : Infinity; };
  return (a.pacote || '').localeCompare(b.pacote || '', 'pt-BR', { numeric: true }) || k(a) - k(b) || (a.criadoEm || '').localeCompare(b.criadoEm || '');
}
const distTxt = m => m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(1).replace('.', ',')} km`;

/* ---------- Ficha do ponto ---------- */
function novoPonto(lat = '', lon = '') {
  const id = uuid();
  return {
    id, codigo: 'P-' + agora().slice(0, 10).replace(/-/g, '') + '-' + id.replace(/-/g, '').slice(0, 4).toUpperCase(),
    pacote: '', segmento: '', km: '', resumo: '', descricao: '', obsCampo: '', status: 'A verificar',
    origem: S.etapa, lat, lon, criadoPor: S.nome, criadoEm: agora(), atualizadoPor: S.nome, atualizadoEm: agora(), excluido: '', dirty: 1
  };
}
function preencherListas() {
  const opts = c => [...new Set(pontos.map(p => p[c]).filter(Boolean))].sort().map(v => `<option value="${esc(v)}">`).join('');
  $('#listaPacotes').innerHTML = opts('pacote');
  $('#listaSegmentos').innerHTML = opts('segmento');
}
async function abrirNovo() {
  atual = novoPonto();
  novoAtual = true;
  kmManual = false;
  localAuto = false;
  mostrarFicha();
  const pos = await posicaoAtual();
  if (atual && novoAtual && pos && $('#fLat').value === '') { definirLocal(pos.lat, pos.lon); localAuto = true; }
}
function abrirPonto(id) {
  const p = pontos.find(x => x.id === id);
  if (!p) return;
  atual = { ...p };
  novoAtual = false;
  localAuto = false;
  kmManual = !!p.km;
  mostrarFicha();
}
function mostrarFicha() {
  preencherListas();
  const p = atual;
  $('#fichaTitulo').textContent = novoAtual ? 'Novo ponto' : p.codigo;
  $('#fPacote').value = p.pacote; $('#fSegmento').value = p.segmento; $('#fKm').value = p.km;
  $('#fResumo').value = p.resumo; $('#fDescricao').value = p.descricao; $('#fObs').value = p.obsCampo;
  $('#fStatus').value = p.status; $('#fLat').value = temLoc(p) ? Number(p.lat).toFixed(8) : ''; $('#fLon').value = temLoc(p) ? Number(p.lon).toFixed(8) : '';
  mostrarUtm();
  $('#btnExcluir').hidden = novoAtual;
  $('#ficha').hidden = false;
  mostrarEixo(); mostrarDist(); desenharFotos();
}
const num2 = v => v.toFixed(2).replace('.', ',');
function utmTxt(lat, lon) {
  if (lat === '' || lon === '' || lat === null || !Number.isFinite(Number(lat)) || !Number.isFinite(Number(lon))) return '';
  const u = Geo.toUtm(Number(lat), Number(lon));
  return `UTM ${u.zonaTexto} · E ${num2(u.e)} · N ${num2(u.n)}`;
}
function mostrarUtm() {
  const l = lerLocal();
  if (!l) { $('#fE').value = ''; $('#fN').value = ''; $('#fZona').value = ''; return; }
  const u = Geo.toUtm(l.lat, l.lon);
  $('#fZona').value = u.zonaTexto; $('#fE').value = num2(u.e); $('#fN').value = num2(u.n);
}
function lerUtmDigitado() {
  const n = id => parseFloat(String($(id).value).trim().replace(/\s/g, '').replace(',', '.'));
  const r = Geo.fromUtm(n('#fE'), n('#fN'), $('#fZona').value);
  if (!r) { toast('Coordenada UTM inválida. Confira zona, E e N.', 5000); mostrarUtm(); return; }
  localAuto = false;
  $('#fLat').value = r.lat.toFixed(8); $('#fLon').value = r.lon.toFixed(8);
  mostrarEixo(); mostrarDist();
}
function definirLocal(lat, lon) {
  $('#fLat').value = Number(lat).toFixed(8);
  $('#fLon').value = Number(lon).toFixed(8);
  mostrarUtm(); mostrarEixo(); mostrarDist();
}
function lerLocal() {
  const lat = parseFloat(String($('#fLat').value).replace(',', '.'));
  const lon = parseFloat(String($('#fLon').value).replace(',', '.'));
  return Number.isFinite(lat) && Number.isFinite(lon) ? { lat, lon } : null;
}
function mostrarEixo() {
  const el = $('#fEixo');
  const l = lerLocal();
  el.className = 'sub';
  if (!l) { el.textContent = 'Defina a localização para calcular o km.'; return; }
  const r = Geo.locate(S.eixos, l.lat, l.lon);
  if (!r) { el.textContent = 'Sincronize ou importe o eixo em Ajustes para calcular o km.'; return; }
  el.textContent = `Km calculado: ${r.kmTexto} · ${distTxt(r.offset)} do eixo · ${[r.pacote, r.segmento].filter(Boolean).join(' · ')}`;
  if (r.offset > 1000) { el.className = 'sub alerta'; el.textContent = `Ponto a ${distTxt(r.offset)} do eixo mais próximo: preencha Pacote, Segmento e KM manualmente.`; return; }
  if (!kmManual) $('#fKm').value = r.kmTexto;
  if (!$('#fPacote').value) $('#fPacote').value = r.pacote || '';
  if (!$('#fSegmento').value) $('#fSegmento').value = r.segmento || '';
}
function mostrarDist() {
  const l = lerLocal();
  const el = $('#fDist');
  if (!l) { el.textContent = ''; return; }
  el.textContent = minhaPos
    ? `Distância até o ponto: ${distTxt(Geo.dist([minhaPos.lat, minhaPos.lon], [l.lat, l.lon]))} · precisão do GPS: ±${Math.round(minhaPos.prec || 0)} m`
    : 'Aguardando sinal do GPS.';
}
async function fecharFicha() {
  if (novoAtual && atual) {
    for (const f of await fotosDoPonto(atual.id)) await dbDel('fotos', f.id);
  }
  atual = null;
  $('#ficha').hidden = true;
}
async function salvarFicha(e) {
  e.preventDefault();
  const l = lerLocal();
  if (!l) { toast('Defina a localização antes de salvar.'); return; }
  Object.assign(atual, {
    pacote: $('#fPacote').value.trim(), segmento: $('#fSegmento').value.trim(), km: $('#fKm').value.trim(),
    resumo: $('#fResumo').value.trim(), descricao: $('#fDescricao').value.trim(), obsCampo: $('#fObs').value.trim(),
    status: $('#fStatus').value, lat: l.lat, lon: l.lon, atualizadoPor: S.nome, atualizadoEm: agora(), dirty: 1
  });
  await dbPut('pontos', atual);
  const i = pontos.findIndex(p => p.id === atual.id);
  if (i >= 0) pontos[i] = atual; else pontos.push(atual);
  atual = null; novoAtual = false;
  $('#ficha').hidden = true;
  desenharPontos(); desenharLista(); atualizarPendentes();
  toast('Ponto salvo neste aparelho.');
}
async function excluirPonto() {
  if (!confirm('Excluir este ponto e as fotos dele?')) return;
  const stamp = agora();
  atual.excluido = '1'; atual.dirty = 1; atual.atualizadoEm = stamp; atual.atualizadoPor = S.nome;
  await dbPut('pontos', atual);
  for (const f of await fotosDoPonto(atual.id)) {
    f.excluido = '1'; f.dirty = 1; f.atualizadoEm = stamp;
    await dbPut('fotos', f);
  }
  pontos = pontos.filter(p => p.id !== atual.id);
  atual = null; $('#ficha').hidden = true;
  desenharPontos(); desenharLista(); atualizarPendentes();
}

/* ---------- Fotos ---------- */
function reduzirImagem(file, lado = 2048, q = 0.82) {
  return new Promise((res, rej) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const k = Math.min(1, lado / Math.max(img.naturalWidth, img.naturalHeight));
      const c = document.createElement('canvas');
      c.width = Math.round(img.naturalWidth * k); c.height = Math.round(img.naturalHeight * k);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(url);
      c.toBlob(b => { c.width = c.height = 0; b ? res(b) : rej(new Error('Falha ao comprimir a foto.')); }, 'image/jpeg', q);
    };
    img.onerror = () => { URL.revokeObjectURL(url); rej(new Error(`Formato de imagem não suportado: ${file.name}`)); };
    img.src = url;
  });
}
async function lerGpsFoto(file) {
  try { const g = await exifr.gps(file); if (g && Number.isFinite(g.latitude) && Number.isFinite(g.longitude)) return { lat: g.latitude, lon: g.longitude }; } catch (_) {}
  return null;
}
async function lerDataFoto(file) {
  try { const e = await exifr.parse(file); if (e && e.DateTimeOriginal instanceof Date && !isNaN(e.DateTimeOriginal)) return e.DateTimeOriginal.toISOString(); } catch (_) {}
  return file.lastModified ? new Date(file.lastModified).toISOString() : null;
}
const dataCurta = iso => new Date(iso || Date.now()).toLocaleDateString('pt-BR');
const nomeInspecao = (iso, compl) => `Inspeção realizada (${dataCurta(iso)}): ${compl}`.slice(0, 140);
const nomePadrao = t => /^(Foto de drone|Inspeção realizada)/.test(t || '');
function centroide(lista) {
  return { lat: lista.reduce((t, x) => t + Number(x.lat), 0) / lista.length, lon: lista.reduce((t, x) => t + Number(x.lon), 0) / lista.length };
}
function aplicarLocal(p, lat, lon) {
  p.lat = lat; p.lon = lon;
  const r = Geo.locate(S.eixos, lat, lon);
  if (r && r.offset <= 1000) { p.km = r.kmTexto; p.pacote = p.pacote || r.pacote || ''; p.segmento = p.segmento || r.segmento || ''; }
}
async function criarFoto(file, pontoId, daCamera = false) {
  const gps = await lerGpsFoto(file);
  const data = await lerDataFoto(file);
  const blob = await reduzirImagem(file);
  const foto = {
    id: uuid(), pontoId, fase: S.etapa, legenda: '', lat: gps ? gps.lat : (daCamera && minhaPos ? minhaPos.lat : ''), lon: gps ? gps.lon : (daCamera && minhaPos ? minhaPos.lon : ''),
    tiradaEm: data || agora(), criadoPor: S.nome, atualizadoEm: agora(), driveId: '', url: '', excluido: '', dirty: 1, blob
  };
  await dbPut('fotos', foto);
  return { foto, gps };
}
async function adicionarFotos(files, daCamera = false) {
  if (!atual) return;
  let erros = 0, semLocal = 0;
  for (const file of files) {
    try {
      const { gps } = await criarFoto(file, atual.id, daCamera);
      // A foto antiga indica onde o ponto está; o GPS atual do aparelho pode estar em outro lugar.
      if (gps && (!lerLocal() || localAuto)) { definirLocal(gps.lat, gps.lon); localAuto = false; }
      if (!gps && !daCamera) semLocal++;
    } catch (e) { erros++; toast(e.message); }
  }
  await desenharFotos();
  atualizarPendentes();
  if (semLocal && localAuto) toast('Foto sem coordenadas. Use “Escolher no mapa” para indicar o local do ponto.', 7000);
  else if (!erros) toast('Foto guardada. Salve o ponto ao terminar.');
}
let urlsFicha = [];
async function desenharFotos() {
  urlsFicha.forEach(URL.revokeObjectURL); urlsFicha = [];
  const fotos = (await fotosDoPonto(atual.id)).filter(f => !f.excluido);
  $('#fFotos').innerHTML = fotos.map(f => {
    let visual = '<div class="falta">Foto ainda não baixada. Sincronize com internet.</div>';
    if (f.blob) { const u = URL.createObjectURL(f.blob); urlsFicha.push(u); visual = `<img src="${u}" alt="">`; }
    return `<div class="foto" data-id="${esc(f.id)}">${visual}
      <input class="legenda" value="${esc(f.legenda)}" placeholder="Legenda" aria-label="Legenda">
      <div class="pe"><span>${esc(f.fase)}<br>${esc(utmTxt(f.lat, f.lon)) || 'Sem coordenadas'}</span><button type="button" class="tirar">Remover</button></div></div>`;
  }).join('');
}
async function editarFoto(id, alt) {
  const f = await dbGet('fotos', id);
  if (!f) return;
  Object.assign(f, alt, { atualizadoEm: agora(), dirty: 1 });
  await dbPut('fotos', f);
  atualizarPendentes();
}
let arquivosImportar = [];
function pedirModoImportacao(files) {
  arquivosImportar = files;
  $('#dlgTexto').textContent = `${files.length} foto(s) selecionada(s). Como deseja registrar?`;
  $('#dlgImport').hidden = false;
}
async function importarUmPorFoto(lista) {
  let criados = 0, semGps = 0, erros = 0;
  for (let i = 0; i < lista.length; i++) {
    toast(`Processando foto ${i + 1} de ${lista.length}…`, 60000);
    const file = lista[i];
    try {
      const gps = await lerGpsFoto(file);
      if (!gps) { semGps++; continue; }
      const p = novoPonto(gps.lat, gps.lon);
      p.resumo = nomeInspecao(await lerDataFoto(file), file.name);
      aplicarLocal(p, gps.lat, gps.lon);
      await criarFoto(file, p.id);
      await dbPut('pontos', p);
      pontos.push(p);
      criados++;
    } catch (_) { erros++; }
  }
  desenharPontos(); desenharLista(); atualizarPendentes();
  toast(`${criados} ponto(s) criado(s).` + (semGps ? ` ${semGps} foto(s) sem coordenadas ficaram de fora: ative a localização ao selecionar ou adicione-as em um ponto.` : '') + (erros ? ` ${erros} com erro.` : ''), 7000);
}
// Um apontamento para várias fotos. Cada foto mantém as próprias coordenadas.
async function importarAgrupado(lista) {
  const p = novoPonto();
  const criadas = [];
  let erros = 0;
  for (let i = 0; i < lista.length; i++) {
    toast(`Processando foto ${i + 1} de ${lista.length}…`, 60000);
    try { criadas.push((await criarFoto(lista[i], p.id)).foto); } catch (_) { erros++; }
  }
  const comGps = criadas.filter(f => f.lat !== '' && f.lon !== '');
  if (!comGps.length) {
    for (const f of criadas) await dbDel('fotos', f.id);
    toast('Nenhuma foto tem coordenadas. Ative a localização ao selecionar ou use + Novo ponto e escolha o local no mapa.', 8000);
    atualizarPendentes();
    return;
  }
  const c = centroide(comGps);
  aplicarLocal(p, c.lat, c.lon);
  p.resumo = nomeInspecao(criadas[0].tiradaEm, `${criadas.length} foto(s)`);
  await dbPut('pontos', p);
  pontos.push(p);
  desenharPontos(); desenharLista(); atualizarPendentes();
  toast(`Apontamento criado com ${criadas.length} foto(s).` + (erros ? ` ${erros} com erro.` : ''), 6000);
  abrirPonto(p.id);
}

/* Agrupar pontos que já existem */
let modoAgrupar = false;
const selecionadosGrupo = new Set();
function alternarAgrupar(ligar) {
  modoAgrupar = ligar;
  selecionadosGrupo.clear();
  $('#barraGrupo').hidden = !ligar;
  $('#acoesPontos').hidden = ligar;
  atualizarBarraGrupo();
  desenharLista();
}
function atualizarBarraGrupo() {
  const n = selecionadosGrupo.size;
  $('#grupoTxt').textContent = `${n} selecionado(s)`;
  $('#btnConfirmaGrupo').disabled = n < 2;
}
async function agruparSelecionados() {
  const lista = pontos.filter(p => selecionadosGrupo.has(p.id)).sort((a, b) => (a.criadoEm || '').localeCompare(b.criadoEm || ''));
  if (lista.length < 2) return;
  if (!confirm(`Agrupar ${lista.length} pontos em um único apontamento? As fotos e as coordenadas de cada foto serão mantidas.`)) return;
  const stamp = agora();
  const alvo = { ...lista[0] };
  const juntar = campo => [...new Set(lista.map(p => (p[campo] || '').trim()).filter(Boolean))].join('\n');
  alvo.descricao = juntar('descricao');
  alvo.obsCampo = juntar('obsCampo');
  for (const c of ['pacote', 'segmento']) alvo[c] = alvo[c] || (lista.find(p => p[c]) || {})[c] || '';
  let fotos = [];
  for (const p of lista) fotos = fotos.concat((await fotosDoPonto(p.id)).filter(f => !f.excluido));
  for (const f of fotos) {
    if (f.pontoId !== alvo.id) await dbPut('fotos', { ...f, pontoId: alvo.id, atualizadoEm: stamp, dirty: 1 });
  }
  const comGps = fotos.filter(f => f.lat !== '' && f.lon !== '' && Number.isFinite(Number(f.lat)));
  const c = centroide(comGps.length ? comGps : lista.filter(temLoc));
  alvo.km = lista.every(p => !p.km) ? '' : alvo.km;
  aplicarLocal(alvo, c.lat, c.lon);
  if (nomePadrao(alvo.resumo)) {
    const data = fotos.map(f => f.tiradaEm).filter(Boolean).sort()[0];
    alvo.resumo = nomeInspecao(data, `${fotos.length} foto(s)`);
  }
  Object.assign(alvo, { atualizadoPor: S.nome, atualizadoEm: stamp, dirty: 1 });
  await dbPut('pontos', alvo);
  for (const p of lista.slice(1)) {
    await dbPut('pontos', { ...p, excluido: '1', atualizadoPor: S.nome, atualizadoEm: stamp, dirty: 1 });
  }
  pontos = (await dbAll('pontos')).filter(p => !p.excluido);
  alternarAgrupar(false);
  desenharPontos(); atualizarPendentes();
  abrirPonto(alvo.id);
  toast('Pontos agrupados. Revise o resumo e a descrição.', 6000);
}

/* ---------- Sincronização ---------- */
async function api(action, dados = {}) {
  if (!S.url || !S.chave) throw new Error('Configure o backend em Ajustes.');
  const r = await fetch(S.url, {
    method: 'POST', redirect: 'follow', credentials: 'omit',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify({ action, key: S.chave, ...dados })
  });
  let j;
  try { j = await r.json(); } catch (_) { throw new Error('Resposta inválida do backend. Confira o endereço e a implantação.'); }
  if (!j.ok) throw new Error(j.error || 'Erro no backend.');
  return j;
}
function blobParaBase64(blob) {
  return new Promise((res, rej) => {
    const fr = new FileReader();
    fr.onload = () => res(String(fr.result).split(',')[1]);
    fr.onerror = () => rej(fr.error);
    fr.readAsDataURL(blob);
  });
}
function base64ParaBlob(b64) {
  const bin = atob(b64);
  const u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  return new Blob([u8], { type: 'image/jpeg' });
}
const semInternos = o => { const c = { ...o }; delete c.dirty; delete c.blob; return c; };
function normalizar(p) {
  return { ...p, lat: p.lat === '' ? '' : Number(p.lat), lon: p.lon === '' ? '' : Number(p.lon) };
}
async function atualizarPendentes() {
  const nP = (await dbAll('pontos')).filter(p => p.dirty).length;
  const nF = (await dbAll('fotos')).filter(f => f.dirty).length;
  const n = nP + nF;
  const b = $('#pendentes');
  b.hidden = !n;
  b.textContent = n;
  return n;
}
async function sincronizar(manual = true) {
  if (sincronizando) return;
  if (!S.url || !S.chave) { if (manual) { toast('Configure o backend em Ajustes.'); abrirAba('tabAjustes'); } return; }
  if (!navigator.onLine) { if (manual) toast('Sem internet. Os dados continuam salvos neste aparelho.'); return; }
  sincronizando = true;
  const txt = $('#syncTxt');
  let falhas = 0;
  try {
    // 1) Envia o que foi feito neste aparelho
    const locais = (await dbAll('pontos')).filter(p => p.dirty);
    for (let i = 0; i < locais.length; i++) {
      txt.textContent = `Pontos ${i + 1}/${locais.length}`;
      const p = locais[i];
      const r = await api('pushPoint', { point: semInternos(p) });
      if (r.conflict) await dbPut('pontos', { ...normalizar(r.point), dirty: 0 });
      else if (p.excluido) await dbDel('pontos', p.id);
      else await dbPut('pontos', { ...p, dirty: 0 });
    }
    // Fotos de um ponto novo ainda aberto só seguem depois que ele for salvo.
    const fotos = (await dbAll('fotos')).filter(f => f.dirty && !(novoAtual && atual && f.pontoId === atual.id));
    for (let i = 0; i < fotos.length; i++) {
      txt.textContent = `Fotos ${i + 1}/${fotos.length}`;
      const f = fotos[i];
      try {
        const base64 = !f.driveId && f.blob ? await blobParaBase64(f.blob) : undefined;
        const r = await api('pushPhoto', { photo: semInternos(f), base64 });
        // Reler evita sobrescrever uma legenda alterada durante o envio.
        const agoraF = await dbGet('fotos', f.id);
        if (f.excluido) await dbDel('fotos', f.id);
        else if (agoraF) await dbPut('fotos', { ...agoraF, driveId: r.driveId, url: r.url, dirty: agoraF.atualizadoEm === f.atualizadoEm ? 0 : 1 });
      } catch (e) { falhas++; console.warn(e); }
    }

    // 2) Recebe o que a equipe enviou
    txt.textContent = 'Recebendo…';
    const d = await api('pull', { since: S.cursor });
    for (const p of d.points) {
      const local = await dbGet('pontos', p.id);
      if (local && local.dirty) continue;
      if (p.excluido) {
        await dbDel('pontos', p.id);
      } else {
        await dbPut('pontos', { ...normalizar(p), dirty: 0 });
      }
    }
    for (const f of d.photos) {
      const local = await dbGet('fotos', f.id);
      if (local && local.dirty) continue;
      if (f.excluido) await dbDel('fotos', f.id);
      else await dbPut('fotos', { ...f, blob: local ? local.blob : null, dirty: 0 });
    }
    S.cursor = d.serverTime; await salvarS('cursor');
    txt.textContent = 'Mapas…';
    await atualizarCatalogo();

    // 3) Baixa as fotos que faltam para consulta em campo
    const faltam = (await dbAll('fotos')).filter(f => !f.blob && f.driveId && !f.excluido);
    for (let i = 0; i < faltam.length; i++) {
      txt.textContent = `Baixando ${i + 1}/${faltam.length}`;
      try {
        const r = await api('getPhoto', { driveId: faltam[i].driveId });
        const f = await dbGet('fotos', faltam[i].id);
        if (f) await dbPut('fotos', { ...f, blob: base64ParaBlob(r.base64) });
      } catch (e) { falhas++; console.warn(e); }
    }

    pontos = (await dbAll('pontos')).filter(p => !p.excluido);
    desenharPontos(); desenharLista();
    await dbPut('kv', agora(), 'ultimaSync');
    if (falhas) toast(`Sincronização parcial: ${falhas} foto(s) com falha. Tente de novo.`, 6000);
    else if (manual) toast('Sincronização concluída.');
  } catch (e) {
    console.warn(e);
    if (manual) toast('Não foi possível sincronizar: ' + e.message, 6000);
  } finally {
    sincronizando = false;
    txt.textContent = 'Sincronizar';
    atualizarPendentes();
    atualizarAviso();
    if (!$('#tabAjustes').hidden) mostrarAjustes();
  }
}
async function atualizarAviso() {
  const a = $('#aviso');
  const falta = [];
  if (!S.nome) falta.push('informe seu nome');
  if (!S.url || !S.chave) falta.push('configure o backend');
  if (falta.length) { a.textContent = `Em Ajustes: ${falta.join(' e ')}.`; a.hidden = false; return; }
  if (!navigator.onLine) { a.textContent = 'Sem internet: os registros ficam salvos neste aparelho.'; a.hidden = false; return; }
  a.hidden = true;
}

/* ---------- Relatório ---------- */
function opcoes(sel, vals, todos) {
  const atualV = sel.value;
  sel.innerHTML = `<option value="">${todos}</option>` + [...new Set(vals.filter(Boolean))].sort().map(v => `<option>${esc(v)}</option>`).join('');
  sel.value = atualV;
}
function selecionados() {
  const pc = $('#repPacote').value, sg = $('#repSegmento').value, st = $('#repStatus').value, or = $('#repOrigem').value;
  const de = $('#repDe').value, ate = $('#repAte').value;
  return pontos.filter(p => {
    const dia = (p.atualizadoEm || '').slice(0, 10);
    return (!pc || p.pacote === pc) && (!sg || p.segmento === sg) && (!st || p.status === st) && (!or || p.origem === or) && (!de || dia >= de) && (!ate || dia <= ate);
  }).sort(ordemPontos);
}
function prepararRelatorio() {
  opcoes($('#repPacote'), pontos.map(p => p.pacote), 'Todos');
  opcoes($('#repSegmento'), pontos.map(p => p.segmento), 'Todos');
  resumoRelatorio();
}
function resumoRelatorio() {
  const s = selecionados();
  const cont = st => s.filter(p => p.status === st).length;
  $('#repResumo').textContent = `${s.length} ponto(s): ${cont('A verificar')} a verificar, ${cont('Verificado')} verificado(s), ${cont('Requer ação')} requer(em) ação.`;
}
let urlsRelatorio = [];
async function gerarPdf() {
  urlsRelatorio.forEach(URL.revokeObjectURL);
  const s = selecionados();
  if (!s.length) { toast('Nenhum ponto nos filtros escolhidos.'); return; }
  const area = $('#impressao');
  const urls = [];
  let html = `<h1>${esc($('#repTitulo').value)}</h1><p>Emitido em ${esc(dataBR(agora()))}${S.nome ? ' por ' + esc(S.nome) : ''} · ${s.length} ponto(s)</p>
  <table><thead><tr><th>Código</th><th>Pacote</th><th>Segmento</th><th>KM</th><th>Resumo</th><th>Status</th></tr></thead><tbody>
  ${s.map(p => `<tr><td>${esc(p.codigo)}</td><td>${esc(p.pacote)}</td><td>${esc(p.segmento)}</td><td>${esc(p.km)}</td><td>${esc(p.resumo)}</td><td>${esc(p.status)}</td></tr>`).join('')}
  </tbody></table>`;
  for (const p of s) {
    const fotos = (await fotosDoPonto(p.id)).filter(f => !f.excluido);
    const figs = fotos.map(f => {
      if (!f.blob) return `<figure><figcaption>Foto não disponível neste aparelho. ${esc(f.legenda)}</figcaption></figure>`;
      const u = URL.createObjectURL(f.blob); urls.push(u);
      return `<figure><img src="${u}" alt=""><figcaption>${esc(f.legenda)}${f.legenda ? ' · ' : ''}${esc(f.fase)} · ${esc(dataBR(f.tiradaEm))}${f.lat !== '' ? ` · ${esc(utmTxt(f.lat, f.lon))}` : ''}</figcaption></figure>`;
    }).join('');
    html += `<section class="ponto"><h2>${esc(p.codigo)} — ${esc(p.resumo)}</h2>
      <p><b>Pacote:</b> ${esc(p.pacote) || '—'} · <b>Segmento:</b> ${esc(p.segmento) || '—'} · <b>KM:</b> ${esc(p.km) || '—'}</p>
      <p><b>Status:</b> ${esc(p.status)} · <b>Origem:</b> ${esc(p.origem)} · <b>Coordenadas:</b> ${esc(utmTxt(p.lat, p.lon))} (SIRGAS 2000)</p>
      ${p.descricao ? `<p><b>Descrição:</b> ${esc(p.descricao)}</p>` : ''}
      ${p.obsCampo ? `<p><b>Observação de campo:</b> ${esc(p.obsCampo)}</p>` : ''}
      <p><b>Responsável:</b> ${esc(p.atualizadoPor)} · ${esc(dataBR(p.atualizadoEm))}</p>
      <div class="imgs">${figs}</div></section>`;
  }
  area.innerHTML = html;
  await Promise.all([...area.querySelectorAll('img')].map(i => i.decode().catch(() => {})));
  // O conteúdo só é limpo no próximo relatório: alguns celulares avisam o fim da impressão antes da hora.
  urlsRelatorio = urls;
  window.print();
}
function baixar(blob, nome) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = nome;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 30000);
}
function csvDe(lista) {
  const cols = ['codigo', 'pacote', 'segmento', 'km', 'resumo', 'descricao', 'obsCampo', 'status', 'origem', 'utmZona', 'utmE', 'utmN', 'lat', 'lon', 'criadoPor', 'criadoEm', 'atualizadoPor', 'atualizadoEm'];
  const cel = v => {
    let t = String(v ?? '');
    if (/^[=+\-@]/.test(t) && !/^-?\d/.test(t)) t = "'" + t; // evita execução de fórmula no Excel
    return `"${t.replace(/"/g, '""')}"`;
  };
  return '﻿' + [cols.join(';'), ...lista.map(p => {
    const u = temLoc(p) ? Geo.toUtm(Number(p.lat), Number(p.lon)) : null;
    const extra = u ? { utmZona: u.zonaTexto, utmE: num2(u.e), utmN: num2(u.n) } : {};
    return cols.map(c => cel(c in extra ? extra[c] : p[c])).join(';');
  })].join('\r\n');
}
function gerarCsv() {
  baixar(new Blob([csvDe(selecionados())], { type: 'text/csv;charset=utf-8' }), `inspecao-fico-${agora().slice(0, 10)}.csv`);
}
async function gerarBackup() {
  toast('Preparando backup…', 60000);
  const zip = new JSZip();
  const ps = await dbAll('pontos');
  const fs = await dbAll('fotos');
  zip.file('pontos.json', JSON.stringify(ps.map(semInternos), null, 2));
  zip.file('fotos.json', JSON.stringify(fs.map(semInternos), null, 2));
  zip.file('pontos.csv', csvDe(ps));
  for (const f of fs) if (f.blob) zip.file(`fotos/${f.pontoId}_${f.id}.jpg`, f.blob);
  baixar(await zip.generateAsync({ type: 'blob' }), `backup-inspecao-${agora().slice(0, 10)}.zip`);
  toast('Backup gerado.');
}

/* ---------- Ajustes ---------- */
function segChave(x) { return `${x.pacote}|${x.segmento}`; }
async function arquivoDoDrive(a) {
  const r = await api('getFile', { id: a.id });
  return new File([base64ParaBlob(r.base64)], a.nome);
}
// Lê a lista do Drive e atualiza os eixos novos ou alterados.
async function atualizarCatalogo() {
  const r = await api('listMaps');
  S.catalogo = r.segmentos;
  await salvarS('catalogo');
  let mudou = false;
  for (const seg of r.segmentos) {
    const k = seg.arquivos.find(a => /\.km[zl]$/i.test(a.nome));
    if (!k) continue;
    const atual = S.eixos.find(e => segChave(e) === segChave(seg));
    if (atual && atual.arquivoId === k.id && atual.alterado === k.alterado && await dbGet('kv', chaveDesenho(atual))) continue;
    try {
      const parsed = await Geo.parseKmz(await arquivoDoDrive(k));
      const eixo = Geo.buildAxis(parsed, { pacote: seg.pacote, segmento: seg.segmento, origem: k.nome });
      eixo.arquivoId = k.id; eixo.alterado = k.alterado;
      await salvarDesenho(eixo, parsed);
      S.eixos = S.eixos.filter(e => segChave(e) !== segChave(seg)).concat(eixo);
      mudou = true;
    } catch (e) { console.warn(e); toast(`Eixo de ${seg.segmento}: ${e.message}`, 6000); }
  }
  if (mudou) { await salvarS('eixos'); desenharEixo(); await desenharProjeto(); }
}
function arquivosMapa(seg) {
  const a = seg.arquivos;
  const zip = a.find(x => /\.zip$/i.test(x.nome));
  const tif = a.find(x => /\.tiff?$/i.test(x.nome));
  if (tif) return [tif, ...a.filter(x => /\.(tfw|tifw|wld|prj)$/i.test(x.nome))];
  return zip ? [zip] : [];
}
const versaoMapa = arqs => arqs.map(a => a.id + a.alterado).join('|');
async function baixarMapa(chave) {
  const seg = S.catalogo.find(x => segChave(x) === chave);
  const arqs = arquivosMapa(seg);
  const prog = $('#ortoProg');
  prog.hidden = false;
  prog.textContent = `Baixando o mapa de ${seg.segmento}…`;
  try {
    const files = [];
    for (const a of arqs) files.push(await arquivoDoDrive(a));
    const antigos = (await dbAll('ortos')).filter(o => o.chave === chave);
    // O mapa anterior só é removido depois que o novo estiver salvo.
    if (await importarOrto(files, { chave, versao: versaoMapa(arqs), nome: `${seg.pacote} · ${seg.segmento}` })) {
      for (const o of antigos) await removerOrto(o.id);
    }
  } catch (e) {
    console.warn(e);
    prog.textContent = 'Não foi possível baixar o mapa: ' + e.message;
  }
}
async function mostrarAjustes() {
  $('#cfgNome').value = S.nome; $('#cfgUrl').value = S.url; $('#cfgChave').value = S.chave;
  const ortos = await dbAll('ortos');
  $('#segmentos').innerHTML = S.catalogo.length ? S.catalogo.map(seg => {
    const chave = segChave(seg);
    const e = S.eixos.find(x => segChave(x) === chave);
    const arqs = arquivosMapa(seg);
    const o = ortos.find(x => x.chave === chave);
    let estado = 'Sem mapa no Drive', botao = '';
    if (arqs.length) {
      if (!o) { estado = 'Mapa não baixado'; botao = 'Baixar'; }
      else if (o.versao !== versaoMapa(arqs)) { estado = 'Há mapa mais novo no Drive'; botao = 'Atualizar'; }
      else estado = `Mapa neste aparelho (~${o.resolucao.toFixed(2).replace('.', ',')} m/pixel)`;
    }
    const eixoTxt = !e ? 'Eixo não encontrado'
      : e.marcos ? `Eixo com km por ${e.marcos} rótulos` : e.semMarcos ? 'Eixo sem km: informe km no nome do arquivo' : 'Eixo com km pelo nome do arquivo';
    return `<li><span><b>${esc(seg.pacote)} · ${esc(seg.segmento)}</b><br><small>${esc(eixoTxt)}. ${esc(estado)}.</small></span>${botao ? `<button type="button" class="btn" data-mapa="${esc(chave)}">${botao}</button>` : ''}</li>`;
  }).join('') : '<li>Nenhum segmento encontrado. Sincronize com internet.</li>';
  const locais = S.eixos.filter(e => !e.arquivoId);
  $('#eixoInfo').textContent = locais.length ? `Eixos importados no aparelho: ${locais.map(e => [e.pacote, e.segmento].filter(Boolean).join(' · ') || e.origem).join('; ')}.` : '';
  $('#ortos').innerHTML = ortos.filter(o => !o.chave).concat(ortos.filter(o => o.chave)).map(o => `<li><span>${esc(o.nome)}<br><small>${o.blocos.length} bloco(s), ${(o.bytes / 1048576).toFixed(1).replace('.', ',')} MB, ~${o.resolucao.toFixed(2).replace('.', ',')} m/pixel</small></span><button type="button" class="btn" data-del="${esc(o.id)}">Remover</button></li>`).join('');
  let txt = '';
  if (navigator.storage && navigator.storage.estimate) {
    const u = await navigator.storage.estimate();
    txt = `Espaço usado: ${(u.usage / 1048576).toFixed(0)} MB. `;
  }
  const ult = await dbGet('kv', 'ultimaSync');
  $('#espaco').textContent = txt + (ult ? `Última sincronização: ${dataBR(ult)}.` : 'Ainda não sincronizado.');
}
async function salvarConfig() {
  S.nome = $('#cfgNome').value.trim(); S.url = $('#cfgUrl').value.trim(); S.chave = $('#cfgChave').value.trim();
  await Promise.all(['nome', 'url', 'chave'].map(salvarS));
  atualizarAviso();
  if (!S.url) { toast('Configuração salva.'); return; }
  try { await api('ping'); toast('Conexão confirmada.'); sincronizar(false); }
  catch (e) { toast('Falha na conexão: ' + e.message, 6000); }
}
async function importarEixoLocal(file) {
  const parsed = await Geo.parseKmz(file);
  const m = /(Pacote\s*[\w.]+)\s*[-–]\s*(Segmento\s*[\w.]+)/i.exec(parsed.nome || file.name);
  const eixo = Geo.buildAxis(parsed, { pacote: m ? m[1] : '', segmento: m ? m[2] : '', origem: file.name });
  S.eixos = S.eixos.filter(e => segChave(e) !== segChave(eixo) || !eixo.pacote).concat(eixo);
  await salvarS('eixos');
  await salvarDesenho(eixo, parsed);
  desenharEixo(); await desenharProjeto(); mostrarAjustes(); enquadrar();
  toast(eixo.marcos ? `Eixo reconhecido com ${eixo.marcos} rótulos de km.` : 'Eixo sem rótulos de km: confira o km calculado.', 6000);
}
async function importarOrto(arquivos, meta = {}) {
  const prog = $('#ortoProg');
  prog.hidden = false;
  try {
    const partes = await Geo.separarOrto(arquivos);
    const file = partes.tif;
    const r = await Geo.importOrtho(file, Number($('#ortoQualidade').value), f => { prog.textContent = `Processando ${file.name}: ${Math.round(f * 100)}%`; }, partes);
    const id = uuid();
    const blocos = [];
    let bytes = 0;
    for (let i = 0; i < r.pieces.length; i++) {
      const bid = `${id}-${i}`;
      await dbPut('ortoBlocos', r.pieces[i].blob, bid);
      bytes += r.pieces[i].blob.size;
      blocos.push({ id: bid, bounds: r.pieces[i].bounds });
    }
    await dbPut('ortos', { id, nome: meta.nome || file.name, chave: meta.chave || '', versao: meta.versao || '', bounds: r.bounds, resolucao: r.resolucao, bytes, blocos });
    await carregarOrtos();
    map.fitBounds(r.bounds);
    mostrarAjustes();
    toast('Ortomosaico disponível offline neste aparelho.');
    prog.hidden = true;
    return true;
  } catch (e) {
    console.warn(e);
    prog.textContent = 'Não foi possível importar: ' + e.message;
    return false;
  }
}
async function removerOrto(id) {
  const o = await dbGet('ortos', id);
  if (!o) return;
  for (const b of o.blocos) await dbDel('ortoBlocos', b.id);
  await dbDel('ortos', id);
  await carregarOrtos();
  mostrarAjustes();
}

/* ---------- Escolher local no mapa ---------- */
let escolhendo = false;
function iniciarEscolha() {
  escolhendo = true;
  $('#ficha').hidden = true;
  abrirAba('tabMapa');
  $('#escolhaBanner').hidden = false;
}
function concluirEscolha(ll) {
  escolhendo = false;
  $('#escolhaBanner').hidden = true;
  $('#ficha').hidden = false;
  if (ll) definirLocal(ll.lat, ll.lng);
}

/* ---------- Eventos ---------- */
function ligar() {
  document.querySelectorAll('nav button').forEach(b => b.addEventListener('click', () => abrirAba(b.dataset.tab)));
  $('#etapaPre').onclick = () => { S.etapa = 'Pré-inspeção'; salvarS('etapa'); mostrarEtapa(); };
  $('#etapaCampo').onclick = () => { S.etapa = 'Campo'; salvarS('etapa'); mostrarEtapa(); };
  $('#btnSync').onclick = () => sincronizar(true);
  $('#btnNovoMapa').onclick = abrirNovo;
  $('#btnNovoLista').onclick = abrirNovo;
  $('#btnGps').onclick = async () => { const p = await posicaoAtual(); if (p) map.setView([p.lat, p.lon], Math.max(map.getZoom(), 16)); else toast('GPS indisponível.'); };
  $('#busca').oninput = desenharLista;
  $('#filtroStatus').onchange = desenharLista;
  $('#lista').onclick = e => {
    const li = e.target.closest('li[data-id]');
    if (!li) return;
    if (!modoAgrupar) { abrirPonto(li.dataset.id); return; }
    const id = li.dataset.id;
    if (selecionadosGrupo.has(id)) selecionadosGrupo.delete(id); else selecionadosGrupo.add(id);
    atualizarBarraGrupo();
    desenharLista();
  };
  $('#btnAgrupar').onclick = () => alternarAgrupar(true);
  $('#btnCancelaGrupo').onclick = () => alternarAgrupar(false);
  $('#btnConfirmaGrupo').onclick = agruparSelecionados;
  const fecharDlg = () => { $('#dlgImport').hidden = true; const l = arquivosImportar; arquivosImportar = []; return l; };
  $('#dlgAgrupar').onclick = () => importarAgrupado(fecharDlg());
  $('#dlgSeparar').onclick = () => importarUmPorFoto(fecharDlg());
  $('#dlgCancelar').onclick = () => { fecharDlg(); };
  $('#fotosDrone').onchange = e => { const f = [...e.target.files]; e.target.value = ''; if (f.length === 1) importarUmPorFoto(f); else if (f.length) pedirModoImportacao(f); };

  $('#form').onsubmit = salvarFicha;
  $('#btnFechar').onclick = fecharFicha;
  $('#btnExcluir').onclick = excluirPonto;
  $('#btnUsarGps').onclick = async () => { const p = await posicaoAtual(); if (p) { kmManual = false; localAuto = false; definirLocal(p.lat, p.lon); } else toast('GPS indisponível.'); };
  $('#btnEscolher').onclick = () => { kmManual = false; localAuto = false; iniciarEscolha(); };
  $('#btnCancelaEscolha').onclick = () => concluirEscolha(null);
  $('#fKm').oninput = () => { kmManual = true; };
  $('#fE').onchange = $('#fN').onchange = $('#fZona').onchange = lerUtmDigitado;
  for (const id of ['#fCamera', '#fGaleria']) $(id).onchange = e => { const f = [...e.target.files]; e.target.value = ''; if (f.length) adicionarFotos(f, id === '#fCamera'); };
  $('#fFotos').addEventListener('change', e => {
    if (e.target.classList.contains('legenda')) editarFoto(e.target.closest('.foto').dataset.id, { legenda: e.target.value });
  });
  $('#fFotos').addEventListener('click', async e => {
    if (!e.target.classList.contains('tirar')) return;
    const id = e.target.closest('.foto').dataset.id;
    const f = await dbGet('fotos', id);
    if (f && !f.driveId) await dbDel('fotos', id); else await editarFoto(id, { excluido: '1' });
    desenharFotos(); atualizarPendentes();
  });

  ['#repPacote', '#repSegmento', '#repStatus', '#repOrigem', '#repDe', '#repAte'].forEach(s => { $(s).onchange = resumoRelatorio; });
  $('#btnPdf').onclick = gerarPdf;
  $('#btnCsv').onclick = gerarCsv;
  $('#btnBackup').onclick = gerarBackup;
  $('#btnSalvarCfg').onclick = salvarConfig;
  $('#btnAtualizarMapas').onclick = async () => {
    try { await atualizarCatalogo(); await mostrarAjustes(); toast('Lista de mapas atualizada.'); }
    catch (e) { toast('Não foi possível atualizar: ' + e.message, 6000); }
  };
  $('#segmentos').onclick = e => { if (e.target.dataset.mapa) baixarMapa(e.target.dataset.mapa); };
  $('#arqEixo').onchange = async e => {
    const f = e.target.files[0]; e.target.value = '';
    if (!f) return;
    try { await importarEixoLocal(f); } catch (err) { toast(err.message, 6000); }
  };
  $('#arqOrto').onchange = e => { const f = [...e.target.files]; e.target.value = ''; if (f.length) importarOrto(f); };
  $('#ortos').onclick = e => { if (e.target.dataset.del) removerOrto(e.target.dataset.del); };
  window.addEventListener('online', () => { atualizarAviso(); sincronizar(false); });
  window.addEventListener('offline', atualizarAviso);
}

(async function iniciar() {
  await abrirDB();
  await carregar();
  ligar();
  mostrarEtapa();
  iniciarMapa();
  abrirAba('tabMapa');
  iniciarGps();
  atualizarPendentes();
  atualizarAviso();
  // Pede ao sistema para não apagar os dados locais. No iPhone, reforçado a cada abertura.
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(e => console.warn(e));
  sincronizar(false);
})();
