# Jagunco.io

Survival multiplayer 2D ambientado no sertão. O servidor é autoritativo e usa o núcleo funcional do clone anexado do MooMoo 1.9.4, com apresentação, identidade, autenticação, persistência e operação próprias do Jagunco. Não há conexão com servidores oficiais do MooMoo ou da FRVR.

## Operação privada e contêineres

A instalação reproduzível usa imagens prontas, segredos por arquivo e
migrador separado. Consulte [instalação e recuperação](docs/operations/containers.md),
[contrato da central privada](docs/operations/control-contract.md) e
[poderes e recompensas](docs/operations/admin.md).

A central do dono é uma aplicação separada, acessível por túnel SSH. O
jogo sozinho continua instalável sem acesso ao repositório privado.

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

Produção: Node.js 26.13.0 LTS. A CI também verifica compatibilidade com Node 24.22.2 ou superior na linha 24.

```bash
npm ci
npm run build
npm run start:source
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

Contas, credenciais, preferências, perfis, estatísticas, amigos, clãs, chat e moderação são hidratados no boot e persistidos em tabelas relacionais. As escritas são assíncronas e enfileiradas fora do loop da partida; o desligamento faz flush antes de encerrar. Sem `DATABASE_URL` ou `APP_SECRET`, o boot de produção falha explicitamente em vez de apresentar arquivos locais como persistência.

A partida transitória continua em memória. Uma queda de WebSocket tem 30 segundos de grace para retomar a mesma sessão, posição, recursos e construções sem duplicação; kick e ban não retomam. Isso não é apresentado como persistência integral do mundo após reinício.

### Docker Compose

O Compose inclui app sem privilégios, migrador separado, MySQL e Caddy.
Construa a imagem fora da EC2 e use os instaladores:

```bash
docker build -t jagunco-game:<revisao> .
sudo scripts/install.sh --directory /opt/jagunco \
  --image jagunco-game:<revisao> --control
```

O instalador gera arquivos de segredo, provisiona usuários SQL distintos e
prepara volumes. Consulte [operação em contêineres](docs/operations/containers.md)
para instalar, adotar a EC2 existente, atualizar, fazer backup e restaurar.
Somente Caddy publica portas em produção. O perfil de desenvolvimento
publica o app em loopback. O conector privado é opcional e usa Unix socket.

## Testes e verificação

```bash
npm test                         # testes de servidor e regressões
node --test server/src/network/reconnection.test.js
node scripts/verify-authoritative.mjs
npm run build
node scripts/verify-mobile.mjs
npm run verify:admin             # cliente gerado, painel e reconexão em navegador
npm run verify:cave              # caverna, guardiões, combate e touch real
npm run verify:rewards:mysql     # recompensas, MySQL real e reinício; requer Docker
```

Smoke operacional:

```bash
curl http://localhost:3000/ping
curl http://localhost:3000/s/LC/ping
```

O console administrativo aceita comandos apenas por loopback e exige o token de `DATA_DIR/admin.token`. Não exponha esse arquivo nem o `.env`.

### Administrador no jogo

1. Entre com uma conta e escolha o nome do jogador.
2. Configure OWNER_EMAIL para o bootstrap inicial ou conceda o cargo pela
central privada do dono. A API pública de promoção de cargos é fechada.
OWNER_EMAIL é aplicado uma vez; uma despromoção posterior permanece no banco.

3. O cargo é aplicado imediatamente, inclusive para quem já está conectado. Contas administradoras na partida veem o botão **Admin**, com Godlike, imortalidade, aura, chefe, invisibilidade, multiplicadores, recursos e invocação de animais. Convidados, contas comuns e moderadores não têm acesso ao painel.

Botões e seletores mostram o estado confirmado pelo servidor, inclusive ao reabrir o painel ou retomar a sessão. Godlike combina Imortal e Aura: desligar um desses componentes desmarca Godlike.

Poderes, multiplicadores e efeitos temporários do console duram a vida atual. Uma queda de conexão preserva esse estado por até 30 segundos; retomar nesse prazo mantém personagem, inventário, recursos, equipamentos e progressão. Morrer, iniciar outra vida ou deixar a janela expirar limpa os poderes. Reiniciar o servidor também inicia personagens novos; o cargo salvo na conta permanece.

Perder o cargo de administrador remove imediatamente seus poderes atuais, fecha o painel e bloqueia novos comandos. Isso também vale para personagens com a conexão suspensa e para a troca de admin para mod. Recursos e equipamentos já concedidos seguem as regras normais da partida. A central do proprietário pode conceder efeitos a jogadores sem cargo; essas concessões também terminam na morte ou em uma nova vida e não dão acesso ao painel.

## Gruta do Tesouro

A caverna fica no noroeste da região verde, entre x=1400–3800 e
y=2600–5000. A entrada ao sul tem 420 unidades de largura e centro em
x=2600, y=4940. MOOSTAFA e MOOFIE guardam fisicamente o Treasure no
interior. O baú pode ser atacado com os dois vivos.

As paredes são terreno permanente: bloqueiam corpos, golpes e projéteis,
não dão recursos e não ocupam limites de construção. A passagem e sua
aproximação ficam livres de construções; árvores, pedras e spawns
aleatórios não são gerados na área reservada. Construções comuns continuam
permitidas nas demais áreas válidas, inclusive no piso interno.

Os três moradores naturais permanecem no interior, inclusive sob empurrões.
Invocações administrativas comuns não herdam esse confinamento. Após um
abate, MOOSTAFA reaparece em 60 s, MOOFIE em 30 s e Treasure em 120 s,
nos respectivos pontos da caverna. O Crab King mantém sua arena secreta.

Servidor e cliente usam a mesma geometria; a reconexão reenvia essa
definição.

## Recompensas de encontros

| Encontro natural | Ouro do finalizador | Comida | Estatística de abate |
| --- | ---: | ---: | --- |
| MOOSTAFA | 8.000 | 100 | moostafa |
| MOOFIE | 3.000 | 1.000 | moofie |
| Treasure | 5.000 | 0 | treasure |
| Yeti | 4.500 | 800 | yeti |
| Crab King | 4.000 | 0 | crab_king |

O finalizador recebe o ouro e o registro do abate. No Crab King, assistentes vivos que ainda pertencem à mesma partida e causaram pelo menos 5% da vida máxima também recebem Crab Shell e a marcação de participação da partida; não recebem uma divisão automática do ouro. Um personagem removido não transfere essa marcação a quem reutilizar seu SID.

Invocados administrativos mantêm o ouro e os registros atuais, mas não dão comida nem reaparecem. Entidades em espera de respawn não recebem dano ou pagam outra recompensa antes de reaparecer.

O ouro alimenta a progressão de XP com o mesmo valor. A regra atual avança no máximo uma idade por chamada e descarta o excedente ao atingir o limiar; esse comportamento foi mantido. O drop de comida também acrescenta seu valor ao XP da arma atual, separadamente dos ganhos dos golpes.

### Crab Shell: perfil e equipamento

Para contas autenticadas, a conquista do Shell registra imediatamente o desbloqueio da aparência no perfil e enfileira sua persistência. O registro é idempotente e também considera chapéus earned de preço zero ao salvar uma vida. A conclusão da fila confirma a gravação no banco.

A aparência do perfil permanece após sair ou reiniciar. A posse do equipamento de combate segue as regras da partida: permanece no mesmo personagem, inclusive na retomada durante a janela de reconexão, mas não é concedida automaticamente a um personagem novo. O item continua indisponível para compra comum. Estatísticas acumuladas de ouro e comida não são um saldo de recursos restaurado em uma nova partida.

Não há migração retroativa de recompensas antigas neste lote. A correção registra novas conquistas e os itens ganhos ainda presentes ao salvar uma vida.

### Verificação com MySQL real

O comando npm run verify:rewards:mysql requer Docker e a imagem mysql:8.4 instalada. Ele cria um banco de teste exclusivo em loopback, usa o modo de produção sem fallback JSON, verifica as recompensas e a aparência, reinicia o banco e a aplicação compilada e remove o contêiner e o volume criados pelo próprio teste.

Essa verificação também confere a credencial e o cargo persistidos, a revogação de poderes, a ausência de equipamento automático no personagem novo e a rejeição de aparência não conquistada ou autenticação inválida.

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

## Contribuição

Todas as alterações seguem a convenção de commits descrita em
[CONTRIBUTING.md](CONTRIBUTING.md): títulos de até 50 caracteres e corpo
com finalidade e validação. O histórico novo é verificado na integração
contínua com npm run check:commits.
