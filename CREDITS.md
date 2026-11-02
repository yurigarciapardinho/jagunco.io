# Créditos

## Direção e pipeline visual

A direção visual de Jagunco.io — paleta sertaneja, couro, palha, ferrugem e caatinga — é própria. O atlas original e o terreno foram preservados. O cliente ativo usa 186 sprites produzidos por `tools/generate_jagunco_assets.py` a partir de silhuetas editáveis em `art/source/silhouettes/`, com recoloração HSV e composições novas para favicon e pódios. As cores de biomas e construções vêm de `art/source/palette.json` e são aplicadas por `tools/jagunco-renderer-patch.mjs` sem alterar geometria ou hitboxes.

As silhuetas de referência vêm dos pacotes `game-elements` e `moomoo-clone`, fornecidos pelo usuário com autorização de reutilização; os avisos de origem são preservados. Cabra (`sheep_1.png`) e porco-do-mato (`boar_1.png`) também foram adaptados desses materiais. A composição do pipeline, o manifest, as regras de recolor e os estilos de marca são arquivos editáveis do projeto.

## Fontes locais

- **Rye** — Copyright (c) 2010 Sorkin Type Co, Reserved Font Name “Rye”. SIL Open Font License 1.1.
- **Barlow Condensed** — Copyright 2017 The Barlow Project Authors. SIL Open Font License 1.1.
- **Inter** — Copyright 2016 The Inter Project Authors. SIL Open Font License 1.1.
- **Hammersmith One** — fonte da interface de referência, servida localmente. SIL Open Font License 1.1.
- **Material Icons** — Google, Apache License 2.0; texto em `public/fonts/Apache-2.0.txt`.

As fontes são servidas localmente; o jogo não depende do Google Fonts em runtime. Os textos das licenças estão em `public/fonts/`.

## Bibliotecas de cliente

- **nipplejs** — joysticks touch, licença MIT. É empacotado localmente como o módulo `index-d71d2980.js` esperado pelo cliente, sem CDN.
- **Howler.js** — áudio do cliente de referência, licença MIT.

## Referências de engenharia

- https://github.com/MooMooForge/moomoo-in-depth
- https://github.com/al007ex/moomoo-clone

Esses materiais foram estudados como referência de protocolos, sincronização, validação, pooling, IA e organização de gameplay.

## Clone MooMoo.io

Os diretórios `server/`, `shared/`, `client/` e `client-official/` contêm o clone fornecido pelo usuário, incluindo um servidor privado reconstruído e o cliente oficial 1.9.4 patchado (bundle e página salvos em `client-official/source`). A licença do clone está em `MOOMOO_CLONE_LICENSE.md`; MooMoo.io, seu cliente, arte e nomes pertencem aos seus autores originais. O servidor oficial privado não faz parte dos anexos e não há afirmação de equivalência interna com ele.

Durante a integração, `server/src/anticheat/config.js`, ausente na cópia recebida, foi reconstruído a partir dos pontos de uso e do comportamento documentado. Jagunco.io não é afiliado ao MooMoo.io ou à FRVR e não se conecta aos servidores oficiais.
