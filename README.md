# BOOM Promo — Vitrine de achadinhos

Site sem framework. Os cards são carregados pelo `app.js` a partir de `/api/products`, uma função na Vercel que consulta o Google Apps Script com uma chave exclusiva de leitura mantida no servidor. O bot no Telegram altera a planilha e o site lê esses dados com cache curto (considere até 45 segundos antes de recarregar). A API do Mercado Livre não é consultada.

## Adicionar ou editar produtos

Use a aba `Produtos` da planilha BOOM Promo. Para alterar preços após conferência manual, envie `/preco ID 51,00` ao bot; `/link ID https://meli.la/...` altera somente o link. A planilha é a única fonte do catálogo publicado.

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
  "badge": "",
  "features": ["Característica 1", "Característica 2", "Característica 3"],
  "active": true,
  "image": "/assets/foto-do-produto.webp",
  "alt": "Descrição da imagem do produto"
}
```

Os preços aparecem apenas por 48 horas após `data_verificacao`; sem data ou com prazo vencido, aparece “O preço pode ter mudado”. O link do produto continua disponível. Alterar somente o link ou a visibilidade não renova a data de verificação. Use selos promocionais somente quando estiverem comprovados. Coloque as fotos corretas em `assets/`. Prefira WebP otimizado. O layout mantém a imagem inteira, sem recortá-la. Deixe `image` e `alt` vazios quando não houver uma foto correta: o card exibe “Foto em breve”. Imagens que falharem também recebem esse tratamento. Até quatro características aparecem no card. `active: false` oculta o produto.

A foto atual do Davely é uma versão otimizada da imagem existente “Mini Soprador Davely em Destaque.png”, sem recriar ou modificar o produto. A logo sem fundo enviada está em `assets/logo.png`, otimizada e com transparência preservada.

## Redes sociais

No início de `app.js`, preencha `socialLinks` apenas com URLs reais dos perfis. Os três perfis oficiais já estão configurados. Valores vazios deixam os botões indisponíveis, sem links fictícios.

## Testar localmente

Na pasta do projeto, execute `vercel dev` e abra a URL indicada. Isso executa também `/api/products`; um servidor de arquivos estáticos não executa a função. Para testar a rota isoladamente sem rede, rode `node --test tests/*.test.mjs automation/google-apps-script/test.mjs`.

## Publicação

A branch principal está integrada à Vercel. Um push dispara o deploy automaticamente. Não há dependências ou etapa de build.

## Segurança e configuração

Configure `CATALOG_READ_KEY` na Vercel e nas propriedades do Apps Script. Não publique seu valor, tokens ou arquivos `.env`. A rota falha sem uma chave válida; o código do navegador não recebe a chave. Siga a ordem de implantação em `automation/google-apps-script/README.md`.

A chave do catálogo real deve ficar somente em Production, como variável sensível. Testes locais usam dados simulados; previews precisam de uma fonte e chave de teste próprias para carregar produtos. Restringir os ambientes não revoga a chave de deployments antigos: se houver exposição, troque a chave também no Apps Script.

Selos são exibidos somente enquanto o preço e sua verificação forem válidos. Ao conferir um preço, confira também os benefícios descritos no selo; remova da planilha qualquer promessa que não seja mais verdadeira. A API limpa o selo após o vencimento e o navegador o retira mesmo com a página aberta.

### Proteção de tráfego do catálogo

O cache não substitui um limite distribuído. A regra de firewall continua pendente de configuração no painel da Vercel (a API não conseguiu consultar a configuração existente). Adicione uma regra, sem substituir a configuração completa:

- Nome: `BOOM - observar consultas do catalogo`.
- Condições juntas: Path igual a `/api/products` e Method igual a `GET`.
- Primeira etapa: ação Log, para observar o volume e IPs compartilhados sem bloquear visitantes.
- Após verificar o tráfego: avaliar 120 requisições por IP a cada 60 segundos, por região, com resposta 429 ao exceder. Ajuste conforme o uso real e os recursos disponíveis no plano; validar em preview antes de bloquear em produção.

A configuração de regras é independente do deploy do código. Não ative Attack Mode para esta manutenção.

A API valida campos e limita o tamanho da resposta, aceita apenas leitura sem parâmetros, bloqueia URLs de afiliado fora de `https://meli.la/`, limita cache ao TTL e agrupa consultas simultâneas na mesma instância. A CDN recebe cache curto sem stale-while-revalidate; falhas não reutilizam dados vencidos. O cache não é um limite global de requisições. CSP, escape de HTML e validação de links protegem os cards. As métricas só são carregadas após consentimento.

`.vercelignore` exclui testes, documentação e automação do pacote do site. Não há scraping nem chamadas à API do Mercado Livre.
