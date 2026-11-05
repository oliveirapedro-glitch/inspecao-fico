# App de Inspeção de Campo – FICO

O app funciona no navegador e pode ser instalado no celular. Ele guarda os registros no aparelho e os envia ao Google Drive do ATO ao sincronizar.

- **Telas e código:** GitHub Pages
- **Pontos:** Planilha Google
- **Fotos e eixo:** pasta no Google Drive
- **Ortomosaicos:** apenas no aparelho que os importou

## Etapa 1: criar o backend no Google

Use a conta Google do ATO, pois os dados ficarão nela.

1. Acesse [script.google.com](https://script.google.com) e clique em **Novo projeto**.
2. Apague o conteúdo do editor e cole todo o arquivo `backend/Code.gs`.
3. Salve e dê o nome **Inspeção FICO**.
4. Selecione a função `configurar` na barra superior e clique em **Executar**.
5. Autorize o acesso quando o Google solicitar.
6. Copie a **chave de acesso** exibida no registro de execução. Se ela não aparecer, execute `configurar` de novo.
7. Clique em **Implantar > Nova implantação > Aplicativo da Web**.
8. Em **Executar como**, escolha **Eu**.
9. Em **Quem pode acessar**, escolha **Qualquer pessoa**. O app ainda exigirá a chave de acesso.
10. Clique em **Implantar** e copie o endereço terminado em `/exec`.

Trate a chave como uma senha e não a publique no GitHub. Se ela vazar, altere o valor da propriedade `CHAVE` em **Configurações do projeto** e informe o novo valor à equipe. Não apague a propriedade para executar `configurar` de novo, pois isso criaria outra base.

## Etapa 2: publicar no GitHub Pages

1. Crie um repositório no GitHub, por exemplo `inspecao-fico`.
2. Clique em **Add file > Upload files**.
3. Envie o conteúdo desta pasta, mantendo as subpastas. O `index.html` precisa ficar na raiz.
4. Clique em **Commit changes**.
5. Vá em **Settings > Pages**.
6. Em **Source**, selecione **Deploy from a branch**, depois `main` e `/ (root)`, e salve.
7. Aguarde alguns minutos e abra `https://SEU-USUARIO.github.io/inspecao-fico/`.

No plano gratuito do GitHub, o repositório precisa ser público para usar o Pages. O código fica visível, mas os dados da obra e a chave não ficam no repositório.

## Etapa 3: instalar nos aparelhos

Abra o endereço com internet e instale:

- **Android (Chrome):** menu **⋮ > Instalar app** ou **Adicionar à tela inicial**.
- **iPhone (Safari):** botão **Compartilhar > Adicionar à Tela de Início**.

No iPhone, use sempre o ícone instalado, e não a aba do Safari.

Depois, em **Ajustes**, informe seu nome, o endereço `/exec` e a chave. Clique em **Salvar e testar** e permita o uso da localização e da câmera.

## Etapa 4: organizar os mapas no Drive

Dentro da pasta `App Inspeção FICO`, use esta estrutura:

```text
Mapas/
└── Pacote 05/
    └── Segmento 2.4/
        ├── eixo do segmento (.kmz)
        └── mapa exportado da Maply (.zip)
```

- Crie a pasta do pacote e, dentro dela, uma pasta por segmento. O app usa esses nomes nos campos Pacote e Segmento.
- Mantenha apenas um KMZ e um mapa em cada segmento.
- O mapa pode ser o `.zip` da Maply ou os arquivos `.tif`, `.tfw` e `.prj` soltos.
- Cada arquivo baixado pelo app deve ter até 35 MB.
- Para atualizar um arquivo, use **Gerenciar versões** no Drive.

## Etapa 5: preparar uma inspeção

### Pré-inspeção (com internet)

1. Selecione **Pré-inspeção** no topo e clique em **Sincronizar**. O app carrega os eixos do Drive.
2. Em **Pontos**, importe fotos com GPS, escolhendo um apontamento com todas as fotos ou um ponto por foto, ou crie pontos manualmente. Fotos com coordenadas geram um ponto cada.
3. Confira Pacote, Segmento e KM, preenchidos pelo eixo mais próximo.
4. Clique em **Sincronizar**.

### Antes de sair para campo

Em cada aparelho, com internet:

1. Clique em **Sincronizar** para baixar pontos e fotos.
2. Em **Ajustes > Mapas por segmento**, clique em **Baixar** nos segmentos que vai percorrer.
3. Ative o modo avião e abra o app para confirmar que os dados e o mapa aparecem.

### Campo (sem internet)

1. Selecione **Campo** no topo.
2. Abra os pontos, registre as observações, atualize o status e tire fotos.
3. Crie novos pontos quando necessário.

Clique em **Salvar** antes de sair da ficha ou trocar de aplicativo. Ao voltar a ter internet, abra o app e confira se o contador de pendências em **Sincronizar** zerou.

### Pós-inspeção

Em **Relatório**, aplique os filtros e gere o PDF ou o CSV. A base completa também fica na Planilha Google.

## Revisão por IA (opcional)

1. Crie uma chave de API em [platform.claude.com](https://platform.claude.com).
2. No Apps Script, abra **Configurações do projeto > Propriedades do script**.
3. Adicione a propriedade `IA_CHAVE` com o valor da chave. Nunca coloque essa chave no GitHub.
4. Na Planilha, a aba `Glossário` é criada na primeira revisão. Preencha `Termo encontrado` e `Usar assim` quando a equipe definir um padrão.

Ao sincronizar, cada ponto salvo é revisado. O texto original fica na ficha, em **Ver texto original**, e pode ser restaurado. Pontos marcados com **Não revisar este ponto com IA** não são enviados.

## Publicar alterações

Depois de alterar qualquer arquivo, aumente a versão na linha `const VERSAO` do `sw.js` (por exemplo, de `inspecao-v1` para `inspecao-v2`). Sem isso, os aparelhos podem continuar com a versão antiga.

Se alterar o `Code.gs`, use **Implantar > Gerenciar implantações > Editar > Nova versão** para manter o mesmo endereço.

## Limites desta versão

- **Edição simultânea:** se duas pessoas alterarem o mesmo ponto, prevalece a alteração com data e hora mais recentes.
- **Backup:** antes de limpar dados do navegador ou trocar de aparelho, sincronize ou use **Ajustes > Baixar backup**.
- **GPS:** a localização do celular serve para encontrar o ponto, não para medição topográfica.
- **Fotos:** são reduzidas para até 2.048 px antes do envio. Os originais do drone continuam na Maply.
- **MDT e outras camadas:** não são exibidos nesta versão.
- **Km:** é calculado somente no eixo principal, pelos rótulos do KMZ. Ramais e pátios com numeração própria devem ser conferidos e corrigidos manualmente.
- **KMZ sem rótulos de km:** informe o km inicial no nome do arquivo, como `eixo_km-0012+500.kmz`, com a linha desenhada no sentido crescente.
