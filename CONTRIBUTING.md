# Contribuindo

Use commits pequenos e coerentes, com testes proporcionais à alteração.
Preserve licenças, dados de jogadores e os controles do servidor.

## Mensagens de commit

Todos os commits novos seguem Conventional Commits 1.0.0:

    tipo(escopo): descrição

    Explique o comportamento alterado e a razão da mudança.

    Validação: descreva os testes e o resultado observado.

O título tem no máximo 50 caracteres Unicode, contando tipo, escopo e
espaços. Esse limite e a obrigatoriedade do corpo são regras deste
repositório. Use português, uma ação clara e nenhum ponto final no título.
O escopo é opcional; quando usado, identifique a área afetada. Quebre o
corpo em aproximadamente 72 colunas, preservando URLs e comandos legíveis.

| Tipo | Uso |
| --- | --- |
| feat | Nova capacidade |
| fix | Correção de comportamento |
| docs | Documentação |
| test | Testes e verificações |
| refactor | Organização sem mudança de comportamento |
| perf | Desempenho |
| build | Build e dependências |
| ci | Integração contínua |
| chore | Manutenção |
| revert | Reversão |

Exemplo:

    feat(world): adiciona caverna com guardiões

    Agrupa MOOSTAFA, MOOFIE e Treasure em uma caverna com paredes
    sólidas e entrada ao sul. Os guardiões oferecem proteção física.

    Validação: testes de colisão, combate, respawn e reconexão;
    navegação real em Chromium, Firefox e dispositivos touch.

Use ! no título e BREAKING CHANGE: no rodapé para mudanças incompatíveis.
O título e o corpo de um commit de merge seguem as mesmas regras.
Não reescreva commits públicos antigos apenas para mudar sua formatação.

Antes de publicar, valide o intervalo exato da alteração:

    npm run check:commits -- --from <sha-base> --to HEAD
    npm test
    npm run build
    npm run verify

A integração contínua verifica os commits recebidos e executa testes,
build e verificações nos runtimes suportados. Mudanças de interface também
exigem validação no navegador e, quando aplicável, entrada touch real.

A especificação está em https://www.conventionalcommits.org/en/v1.0.0/.
