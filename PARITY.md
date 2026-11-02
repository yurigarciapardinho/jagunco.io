# Jagunco.io — matriz de paridade com o clone anexado

Referência comportamental: `moomoo-clone` com cliente 1.9.4 (`index-993d072d.js`, API 1.31) e servidor local reconstruído. O servidor oficial privado do MooMoo não está nos anexos; esta matriz não afirma equivalência interna com ele.

**Status: integração e testes locais concluídos; publicação em andamento.** A coluna de evidência distingue teste de unidade, navegador, MySQL real e produção.

## 1. Arquitetura adotada

- Servidor autoritativo `server/` + dados `shared/`, empacotados em `dist/boot.js`.
- Cliente funcional 1.9.4 em `client-official/`, com rede, marca, autenticação senha-first e renderer adaptados.
- Apresentação Jagunco: 186 sprites, CSS e 31 substituições de cores no renderer; geometria e hitboxes preservados.
- MySQL/Drizzle para dados sociais e de conta. O mundo transitório permanece em memória, com retomada por 30 segundos após queda de WebSocket.
- O antigo MVP React/Pixi/Hono e o cliente webpack legado foram removidos do pacote ativo e permanecem apenas nos backups.

## 2. Legenda

| Estado | Significado |
| --- | --- |
| **portada** | Reutiliza o módulo/dado ativo da referência, sem redução de conteúdo. |
| **adaptada** | Mantém a função e altera identidade, segurança, persistência ou requisito explícito do briefing. |
| **pendente** | Ainda não integrado ou não verificado. |
| **intencionalmente substituída** | Serviço externo substituído por equivalente próprio. |
| **legada** | Código dormente/histórico, fora do caminho ativo. |

## 3. Catálogo verificado

| Conteúdo | Quantidade ativa | Origem única | Estado |
| --- | ---: | --- | --- |
| Armas | 16 | `shared/config/items.js` | portada |
| Variantes de arma | 5: normal, gold, diamond, ruby, emerald | `shared/config.js` | portada |
| Projéteis | 6 definições | `shared/config/items.js` | portada |
| Itens/consumíveis/construções | 23 em 14 grupos | `shared/config/items.js` | portada |
| Tipos de IA | 15; 13 ativos + Crab/Crabling dormentes | `aiManager.js`, `animalSpawnPlan` | adaptada apenas no Yeti |
| Chefes/encontros especiais | MOOSTAFA, MOOFIE, Treasure, Crab King | `aiManager.js`, `server.js` | portada |
| Chapéus | 49 | `shared/config/store.js` | portada |
| Acessórios | 21 | `shared/config/store.js` | portada |
| Biomas/regiões | pradaria, rio, neve, deserto, área secreta | `shared/config.js`, `player.js`, `effects.js` | adaptada visualmente |
| Servidores | LC público/40; MB membros/80 | `server/src/index.js` | portada |
| Pacotes | 22 C→S, 40 S→C | `server/src/protocol/constants.js` | portada |
| Sprites Jagunco | 186 arquivos | `tools/generate_jagunco_assets.py`, `art/source/` | adaptada |

## 4. Matriz funcional

### 4.1 Combate, física e progressão

| Sistema | Origem / arquivos | Estado | Teste de aceitação e evidência |
| --- | --- | --- | --- |
| Movimento, desaceleração, limites e colisões | `player.js`, `objectManager.js` | portada | Suíte de mundo/combate; movimento real no navegador de 3996 para 4569 no eixo X. |
| Arco, alcance, dano, cooldown e lentidão de golpe | `player.js`, `items.js` | portada | `combat.test.js`: dano/knockback exatos, misses e cooldown real. |
| Knockback, escudos, roubo, veneno, lifesteal e reflexo | `player.js`, `effects.js` | portada | Suites de combate, projétil e efeitos, 122/122. |
| Projéteis sem tunneling e interação com estruturas | `projectile.js`, `projectileManager.js` | portada | Sweep de 800 unidades, escudo, Blockades, paredes, plataformas e range. |
| Coleta manual/automática e recursos por disparo | `player.js`, `items.js` | portada | Navegador: madeira e comida creditadas; suites de coleta/custo. |
| Cura instantânea/HoT, Shame, morte e respawn | `player.js`, `server.js` | portada | Suites de combate; morte e respawn também exercitados no navegador. |
| XP, idade 100 e árvore com grupos/pré-requisitos | `player.js`, `packets.js` | portada | Idade, pontos, grupo e `pre`; hand axe selecionado no cliente real. |
| XP por arma e variantes, incluindo emerald de membro | `config.js`, `player.js` | portada | Limiares 3000/7000/12000/30000, dano, veneno e lifesteal medidos. |
| Morte, recompensa, retenção de equipamento e spawn pad | `player.js`, `objectManager.js` | portada | Suites de morte/loja/spawn pad; posse após morte. |

### 4.2 Construções

| Sistema | Origem / arquivos | Estado | Teste de aceitação e evidência |
| --- | --- | --- | --- |
| Custo único, overlap, grupo, limite, rio e blocker | `player.js`, `objectManager.js` | portada | `structures.test.js`; parede real custou 10 madeiras (104→94). |
| Paredes e spikes comuns/maiores/venenosos/giratórios | `items.js`, `gameObject.js` | portada | Dano 20, solidez, knockback, DoT, imunidade de dono/equipe. |
| Pit trap e `noTrap` | `objectManager.js`, `ai.js` | portada | Imobilização sem dano; Quack/Yeti não presos. |
| Yeti quebra construções e não pode ser preso | `aiManager.js`, `ai.js` | **adaptada** | Requisito próprio: `noTrap=true`, `hitRange=180`, `hitDelay=900`; parede sofre `dmg×5` no teste. |
| Boost, healing, teleporter e spawn pad | `objectManager.js`, `player.js` | portada | Impulso, 15 HP/s, teleporte e consumo do spawn pad. |
| Moinhos e turrets | `gameObject.js`, `server.js` | portada | PPS, cadência, alcance, EMP, time e invisibilidade. |

### 4.3 Animais, chefes e mundo

| Sistema | Origem / arquivos | Estado | Teste de aceitação e evidência |
| --- | --- | --- | --- |
| Passivos vagam/esperam e só fogem após dano | `ai.js` | portada | 200 ticks sem fuga por proximidade; fuga por ~2 s após golpe; vaca fugiu no navegador. |
| Hostis adquirem, perseguem, atacam e desistem | `ai.js` | portada | Lobo, carga, dano/knockback, perda de alvo e invisibilidade/bullRepel. |
| 13 tipos ativos, drops, XP e respawn | `aiManager.js`, `server.js` | portada | 51 animais no mundo; suites de recompensa, Cow Cape, fixedSpawn/spawnDelay. |
| MOOSTAFA, MOOFIE e Treasure | `aiManager.js`, `server.js` | portada | Tabela, arenas, dontRun/hitScare e recompensas. |
| Crab King: dive, slam, geysers, claws e recompensa | `ai.js`, `server.js` | portada | Padrões acionados na arena; abate deu +4000 ouro e respawn de ~600 s; Crab Shell equipado e visível. |
| Rio, correnteza, plataforma e watrImm | `player.js`, `objectManager.js` | portada | Razões 0,33/0,75/0,4 medidas; plataforma remove penalidade. |
| Neve e equipamentos de frio | `player.js`, `effects.js` | portada | 0,75, imunidade e Snowball 0,875. |
| Deserto/cactos e área secreta | `server.js`, `effects.js` | portada | 20 de dano apenas na região; desfiladeiro e água profunda. |
| Geração e limites do mundo | `server.js`, `config.js` | portada | 564 objetos, 51 animais e quatro encontros especiais no smoke headless. |

### 4.4 Loja, economia e equipamentos

| Sistema | Origem / arquivos | Estado | Teste de aceitação e evidência |
| --- | --- | --- | --- |
| Ouro, moinhos, compra única, posse e equipamento | `packets.js`, `player.js` | portada | Compra, fundos, dontSell, reequipamento gratuito e posse após morte. |
| Efeitos de chapéus e acessórios | `store.js`, `effects.js`, `player.js` | portada | Suites cobrem regeneração, coleta, ouro, reflect, healD, DoT, invisibilidade, frio e projéteis. |
| Crab Shell e equipamento visível | `server.js`, cliente renderer | portada | Drop real equipado sem nova cobrança; sprite e ícone no placar. |
| Editor de loja e aparência | `store.js`, cliente 1.9.4 | portada | Contratos de unlock/look preservados; interface ativa. |

### 4.5 Social, contas e persistência

| Sistema | Origem / arquivos | Estado | Teste de aceitação e evidência |
| --- | --- | --- | --- |
| Jogo como convidado e tickets/dispositivo | `routes.js`, `store.js`, `connection.js` | portada | Dois navegadores em LC; tickets single-use e gate. |
| Contas com senha real | `routes.js`, `passwords.js` | **adaptada** | scrypt, senha mínima e rate limit; cadastro, erro, login e conta 200; código legado 410. |
| Nome permanente, prefs, look, anon e perfis | `store.js` | portada | Nome recuperado após reinício; contratos ativos. |
| Amigos, pedidos, presença e convites | `social.js`, `pageStream.js` | intencionalmente substituída | Amizade aceita entre duas contas reais e recuperada após reinício; equivalente próprio, sem FRVR. |
| Clãs persistentes, cargos e tribos | `store.js`, `clanManager.js` | portada | Clã `QAE` persistiu após reinício; permissões nos pacotes. |
| Chat geral, whisper, clã, `/w`, `/r`, `/c` | `chat.js`, `packets.js` | portada | Chat visto no segundo navegador; whisper e clã persistidos. |
| Rankings, estatísticas e coroas | `store.js`, `server.js` | portada | APIs `/top`, perfil, leaderboard e ícones locais. |
| MySQL para dados sociais/moderação | `server/src/persistence/` | **adaptada** | 24 tabelas; 18 testes de persistência; reinício real recuperou contas, amigos, clã e chats. |
| Reconexão após queda | `reconnection.js`, `connection.js`, `packets.js` | **adaptada** | 9 testes de wire protocol; navegador manteve SID 0 e posição 6454,14075, sem duplicação. |
| Moderação e ferramentas administrativas | `anticheat/`, `routes.js`, `admin/` | portada | Permissões, bans/reports e acesso administrativo só por loopback+token. |

### 4.6 Protocolo, segurança e controles

| Sistema | Origem / arquivos | Estado | Teste de aceitação e evidência |
| --- | --- | --- | --- |
| Origem, build, bundle, ticket e membros | `connection.js`, `config.js` | adaptada | Gate ativo; configuração ausente no anexo reconstruída e coberta por 9 testes. |
| HMAC, sequência, máscara, ledger e selo | `protocol/` | portada | Replay, gap, tamper, malformed, unknown e selo quebrado rejeitados. |
| Rate limit, payload e validação de ações | `anticheat/`, `packets.js` | adaptada | Flood, 40 strikes, payload limitado e permissões forjadas rejeitadas. |
| Desktop, keybinds, loja e menus | cliente 1.9.4 | portada | Movimento, ataque, coleta, construção, upgrade, chat e loja no Chromium. |
| Mobile, sticks, mira e ataque | `tools/build-touch-module.mjs`, cliente | **adaptada** | nipplejs local; dois sticks, frames reais, zero erros/HTTP≥400 em duas verificações. |
| Fontes e assets locais | `client/public/`, `dist/public/` | adaptada | Material Icons e Hammersmith locais; 186 sprites sem itens invisíveis. |

## 5. Dormentes ou intencionalmente fora do caminho ativo

- Crab e Crabling: definições sem spawn, como na referência; Crab King é o único caranguejo ativo.
- `DAY_INTERVAL`, tuning animal multiplicado por zero e texture packs de desenvolvimento: não tratados como recursos ativos.
- Cliente webpack legado e MVP React/Pixi/Hono: removidos do pacote, preservados em backup.
- FRVR, anúncios, analytics, captcha externa e Discord bot: substituídos por serviços locais; não há conexão com servidores oficiais.
- `objectManager.addProjectile` dormente/quebrado, `mapManager` vazio e `setData` do lado cliente: não usados como caminho de produção.

## 6. Evidências executadas

| Área | Resultado |
| --- | --- |
| Suíte consolidada | `npm run verify`: catálogo e outputs válidos; **122/122 testes**. Uma rodada anterior teve duas falhas intermitentes de projétil; isolados e duas rodadas seguintes passaram. |
| IA | 12/12; passivo, fuga, hostis, noTrap e Yeti destruindo parede. |
| Estruturas | 13/13; custo, limites, spikes, traps, pads, turret e moinhos. |
| Combate/loja | 13/13; física, upgrades, variantes, recompensas, Shame e posse. |
| Projéteis | 9/9; tunneling, escudos, estruturas e Turret Gear. |
| Mundo/efeitos | 6/6 biomas e 7/7 efeitos de loja. |
| Protocolo/pacotes | 8/8 pacotes, 6/6 sessão, 9/9 config e 4/4 parser. |
| Persistência | 18/18 testes; MySQL real com 24 tabelas e reidratação após reinício. |
| Reconexão | 9/9 testes de protocolo + navegador com SID/posição preservados. |
| Mobile | `verify-mobile`: módulo, sticks esquerdo/direito, frames reais e zero erros. |
| Bundle isolado | `dist/` + `package.json`, sem `node_modules`: boot e `/ping` com LC/MB. |
| Benchmark de tick | 40 jogadores, 51 animais, 564 objetos, 500 ticks: média 5,37 ms; p95 34,44 ms; 32.170 frames de saída. |
| Soak | 12 s com 40 clientes simulados e 51 animais ativos; não usado como evidência de partidas humanas. |
| GPU | SwiftShader, 61,9 ms/frame; **não valida 60 fps em GPU real**. |

## 7. Limitações restantes

- A lógica do servidor oficial privado do MooMoo não está disponível; bosses, alguns efeitos e regras do clone são reconstruções.
- Não foi medido desempenho em GPU real. O dado de SwiftShader não é usado para prometer 60 fps.
- A partida transitória não é integralmente persistida após reinício; persistência garantida cobre contas/social/moderação e a retomada por 30 s cobre queda de conexão.
- Publicação e validação pública final são registradas na seção de release após o deploy.

## 8. Release

Em publicação: commit, preview e URL pública serão preenchidos após a validação final na EC2.
