# BOOM Promo — bot e catálogo com acesso controlado

## Atualização da instalação existente

1. Na Vercel, projeto BOOM Promo → Settings → Environment Variables, copie o valor de `CATALOG_READ_KEY`. A chave é exclusiva para leitura; não use o token do Telegram nem o segredo do webhook.
2. No **mesmo projeto Apps Script**, Configurações do projeto → Propriedades do script, adicione `CATALOG_READ_KEY` com exatamente esse valor. Preserve `SPREADSHEET_ID`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET`, `WEB_APP_URL` e **`ALLOWED_CHAT_ID`**.
3. Substitua o código pelo arquivo `Code.gs`, salve e atualize a **mesma implantação**: Implantar → Gerenciar implantações → Editar → Nova versão → Implantar. Não crie outro projeto nem outra URL.
4. Execute `installWebhook` uma vez para atualizar os comandos. Não há descarte de mensagens pendentes. Execute `diagnosticarWebhook` se necessário; seu retorno não contém segredos.
5. No Telegram autorizado, envie `/produtos`. Após conferir um preço real, teste `/preco ID VALOR`. Recarregue o site após até 45 segundos e confira o produto. A data de verificação corresponde ao envio do comando, não à tentativa de entrega.

**A ordem importa:** configurar a chave antes de publicar o novo Apps Script evita interromper o catálogo. O site pode usar a nova chave com o script antigo durante a transição; o script antigo ainda permite leitura pública até ser substituído. Depois da atualização, abrir `/exec` sem chave retorna `Unauthorized`: esse resultado passa a ser esperado. O catálogo público continua disponível no site em `/api/products`, sem expor a chave.

Não envie segredos pelo chat. O valor da chave não está neste repositório. A Vercel deve ter `CATALOG_READ_KEY` configurada no servidor antes do deploy. Não use prefixos públicos, como `NEXT_PUBLIC_`.

## Autorização do bot

Não existe mais vinculação automática por `/start`. Somente o ID **já configurado** em `ALLOWED_CHAT_ID`, em conversa privada e com remetente correspondente, pode executar comandos. `SETUP_CODE` não é usado e pode ser removido. Se `ALLOWED_CHAT_ID` estiver ausente, o bot ignora mensagens; configure o ID da sua própria conta diretamente nas propriedades do editor. Nunca informe IDs de terceiros para habilitar o bot.

Uma instalação nova precisa das propriedades acima e dos cabeçalhos da aba `Produtos` na linha 4. A implantação é do tipo Aplicativo da Web, executada como o proprietário, com acesso para qualquer pessoa: os handlers fazem a autenticação antes de ler ou modificar dados.

## Comandos

- `/ajuda` — mini tutorial com exemplos; `/ajuda imagens` — como publicar e vincular fotos.
- `/produtos` ou `/produtos 2` — lista paginada de produtos ativos.
- `/conferir` (ou `/verificar` sem ID) — painel com cinco produtos por página, incluindo ativos e inativos, preço cadastrado, ID e botões **Abrir oferta**, **Preço continua igual**, **Mudar preço**, **Mudar link**, **Trocar foto**, **Ativar/Desativar**, **Adicionar produto**, **Anterior** e **Próxima**. Produtos confirmados hoje ficam marcados como **Verificado**. Use `/conferir 2` para abrir outra página diretamente.
- `/preco ID 51,00` — atualiza preço e a data da conferência.
- `/verificar ID` — após conferir manualmente que o preço continua igual, renova a data sem regravar o preço atual, link ou foto. Limpa o preço antigo e o selo, que não foram reconfirmados; registra a ação `verificar` no histórico. Exemplo: `/verificar frigideira-24cm-antiaderente`. Não existe confirmação em massa de todos os produtos.
- `/link ID https://meli.la/...` — troca o link e, se o destino mudou, invalida a conferência do preço e limpa preço antigo/selo. O preço cadastrado fica guardado no painel; confira a nova oferta e use Verificar ou Mudar preço para voltar a exibi-lo. Repetir o mesmo link preserva a conferência.
- `/atualizar ID 51,00 https://meli.la/...` — valida preço e link antes da gravação.
- `/imagem ID /assets/foto.png` — altera somente a foto de um produto existente, sem renovar a verificação do preço.
- `/adicionar ID | Nome | Descrição | 51,00 | https://meli.la/... | imagem opcional | alt opcional | característica 1; característica 2 | selo opcional`
- `/ativar ID` e `/desativar ID` — alteram somente a visibilidade.

Não escreva as palavras `ID` e `VALOR`: substitua pelos dados reais. Preços usam vírgula decimal (`51,00`). O cadastro aceita 5 a 9 campos, no máximo 1000 produtos. Características usam **ponto e vírgula** dentro do mesmo campo. Campos extras são rejeitados. Informe somente benefícios comprovados; deixe o selo vazio quando não houver um verificado.

Os comandos rejeitam palavras ou parâmetros extras para evitar alterações acidentais. O preço aceito vai de R$ 0,01 a R$ 1.000.000.000,00. Toda atualização que verifica um preço limpa os campos `preço antigo` e `selo`, pois o valor riscado não foi reconfirmado na mesma operação; imagem e visibilidade não renovam o TTL; trocar para outro link invalida a conferência.

Imagem opcional: arquivo já publicado em `/assets/` ou URL HTTPS direta e pública da imagem, sem credenciais. O bot ainda não envia fotos ao site; quando recebe uma foto pelo Telegram, responde com `/ajuda imagens`. Imagem vazia mostra “Foto em breve”. Links existentes não são alterados por esta atualização.

Para gerenciar fotos sem editar a planilha: no GitHub do site, abra `assets` → **Add file** → **Upload files**, envie um PNG/JPG/WebP com nome simples (sem espaços) e confirme o commit. Espere o deploy de produção ficar pronto na Vercel. Para um card existente, envie `/imagem ID /assets/nome-do-arquivo.png` ao bot; para um novo, inclua o mesmo caminho no campo opcional de `/adicionar`. Evite links de compartilhamento do Drive, que não são URLs diretas de imagem. O bot muda o caminho no catálogo, mas não faz upload nem recorta a foto.

## Proteções e recuperação

- Texto é gravado como literal; entradas que poderiam virar fórmulas são neutralizadas.
- `BotRecebimentos` é criada automaticamente e mantém recibos por 48 horas. O bot só aceita comandos enviados há até 24 horas. Não apague ou edite essa aba durante a operação.
- O recibo `processing` é persistido antes de gravar. Se houver interrupção nesse intervalo, uma reentrega **não executa novamente**. A mensagem orienta conferir `/produtos` e `Historico`. Corrija manualmente ou envie um novo comando apenas após conferir o resultado. Sheets não oferece transação atômica entre todas as operações; gravação parcial é possível, mas não é repetida automaticamente.
- Erro de envio ao Telegram permite reenviar a resposta já calculada, sem repetir a alteração do produto. Uma falha entre envio e registro pode duplicar uma resposta, não a operação.
- Alterar visibilidade não renova o TTL. Trocar para outro link invalida a conferência e exige nova confirmação manual. Preços sem data, futuros ou vencidos são ocultados na fonte e no site.
- Cache de catálogo por até 15 s na fonte, até 15 s na função e CDN com validade limitada à janela restante. Considere até 45 s na transição; não existe fallback permanente com preço antigo.
- A chave protege a leitura da planilha. O endpoint do Apps Script continua acessível na internet e recebe requisições antes da autenticação: isso não elimina as cotas da plataforma nem substitui proteção contra DDoS.
- Compartilhe a planilha e o projeto Apps Script somente com os responsáveis. Caso um token/segredo real tenha sido divulgado, revogue-o no serviço de origem e atualize as propriedades; apagar mensagens não o revoga.

## Testes locais

```sh
node --test tests/*.test.mjs automation/google-apps-script/test.mjs
```

Os testes usam serviços simulados, sem alterar a planilha ou enviar mensagens reais. Eles cobrem acesso negado, fórmulas, reentregas, falhas parciais, TTL, cache, validação do catálogo e escape de HTML. A configuração das contas e a instalação real do Apps Script precisam de validação separada após publicar.

## Instalar o comando /verificar na instalação existente

Não altere chaves, propriedades, URL ou planilha. Substitua o conteúdo de Código.gs por Code.gs deste diretório, salve e atualize a mesma implantação em **Implantar → Gerenciar implantações → Editar (lápis) → Nova versão → Implantar**. Execute `installWebhook` no editor uma vez para atualizar o menu. Teste `/verificar` com o ID de um produto que acabou de conferir e recarregue o site após até 45 segundos. A imagem antiga do guia não contém este novo comando; `/ajuda` contém.

## Conferência diária com botões

1. Depois de instalar este arquivo e atualizar a **mesma implantação**, execute `installWebhook` novamente: ele passa a aceitar `callback_query`, necessário para os botões. Propriedades, token, URL e planilha permanecem iguais.
2. Envie `/conferir` no chat privado autorizado. A lista mostra todos os produtos, inclusive inativos, em páginas de cinco, dos mais recentes para os mais antigos. As marcações de hoje usam o fuso `America/Sao_Paulo`.
3. Toque em **Abrir oferta**, confira manualmente o preço e as condições (como Pix) e volte ao bot. Se o preço estiver igual ao cadastrado, toque em **Preço continua igual**. O painel será editado para **Verificado**, a data do produto será renovada e o histórico receberá `verificar`. Preço antigo e selo são limpos porque essa ação confirma apenas o preço atual. Se mudou, use `/preco ID NOVO_VALOR` e abra `/conferir` novamente.
4. Use **Anterior/Próxima** para continuar. A marcação é lida da data dos produtos: permanece ao voltar de página, reabrir a lista ou reiniciar o bot no mesmo dia. Não há botão para confirmar todos de uma vez.

### Segurança dos botões

- Cada página recebe uma sessão aleatória de até uma hora, vinculada ao dono, ao chat privado e à mensagem enviada pelo bot. O cache do Apps Script pode removê-la antes; nesse caso o bot pede `/conferir`, sem gravar. A página guarda somente cinco produtos; o callback usa um token curto, sem token do Telegram nem IDs pessoais.
- O bot compara ID, preço, link e data antes de confirmar. Se o produto foi alterado, desativado ou duplicado desde a abertura, exige nova lista. Links são validados e preservados exatamente; não são abertos automaticamente.
- Confirmações passam pelo mesmo lock e recibo durável das mensagens. A sessão é marcada como `processing` antes da escrita; um clique repetido ou resultado incerto não executa a alteração novamente. Falha de atualização visual pode ser tentada novamente sem repetir a escrita. Os recibos antigos de texto permanecem compatíveis.
- Produtos já verificados hoje não recebem nova data por clique repetido. Ao virar o dia, uma página ainda válida pode confirmar de novo. No dia seguinte, os demais voltam a **A conferir**.
- Os testes são locais e simulam Telegram e Sheets; instalação, permissões e funcionamento no Telegram real devem ser confirmados depois da publicação pelo proprietário.

## Painel de gerenciamento completo

A entrada principal agora é `/painel`; `/conferir` permanece como atalho. A lista mostra um botão por produto, com nome e preço. Toque no nome para abrir somente as funções daquele produto, dispensando copiar o ID. **Voltar aos produtos** retorna à mesma página da lista. Após editar, o produto permanece selecionado. Os comandos antigos continuam funcionando.

- **Mudar preço / Mudar link / Trocar foto:** toque no botão e responda à pergunta enviada pelo bot. A resposta usa o recurso Responder do Telegram e só vale para a pergunta mais recente. O bot rejeita respostas soltas, de outra pessoa, de uma pergunta substituída ou com dados inválidos. Um preço novo renova a data e limpa preço antigo/selo. Trocar para outro link apaga a data de conferência e limpa preço antigo/selo; o preço cadastrado fica guardado para você conferir na nova oferta. Foto e visibilidade preservam a data.
- **Ativar / Desativar:** altera a visibilidade imediatamente, sem excluir o produto. Itens inativos continuam disponíveis no painel privado; o catálogo público continua excluindo-os.
- **Adicionar produto** (ou `/adicionar` sem parâmetros): assistente com nome, descrição opcional, preço, link e imagem opcional. Responda `/pular` na descrição ou imagem para deixar esses campos vazios. O ID é gerado automaticamente, inclusive quando já existe outro produto de nome semelhante. Nada é salvo até **Confirmar cadastro** no resumo. **Cancelar** ou `/cancelar` abandona o pedido.
- **Fotos:** o assistente aceita apenas caminho já publicado em `/assets/` ou URL HTTPS direta. Não há upload de anexo do Telegram para o site. Um cadastro sem foto exibe o comportamento já existente “Foto em breve”. Não se adicionam credenciais de armazenamento.

### Instalação e uso

Substitua todo o conteúdo de Código.gs por este Code.gs, salve, atualize a mesma implantação em **Implantar → Gerenciar implantações → lápis → Nova versão → Implantar** e execute `installWebhook`. Não altere propriedades, token ou URL. Abra uma lista nova com `/painel` após instalar; mensagens antigas podem pedir que você reabra a lista.

Pedidos e painéis expiram em até uma hora e podem expirar antes se o Google remover o cache. Abrir `/painel`, iniciar outra edição/cadastro ou enviar `/cancelar` permite recomeçar. Um pedido antigo nunca autoriza sobrescrever um produto que mudou depois da seleção. A escrita usa o mesmo lock, recibos e histórico das funções anteriores; um resultado incerto bloqueia tentativas automáticas de repetir a operação. Falhas do Google podem causar escrita parcial e precisam de conferência em `/produtos` e `Historico`.

Os testes locais cobrem o painel, permissões, confirmação, respostas vinculadas, cancelamento, expiração, preço/link/foto, visibilidade, cadastro, fórmulas e reentregas. Depois da publicação, valide no Telegram real: abra `/painel`, confira um preço e teste uma edição autorizada. A instalação real não é executada pelos testes.

## Lista compacta e funções do produto

A tela inicial de `/painel` contém somente os produtos (cinco por página), **Anterior/Próxima** e **Adicionar produto**. As ações **Abrir oferta**, **Verificar**, **Mudar preço**, **Mudar link**, **Trocar foto** e **Ativar/Desativar** aparecem ao tocar em um produto. **Voltar aos produtos** retorna à lista e cancela uma pergunta pendente, evitando gravar uma resposta fora de contexto. Um botão de ação só é aceito para o produto selecionado; ações antigas de outro item são recusadas. Preço, link, foto, cadastro, visibilidade, autorização e recibos mantêm as regras anteriores.

## Correções da revisão de 30/10/2026

- Uma oferta com outro link não herda a confirmação do anúncio anterior. A data é invalidada e persistida antes da mudança de destino. Alterações de preço também invalidam a data antes da escrita e só confirmam ao final; uma falha parcial não deixa um preço novo com uma conferência antiga. Sheets não oferece transação entre todas as etapas: confira o histórico se houver aviso de resultado incerto.
- Preços em reais devem ficar apenas no campo de preço. O cadastro recusa valores monetários em nome, descrição, alt, características e selo. A fonte, a API do site e o navegador omitem campos de texto antigos que contenham valores monetários, mesmo dentro do TTL, para não mostrar uma quantia desatualizada após editar o preço. Especificações como 130.000 RPM e 24 cm continuam aparecendo. A planilha antiga não é reescrita por essa filtragem; revise manualmente os textos omitidos, mantendo condições como Pix sem repetir valores. Isso não analisa preços desenhados dentro de imagens.
- Cada versão do painel tem uma revisão. Reentregas só reapresentam a revisão ainda atual, válida e vinculada ao chat e à mensagem. Uma resposta antiga não substitui a seleção atual. Painéis sem revisão, da versão anterior do código, devem ser reabertos com /painel.
- Substitua todo o Código.gs no mesmo projeto e publique uma nova versão da mesma implantação. Execute installWebhook e abra /painel novamente. As propriedades, chaves, planilha e URL continuam iguais. A publicação do site pelo GitHub não atualiza automaticamente o Apps Script.
