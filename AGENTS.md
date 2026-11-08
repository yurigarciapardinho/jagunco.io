# Jagunco.io

## Commits e publicação

Esta convenção vale para todas as alterações do projeto, incluindo código,
documentação, testes, automações e commits de integração.

- Use Conventional Commits: tipo(escopo): descrição.
- Limite o título a 50 caracteres Unicode; esse limite é uma regra do projeto.
- Escreva títulos claros em português, com uma ação e sem ponto final.
- Separe o título do corpo por uma linha vazia.
- No corpo, explique a mudança, sua finalidade e a validação executada.
  Quebre as linhas em aproximadamente 72 colunas quando possível.
- Use feat, fix, docs, test, refactor, perf, build, ci, chore ou revert.
- Identifique mudanças incompatíveis com ! e um rodapé BREAKING CHANGE.
- Divida mudanças independentes em commits coerentes. Não reescreva o
  histórico público para aplicar esta regra retroativamente.
- Execute npm run check:commits -- --from <base> antes de publicar.
- Aplique a mesma convenção ao título e ao corpo de commits de merge.

Consulte CONTRIBUTING.md para exemplos e verificações.

## Invariantes de engenharia

Preserve a autoridade do servidor, autenticação, tickets, assinaturas,
seal, limites de mensagens e anticheat. Use contas sintéticas e instâncias
isoladas nas verificações. Não publique segredos, dados de jogadores ou
arquivos de evidência com credenciais.

Preserve os avisos de licença e atribuição existentes. Altere o cliente
gerado pelos patches do construtor, com contagem explícita dos anchors.
Valide o runtime de produção em Node 20 e a compatibilidade em Node 24.
Uma publicação no GitHub não autoriza, por si só, um deploy em produção.
