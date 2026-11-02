# Jagunco.io

Survival multiplayer 2D top-down ambientado no sertão. Entre como convidado, colete recursos, evolua, construa defesas e dispute o ranking da sala contra outros jogadores e animais do mapa.

## Objetivo

Ganhe pontos coletando, caçando, construindo e vencendo confrontos. Madeira e pedra sustentam construções; comida cura; ouro aumenta sua presença na economia da partida. Ao morrer, você pode voltar à mesma sala com parte dos recursos preservada.

## Sistemas do MVP

- Sala pública real para até 40 jogadores, sem cadastro.
- Madeira, comida, pedra e ouro; recursos naturais renascem.
- Facão, lança e estilingue com alcance, dano, cooldown e desbloqueio próprios.
- XP, níveis e melhorias de dano, velocidade e coleta.
- Cercas, arame farpado e moinhos com custo, vida e limites por jogador.
- Cabras passivas e porcos-do-mato hostis.
- PvP, morte, respawn, cura e ranking da sala.
- Controles por teclado/mouse e joystick/botões de toque.
- Arte vetorial original, partículas, câmera com impacto e áudio sintetizado.

## Controles

| Ação | Controle |
| --- | --- |
| Mover | WASD ou setas; joystick esquerdo no toque |
| Mirar | Mouse; arraste no lado direito no toque |
| Atacar | Espaço, E, botão esquerdo ou ATACAR no toque |
| Armas | 1, 2 e 3 |
| Construir | Z (cerca), X (arame), C (moinho) |
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

O primeiro roteiro abre dois clientes reais e cobre movimento, coleta, ranking compartilhado, pausa, PvP, morte e respawn. O segundo testa pacotes inválidos, flood e payload excessivo somente contra a infraestrutura local do Jagunco.

## Arquitetura

- **Cliente:** TypeScript, Vite, PixiJS 8/WebGL 2 e React somente para o shell/HUD.
- **Rede:** WebSocket binário, MessagePack e protocolo versionado.
- **Servidor:** Node.js, Hono e simulação autoritativa com timestep fixo de 30 Hz.
- **Sincronização:** snapshots a 15 Hz, predição do jogador local, reconciliação por ACK e interpolação de entidades remotas.
- **Desempenho:** spatial hash para AOI e colisões, envio de objetos estáticos por mudança, limites de catch-up e limite de payload.
- **Determinismo:** geração de mundo e IA usam PRNG com seed; o estado da partida não depende de `Math.random()`.

O servidor valida movimento, alcance, cooldown, dano, recompensas, custos, limites de construção, upgrades, cura e respawn. Limites de taxa e de protocolo reduzem abuso, mas não tornam toda trapaça impossível.

## Escopo atual

Este é um vertical slice completo do MVP, não o jogo final. Contas, clãs, amigos, chat, loja, chefes, ranking global, persistência de personagens e WebTransport ficam para etapas posteriores.

## Licença e referências

Código e arte deste projeto estão sob WTFPL; veja `LICENSE`. As fontes locais têm licenças próprias registradas em `CREDITS.md` e `public/fonts/OFL.txt`.

Os repositórios `MooMooForge/moomoo-in-depth` e `al007ex/moomoo-clone` foram usados como referência de estudo e padrões de implementação. Jagunco.io não se conecta aos servidores oficiais do Moomoo e não utiliza seus sprites.
