# Runtime do servidor

A imagem de produção usa Node 26.13.0 LTS, fixado pelo digest da imagem
oficial Debian Bookworm. O arquivo .node-version identifica o patch de
desenvolvimento. Node 24 continua na matriz de compatibilidade.

A troca de runtime mantém cliente, lockfile de dependências, regras e
schema do jogo. Não requer flags experimentais de memória. O perfil
completo de cada release deve ser medido com seus limites de contêiner.

Uma atualização do Node é uma entrega própria: conferir aviso oficial,
atualizar versão/digest, executar testes, build, MySQL e cliente real,
registrar a imagem e implantar somente o artefato verificado.

O aviso de segurança de 03/11/2026 prevê novos patches em 11/11 ou depois.
Reavaliar o patch disponível antes da ativação de cada release.

Referência: https://nodejs.org/en/blog/vulnerability/november-2026-security-releases
