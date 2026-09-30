# BOOM Promo — Vitrine de achadinhos

Site estático, sem framework. Os cards são carregados pelo `app.js` a partir de `products.json`.

## Adicionar ou editar produtos

Copie um objeto no array de `products.json` e ajuste os campos:

```json
{
  "id": "nome-curto-unico",
  "name": "Nome do produto",
  "description": "Descrição curta",
  "price": "R$ 99,90",
  "store": "Mercado Livre",
  "url": "https://meli.la/SEU-LINK",
  "badge": "Achadinho do momento",
  "features": ["Característica 1", "Característica 2", "Característica 3"],
  "active": true,
  "image": "/assets/foto-do-produto.webp",
  "alt": "Descrição da imagem do produto"
}
```

Coloque as fotos corretas em `assets/`. Prefira WebP otimizado. O layout mantém a imagem inteira, sem recortá-la. Deixe `image` e `alt` vazios quando não houver uma foto correta: o card exibe “Foto em breve”. Imagens que falharem também recebem esse tratamento. Até quatro características aparecem no card. `active: false` oculta o produto.

A foto atual do Davely é uma versão otimizada da imagem existente “Mini Soprador Davely em Destaque.png”, sem recriar ou modificar o produto. A logo original está preservada em `assets/logo.png`.

## Redes sociais

No início de `app.js`, preencha `socialLinks` apenas com URLs reais dos perfis. Enquanto os valores estiverem vazios, os botões ficam indisponíveis, sem links fictícios.

## Testar localmente

Na pasta do projeto, execute `python3 -m http.server 8000` e abra `http://localhost:8000`. É necessário um servidor HTTP para carregar o JSON.

## Publicação

A branch principal está integrada à Vercel. Um push dispara o deploy automaticamente. Não há dependências ou etapa de build.
