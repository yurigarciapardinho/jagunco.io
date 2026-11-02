# Jagunco.io

Survival multiplayer 2D top-down ambientado no sertão. Entre como convidado, colete recursos, evolua, construa defesas e dispute o ranking da sala contra outros jogadores e animais do mapa.

## Objetivo

Ganhe pontos coletando, caçando, construindo e vencendo confrontos. Madeira e pedra sustentam construções; comida cura; ouro aumenta sua presença na economia da partida. Ao morrer, você pode voltar à mesma sala com parte dos recursos preservada.

## Sistemas do MVP

- Sala pública real para até 40 jogadores, sem cadastro.
- Madeira, comida, pedra e ouro; recursos naturais renascem.
- Facão, lança e estilingue com alcance, dano e cooldown próprios; armas avançadas entram por escolhas de ramificação.
- XP e escolhas de nível para armas, dano, velocidade, coleta e vida máxima.
- Loja autoritativa com cinco equipamentos comprados com ouro, bônus reais e troca gratuita após a compra.
- Cercas, arame farpado e moinhos com custo, vida e limites por jogador.
- Cabras que reagem e fogem de jogadores; porcos-do-mato que perseguem e atacam.
- PvP, morte, respawn, cura e ranking da sala.
- Controles por teclado/mouse e joystick/botões de toque.
- Atlas visual de caatinga com personagens, armas, animais, recursos e construções; animações de caminhada, golpe, impacto e moinho.
- Partículas, câmera com impacto, mira responsiva e áudio sintetizado.

## Controles

| Ação | Controle |
| --- | --- |
| Mover | WASD ou setas; joystick esquerdo no toque |
| Mirar | Mouse; arraste no lado direito no toque |
| Atacar | Espaço, E, botão esquerdo ou ATACAR no toque |
| Armas | 1, 2 e 3 |
| Construir | Z (cerca), X (arame), C (moinho) |
| Loja e equipamentos | B ou botão da loja |
| Curar | Q; consome 10 comidas e recupera 35 de vida |
| Pausar localmente | Esc; a sala multiplayer continua ativa |
| Silenciar | M ou botão de áudio |
| Respawn | Espaço ou botão na tela de morte |

## Executar

Requer Node.js 20 ou superior.

```bash
npm install
npm run dev
```

Abra `http://localhost:3000`. Para produção:

```bash
npm run build
npm start
```

O processo Hono serve o cliente e aceita o WebSocket em `/api/game/ws`; não é necessário um segundo serviço. O MVP usa sessões de convidados em memória e não grava contas ou ranking global no MySQL.

## Verificação

```bash
npm run check
npm run test
npm run build
```

Com o servidor de produção em execução:

```bash
npm run verify:multiplayer
npm run verify:protocol
```

O primeiro roteiro abre dois clientes reais e cobre loja, bloqueio inicial de armas, movimento, coleta, ranking compartilhado, pausa, PvP, morte e respawn. O segundo testa pacotes inválidos, flood e payload excessivo somente contra a infraestrutura local do Jagunco.

## Arquitetura

- **Cliente:** TypeScript, Vite, PixiJS 8/WebGL 2 e React somente para o shell/HUD.
- **Rede:** WebSocket binário, MessagePack e protocolo versionado.
- **Servidor:** Node.js, Hono e simulação autoritativa com timestep fixo de 30 Hz.
- **Sincronização:** snapshots a 15 Hz, predição do jogador local, reconciliação por ACK e interpolação temporal de posição e ângulo das entidades remotas.
- **Desempenho:** spatial hash para AOI e colisões, envio de objetos estáticos por mudança, limites de catch-up e limite de payload.
- **Determinismo:** geração de mundo e IA usam PRNG com seed; o estado da partida não depende de `Math.random()`.

O servidor valida movimento, alcance, cooldown, dano, recompensas, custos, limites de construção, escolhas de nível, preços, propriedade, equipamento, bônus, cura e respawn. Limites de taxa e de protocolo reduzem abuso, mas não tornam toda trapaça impossível.

## Escopo atual

Este é um vertical slice completo com uma base visual própria em evolução, não o jogo final. Contas, clãs, amigos, chat, chefes, ranking global, persistência de personagens entre sessões e WebTransport ficam para etapas posteriores. Itens e desbloqueios sobrevivem ao respawn, mas a sala em memória é reiniciada com o processo.

## Licença e referências

Código e arte deste projeto estão sob WTFPL; veja `LICENSE`. As fontes locais têm licenças próprias registradas em `CREDITS.md` e `public/fonts/OFL.txt`.

Os repositórios `MooMooForge/moomoo-in-depth`, `al007ex/moomoo-clone` e o pacote `game-elements` foram usados como referência de estudo, padrões de implementação e elementos visuais CC0. Os sprites de cabra e porco-do-mato foram adaptados do pacote CC0; personagens, armas, recursos, construções e terreno foram desenhados para o Jagunco. Jagunco.io não se conecta aos servidores oficiais do Moomoo.
