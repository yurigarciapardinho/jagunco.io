# Jagunco.io

Survival multiplayer 2D ambientado no sertão. O servidor é autoritativo e usa o núcleo funcional do clone anexado do MooMoo 1.9.4, com apresentação, identidade, autenticação, persistência e operação próprias do Jagunco. Não há conexão com servidores oficiais do MooMoo ou da FRVR.

## Conteúdo e sistemas

- Mundo de 14.400 × 14.400 unidades, rio com correnteza, neve, deserto e área secreta com arena.
- 16 armas, 5 variantes por XP, progressão até idade 100 e árvore de upgrades com pré-requisitos.
- 23 itens em 14 grupos: alimentos, paredes, spikes, moinhos, armadilhas, boost, turret, plataforma, healing pad, spawn pad, blocker e teleporter.
- 13 tipos ativos de criaturas, incluindo MOOSTAFA, MOOFIE, Treasure e Crab King; Crab e Crabling permanecem dormentes como na referência.
- 49 chapéus e 21 acessórios com posse, compra e efeitos server-side.
- Combate corpo a corpo e à distância, knockback, escudos, veneno, sangramento, roubo de vida, morte e respawn.
- Convidados ou contas com senha scrypt, nomes permanentes, perfis, estatísticas, rankings, amigos, presença, clãs, tribos, chat e mensagens privadas.
- Moderação, denúncias, verificação de protocolo, tickets de entrada, selo do bundle, sequência de frames e limites de taxa.
- Controles desktop e touch, configurações, rebinding, loja e editor de aparência.

A matriz de origem, adaptações, estado e evidências está em `PARITY.md`.

## Executar

Requer Node.js 20 ou superior.

```bash
npm ci
npm run build
npm start
```

Abra `http://localhost:3000`. O build gera:

- `dist/boot.js`: servidor completo empacotado, escutando em `0.0.0.0:3000`;
- `dist/official/`: cliente 1.9.4 patchado e reskinado;
- `dist/public/`: sprites, fontes e demais arquivos estáticos, todos locais.

Para rodar diretamente do código-fonte em desenvolvimento:

```bash
npm run start:source
```

`PORT`, `HOST` e `DATA_DIR` podem ser configurados. Sem `NODE_ENV=production`, o modo de desenvolvimento pode usar arquivos em `DATA_DIR`.

## Produção e persistência

Produção exige **MySQL** e um segredo de aplicação:

```dotenv
APP_SECRET=<valor-longo-e-aleatorio>
DATABASE_URL=mysql://usuario:senha@host:3306/jagunco
```

Contas, credenciais, preferências, perfis, estatísticas, amigos, clãs, chat e moderação são hidratados no boot e persistidos em 24 tabelas relacionais. As escritas são assíncronas e enfileiradas fora do loop da partida; o desligamento faz flush antes de encerrar. Sem `DATABASE_URL` ou `APP_SECRET`, o boot de produção falha explicitamente em vez de apresentar arquivos locais como persistência.

A partida transitória continua em memória. Uma queda de WebSocket tem 30 segundos de grace para retomar a mesma sessão, posição, recursos e construções sem duplicação; kick e ban não retomam. Isso não é apresentado como persistência integral do mundo após reinício.

### Docker Compose

O Compose inclui aplicação, MySQL 8.4 com volume e Caddy nas portas 80/443:

```bash
cp .env.example .env
# Preencha APP_SECRET, MYSQL_PASSWORD e MYSQL_ROOT_PASSWORD no .env.
# Opcional: OWNER_EMAIL=<seu-email> promove essa conta a administradora.
docker compose up -d --build
```

Somente o Caddy é exposto. O banco e a aplicação ficam na rede interna. `game-data` guarda apenas o pin do protocolo e o token administrativo local; os dados sociais ficam em `mysql-data`.

## Testes e verificação

```bash
npm test                         # testes de servidor e regressões
node --test server/src/network/reconnection.test.js
node scripts/verify-authoritative.mjs
npm run build
node scripts/verify-mobile.mjs
```

Smoke operacional:

```bash
curl http://localhost:3000/ping
curl http://localhost:3000/s/LC/ping
```

O console administrativo aceita comandos apenas por loopback e exige o token de `DATA_DIR/admin.token`. Não exponha esse arquivo nem o `.env`.

### Administrador no jogo

1. Crie entre com uma conta e escolha o nome do jogador.
2. Conceda o cargo pelo e-mail do proprietário em `OWNER_EMAIL` ou pelo console:

```bash
docker compose exec app node tools/console.mjs "role <nome-do-jogador> admin"
```

3. Entre novamente na partida. Contas administradoras veem o botão **Admin**, com Godlike, imortalidade, aura, chefe, invisibilidade, multiplicadores, recursos e invocação de animais. O painel usa somente pacotes autorizados pelo servidor; convidados e contas comuns não recebem esses poderes.

## Arquitetura

- `server/src/moomoo/`: simulação autoritativa — jogador, física, combate, IA, objetos, projéteis e tribos.
- `shared/`: fonte única de armas, itens, variantes, loja, mapa e regras compartilhadas.
- `server/src/network/`: protocolo, validação, tickets, anticheat e reconexão.
- `server/src/api/`: contas, amigos, clãs, perfis, chat e moderação.
- `server/src/persistence/`: Drizzle + MySQL, migrações idempotentes e fila de escrita.
- `client-official/`: cliente 1.9.4 e shim local de serviços; o build não chama serviços externos.
- `tools/build-official-client.mjs`: patches de rede, autenticação senha-first, marca e renderer.
- `art/source/` e `tools/generate_jagunco_assets.py`: fontes editáveis e pipeline de 186 sprites.
- `scripts/build-clone.mjs`: build único de servidor, cliente, assets e módulo touch.

Sandbox e recursos infinitos são opt-in de desenvolvimento (`IS_SANDBOX=1`, `SANDBOX_UNLIMITED=1`). Em produção, custos e limites normais estão sempre ativos.

## Limites da referência

O código do servidor oficial do MooMoo não é público. A referência é o cliente 1.9.4 e o servidor reconstruído anexado; regras reconstruídas não são apresentadas como equivalência interna perfeita com o servidor privado oficial. Serviços FRVR, anúncios, analytics e captcha externa foram substituídos por fluxos locais. Contas usam senha real; o fluxo de demonstração que aceitava qualquer código foi desativado.

## Licença e créditos

Veja `LICENSE`, `MOOMOO_CLONE_LICENSE.md` e `CREDITS.md`. Fontes, bibliotecas e materiais de referência têm seus avisos preservados.
