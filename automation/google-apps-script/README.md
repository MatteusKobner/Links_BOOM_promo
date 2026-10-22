# Bot de atualização da BOOM Promo

O arquivo `Code.gs` é executado no Google Apps Script e mantém a planilha como fonte dos produtos.

## Configuração segura

1. No projeto Apps Script da BOOM Promo, substitua o conteúdo de `Código.gs` pelo arquivo `Code.gs` e salve.
2. Em **Configurações do projeto → Propriedades do script**, crie: `SPREADSHEET_ID`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET`, `SETUP_CODE` e `WEB_APP_URL`. Não crie `ALLOWED_CHAT_ID`: ele será registrado pelo primeiro acesso autorizado.
3. Publique como **Aplicativo da Web**, com acesso para qualquer pessoa. Copie a URL `/exec`.
4. Atualize `WEB_APP_URL` com a URL `/exec` recebida na publicação. No editor do Apps Script, execute `installWebhook` para conectar o Telegram sem expor o token.
5. Envie `/start SEU_SETUP_CODE` no chat privado. Isso vincula somente essa conversa ao bot.
6. Envie `/produtos` e confira a lista antes de testar qualquer alteração.
7. Execute `diagnosticarWebhook` no editor caso o bot não responda. O registro mostra apenas se o webhook está ativo, a quantidade de mensagens pendentes e a última falha. Não divulgue a URL do webhook, pois contém o segredo.
8. Depois de testar o bot, publique o site com `/api/products` na Vercel e valide a leitura no navegador. Essa rota consulta a URL pública `/exec` sem expor o segredo do webhook.

Ao editar o script já publicado: **Implantar → Gerenciar implantações → Editar → Nova versão**. A URL `/exec` é mantida ao editar a mesma implantação. Execute `installWebhook` novamente se mudar o segredo, o token ou a URL, ou para aplicar a configuração de uma conexão por vez.

O webhook retorna HTML simples para evitar o redirecionamento do `ContentService` nas respostas ao Telegram. Os produtos continuam servidos como JSON em `doGet`.

O comando `/preco` registra uma nova data de verificação; use-o apenas após conferir o preço. Os comandos `/link`, `/ativar` e `/desativar` não renovam a data do preço. `/atualizar` valida preço e link antes de gravar.

## Comandos permitidos

- `/produtos`
- `/preco ID 51,00`
- `/link ID https://meli.la/...`
- `/atualizar ID 51,00 https://meli.la/...`
- `/ativar ID`
- `/desativar ID`
