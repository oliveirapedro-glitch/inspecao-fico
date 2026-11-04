/**
 * Backend do app de inspeção (Google Apps Script).
 * Guarda os pontos em uma Planilha Google e as fotos em uma pasta do Drive.
 *
 * Instalação: veja o LEIAME.md, etapa 1. Execute a função configurar() uma vez.
 */
var CAMPOS_PONTO = ['id', 'codigo', 'pacote', 'segmento', 'km', 'resumo', 'descricao', 'obsCampo', 'status', 'origem',
  'lat', 'lon', 'criadoPor', 'criadoEm', 'atualizadoPor', 'atualizadoEm', 'excluido', 'syncedAt'];
var CAMPOS_FOTO = ['id', 'pontoId', 'fase', 'legenda', 'lat', 'lon', 'tiradaEm', 'criadoPor', 'atualizadoEm',
  'driveId', 'url', 'excluido', 'syncedAt'];

function configurar() {
  var props = PropertiesService.getScriptProperties();
  if (props.getProperty('CHAVE')) {
    Logger.log('Já configurado. Chave de acesso: ' + props.getProperty('CHAVE'));
    return;
  }
  // Usa a pasta já criada no Drive, se existir.
  var existentes = DriveApp.getFoldersByName('App Inspeção FICO');
  var pasta = existentes.hasNext() ? existentes.next() : DriveApp.createFolder('App Inspeção FICO');
  var fotos = pastaFilha_(pasta, 'Fotos');
  pastaFilha_(pasta, 'Mapas');
  var planilha = SpreadsheetApp.create('Inspeção FICO - Base de dados');
  DriveApp.getFileById(planilha.getId()).moveTo(pasta);

  var abaPontos = planilha.getSheets()[0];
  abaPontos.setName('Pontos');
  abaPontos.getRange(1, 1, 1, CAMPOS_PONTO.length).setValues([CAMPOS_PONTO]);
  abaPontos.setFrozenRows(1);
  var abaFotos = planilha.insertSheet('Fotos');
  abaFotos.getRange(1, 1, 1, CAMPOS_FOTO.length).setValues([CAMPOS_FOTO]);
  abaFotos.setFrozenRows(1);

  var chave = Utilities.getUuid();
  props.setProperties({ CHAVE: chave, PLANILHA: planilha.getId(), PASTA: pasta.getId(), FOTOS: fotos.getId() });
  Logger.log('Configuração concluída. Chave de acesso: ' + chave);
}

function pastaFilha_(pai, nome) {
  var it = pai.getFoldersByName(nome);
  return it.hasNext() ? it.next() : pai.createFolder(nome);
}

function doGet() {
  return resposta_({ ok: true, servico: 'inspecao-fico' });
}

function doPost(e) {
  try {
    var req = JSON.parse(e.postData.contents);
    var props = PropertiesService.getScriptProperties();
    if (!props.getProperty('CHAVE')) throw new Error('Backend não configurado: execute configurar().');
    if (req.key !== props.getProperty('CHAVE')) throw new Error('Chave de acesso inválida.');
    switch (req.action) {
      case 'ping': return resposta_({ ok: true });
      case 'pull': return resposta_(pull_(req));
      case 'pushPoint': return resposta_(pushPoint_(req.point));
      case 'pushPhoto': return resposta_(pushPhoto_(req.photo, req.base64));
      case 'getPhoto': return resposta_(getPhoto_(req.driveId));
      case 'listMaps': return resposta_(listMaps_());
      case 'getFile': return resposta_(getFile_(req.id));
      default: throw new Error('Ação desconhecida.');
    }
  } catch (err) {
    return resposta_({ ok: false, error: String(err.message || err) });
  }
}

function resposta_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function aba_(nome) {
  return SpreadsheetApp.openById(PropertiesService.getScriptProperties().getProperty('PLANILHA')).getSheetByName(nome);
}

function linhas_(aba, campos) {
  var dados = aba.getDataRange().getValues();
  var saida = [];
  for (var i = 1; i < dados.length; i++) {
    var item = { _linha: i + 1 };
    for (var c = 0; c < campos.length; c++) item[campos[c]] = dados[i][c] === undefined ? '' : String(dados[i][c]);
    saida.push(item);
  }
  return saida;
}

function gravar_(aba, campos, item, linha) {
  var valores = campos.map(function (c) { return item[c] === undefined || item[c] === null ? '' : String(item[c]); });
  var destino = linha || aba.getLastRow() + 1;
  // Formato "texto": impede que um apontamento iniciado por "=" vire fórmula.
  aba.getRange(destino, 1, 1, campos.length).setNumberFormat('@').setValues([valores]);
}

function comTrava_(fn) {
  var trava = LockService.getScriptLock();
  trava.waitLock(30000);
  try { return fn(); } finally { trava.releaseLock(); }
}

function limpar_(item) { delete item._linha; return item; }

function pull_(req) {
  var desde = Number(req.since || 0);
  var filtro = function (x) { return Number(x.syncedAt || 0) >= desde; };
  var agora = Date.now();
  return {
    ok: true,
    serverTime: agora,
    points: linhas_(aba_('Pontos'), CAMPOS_PONTO).filter(filtro).map(limpar_),
    photos: linhas_(aba_('Fotos'), CAMPOS_FOTO).filter(filtro).map(limpar_)
  };
}

function pushPoint_(p) {
  if (!p || !p.id) throw new Error('Ponto sem identificador.');
  return comTrava_(function () {
    var aba = aba_('Pontos');
    var atual = linhas_(aba, CAMPOS_PONTO).filter(function (x) { return x.id === String(p.id); })[0];
    if (atual && String(atual.atualizadoEm) > String(p.atualizadoEm)) {
      var linhaIgnorada = limpar_(atual);
      return { ok: true, conflict: true, point: linhaIgnorada };
    }
    p.syncedAt = Date.now();
    gravar_(aba, CAMPOS_PONTO, p, atual ? atual._linha : null);
    return { ok: true, syncedAt: p.syncedAt };
  });
}

function pushPhoto_(f, base64) {
  if (!f || !f.id) throw new Error('Foto sem identificador.');
  var aba = aba_('Fotos');
  var atual = linhas_(aba, CAMPOS_FOTO).filter(function (x) { return x.id === String(f.id); })[0];
  var driveId = atual ? atual.driveId : '';
  var url = atual ? atual.url : '';
  if (!driveId) {
    if (!base64) throw new Error('Foto sem conteúdo.');
    var props = PropertiesService.getScriptProperties();
    var blob = Utilities.newBlob(Utilities.base64Decode(base64), 'image/jpeg', f.pontoId + '_' + f.id + '.jpg');
    var arquivo = DriveApp.getFolderById(props.getProperty('FOTOS')).createFile(blob);
    driveId = arquivo.getId();
    url = arquivo.getUrl();
  }
  return comTrava_(function () {
    // Nova leitura dentro da trava, para não duplicar em envios simultâneos.
    var existente = linhas_(aba, CAMPOS_FOTO).filter(function (x) { return x.id === String(f.id); })[0];
    f.driveId = existente && existente.driveId ? existente.driveId : driveId;
    f.url = existente && existente.url ? existente.url : url;
    f.syncedAt = Date.now();
    gravar_(aba, CAMPOS_FOTO, f, existente ? existente._linha : null);
    return { ok: true, driveId: f.driveId, url: f.url, syncedAt: f.syncedAt };
  });
}

function getPhoto_(driveId) {
  var bytes = DriveApp.getFileById(driveId).getBlob().getBytes();
  return { ok: true, base64: Utilities.base64Encode(bytes) };
}

// Percorre Mapas/<Pacote>/<Segmento> e lista os arquivos de cada segmento.
function listMaps_() {
  var raiz = DriveApp.getFolderById(PropertiesService.getScriptProperties().getProperty('PASTA'));
  var mapas = pastaFilha_(raiz, 'Mapas');
  var saida = [];
  var pacotes = mapas.getFolders();
  while (pacotes.hasNext()) {
    var pacote = pacotes.next();
    var segmentos = pacote.getFolders();
    while (segmentos.hasNext()) {
      var segmento = segmentos.next();
      var arquivos = [];
      var it = segmento.getFiles();
      while (it.hasNext()) {
        var f = it.next();
        arquivos.push({ id: f.getId(), nome: f.getName(), tamanho: f.getSize(), alterado: f.getLastUpdated().toISOString() });
      }
      saida.push({ pacote: pacote.getName(), segmento: segmento.getName(), arquivos: arquivos });
    }
  }
  return { ok: true, segmentos: saida };
}

function getFile_(id) {
  var arquivo = DriveApp.getFileById(id);
  // O arquivo precisa estar dentro de Mapas: a chave não dá acesso ao restante do Drive.
  var pai = arquivo.getParents();
  var dentro = false;
  var raiz = PropertiesService.getScriptProperties().getProperty('PASTA');
  while (pai.hasNext() && !dentro) {
    var seg = pai.next().getParents();
    while (seg.hasNext() && !dentro) {
      var pac = seg.next().getParents();
      while (pac.hasNext() && !dentro) {
        var map = pac.next();
        if (map.getName() === 'Mapas') {
          var r = map.getParents();
          while (r.hasNext()) if (r.next().getId() === raiz) dentro = true;
        }
      }
    }
  }
  if (!dentro) throw new Error('Arquivo fora da pasta Mapas.');
  if (arquivo.getSize() > 35 * 1024 * 1024) {
    throw new Error('Arquivo acima de 35 MB. Exporte o mapa em menor resolução ou divida o trecho.');
  }
  return { ok: true, nome: arquivo.getName(), base64: Utilities.base64Encode(arquivo.getBlob().getBytes()) };
}
