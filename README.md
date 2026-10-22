# BOOM Promo — Vitrine de achadinhos

Site sem framework. Os cards são carregados pelo `app.js` a partir de `/api/products`, uma função na Vercel que consulta o catálogo público do Google Apps Script. O bot no Telegram altera a planilha e uma nova visita ao site lê esses dados. A API do Mercado Livre não é consultada.

## Adicionar ou editar produtos

Use a aba `Produtos` da planilha BOOM Promo. Para alterar preços após conferência manual, envie `/preco ID 51,00` ao bot; `/link ID https://meli.la/...` altera somente o link. `products.json` permanece como referência local e não alimenta mais os cards publicados.

O JSON da planilha contém objetos como:

```json
{
  "id": "nome-curto-unico",
  "name": "Nome do produto",
  "description": "Descrição curta",
  "price": "R$ 99,90",
  "data_verificacao": "2026-10-22T17:59:00.000Z",
  "store": "Mercado Livre",
  "url": "https://meli.la/SEU-LINK",
  "badge": "Achadinho do momento",
  "features": ["Característica 1", "Característica 2", "Característica 3"],
  "active": true,
  "image": "/assets/foto-do-produto.webp",
  "alt": "Descrição da imagem do produto"
}
```

Os preços aparecem apenas por 48 horas após `data_verificacao`; sem data ou com prazo vencido, aparece “O preço pode ter mudado”. O link do produto continua disponível. Alterar somente o link ou a visibilidade não renova a data de verificação. Coloque as fotos corretas em `assets/`. Prefira WebP otimizado. O layout mantém a imagem inteira, sem recortá-la. Deixe `image` e `alt` vazios quando não houver uma foto correta: o card exibe “Foto em breve”. Imagens que falharem também recebem esse tratamento. Até quatro características aparecem no card. `active: false` oculta o produto.

A foto atual do Davely é uma versão otimizada da imagem existente “Mini Soprador Davely em Destaque.png”, sem recriar ou modificar o produto. A logo sem fundo enviada está em `assets/logo.png`, otimizada e com transparência preservada.

## Redes sociais

No início de `app.js`, preencha `socialLinks` apenas com URLs reais dos perfis. Os três perfis oficiais já estão configurados. Valores vazios deixam os botões indisponíveis, sem links fictícios.

## Testar localmente

Na pasta do projeto, execute `vercel dev` e abra a URL indicada. Isso executa também `/api/products`; um servidor de arquivos estáticos não executa a função. Para testar a rota isoladamente sem rede, rode `node --test api/products.test.mjs`.

## Publicação

A branch principal está integrada à Vercel. Um push dispara o deploy automaticamente. Não há dependências ou etapa de build.
