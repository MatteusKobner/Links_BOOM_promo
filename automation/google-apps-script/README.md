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
- `/preco ID 51,00` — atualiza preço e a data da conferência.
- `/link ID https://meli.la/...` — altera somente o link.
- `/atualizar ID 51,00 https://meli.la/...` — valida preço e link antes da gravação.
- `/imagem ID /assets/foto.png` — altera somente a foto de um produto existente, sem renovar a verificação do preço.
- `/adicionar ID | Nome | Descrição | 51,00 | https://meli.la/... | imagem opcional | alt opcional | característica 1; característica 2 | selo opcional`
- `/ativar ID` e `/desativar ID` — alteram somente a visibilidade.

Não escreva as palavras `ID` e `VALOR`: substitua pelos dados reais. Preços usam vírgula decimal (`51,00`). O cadastro aceita 5 a 9 campos, no máximo 1000 produtos. Características usam **ponto e vírgula** dentro do mesmo campo. Campos extras são rejeitados. Informe somente benefícios comprovados; deixe o selo vazio quando não houver um verificado.

Os comandos rejeitam palavras ou parâmetros extras para evitar alterações acidentais. O preço aceito vai de R$ 0,01 a R$ 1.000.000.000,00. Toda atualização que verifica um preço limpa o campo `preço antigo`, pois o valor riscado não foi reconfirmado na mesma operação; link, imagem e visibilidade não renovam o TTL.

Imagem opcional: arquivo já publicado em `/assets/` ou URL HTTPS direta e pública da imagem, sem credenciais. O bot ainda não envia fotos ao site; quando recebe uma foto pelo Telegram, responde com `/ajuda imagens`. Imagem vazia mostra “Foto em breve”. Links existentes não são alterados por esta atualização.

Para gerenciar fotos sem editar a planilha: no GitHub do site, abra `assets` → **Add file** → **Upload files**, envie um PNG/JPG/WebP com nome simples (sem espaços) e confirme o commit. Espere o deploy de produção ficar pronto na Vercel. Para um card existente, envie `/imagem ID /assets/nome-do-arquivo.png` ao bot; para um novo, inclua o mesmo caminho no campo opcional de `/adicionar`. Evite links de compartilhamento do Drive, que não são URLs diretas de imagem. O bot muda o caminho no catálogo, mas não faz upload nem recorta a foto.

## Proteções e recuperação

- Texto é gravado como literal; entradas que poderiam virar fórmulas são neutralizadas.
- `BotRecebimentos` é criada automaticamente e mantém recibos por 48 horas. O bot só aceita comandos enviados há até 24 horas. Não apague ou edite essa aba durante a operação.
- O recibo `processing` é persistido antes de gravar. Se houver interrupção nesse intervalo, uma reentrega **não executa novamente**. A mensagem orienta conferir `/produtos` e `Historico`. Corrija manualmente ou envie um novo comando apenas após conferir o resultado. Sheets não oferece transação atômica entre todas as operações; gravação parcial é possível, mas não é repetida automaticamente.
- Erro de envio ao Telegram permite reenviar a resposta já calculada, sem repetir a alteração do produto. Uma falha entre envio e registro pode duplicar uma resposta, não a operação.
- Alterar link/visibilidade não renova o TTL. Preços sem data, futuros ou vencidos são ocultados na fonte e no site.
- Cache de catálogo por até 15 s na fonte, até 15 s na função e CDN com validade limitada à janela restante. Considere até 45 s na transição; não existe fallback permanente com preço antigo.
- A chave protege a leitura da planilha. O endpoint do Apps Script continua acessível na internet e recebe requisições antes da autenticação: isso não elimina as cotas da plataforma nem substitui proteção contra DDoS.
- Compartilhe a planilha e o projeto Apps Script somente com os responsáveis. Caso um token/segredo real tenha sido divulgado, revogue-o no serviço de origem e atualize as propriedades; apagar mensagens não o revoga.

## Testes locais

```sh
node --test tests/*.test.mjs automation/google-apps-script/test.mjs
```

Os testes usam serviços simulados, sem alterar a planilha ou enviar mensagens reais. Eles cobrem acesso negado, fórmulas, reentregas, falhas parciais, TTL, cache, validação do catálogo e escape de HTML. A configuração das contas e a instalação real do Apps Script precisam de validação separada após publicar.
