## Jagunco 1.1.1

- Provisionamento, backup e restauração usam conexão autenticada por TCP
  local, sem depender do caminho padrão do socket Unix do MySQL.
- A aceitação de instalação exercita um socket de servidor diferente do
  padrão e repete backup, restauração e preservação de identidades.
- Runtime principal Node 26.13.1; compatibilidade Node 24.22.3.

Esta é uma correção dos scripts de operação da versão 1.1.0. Os contratos
persistentes e o comportamento do jogo são preservados. Os manifestos,
SBOM e proveniência identificam a imagem exata publicada. A criação da
release não implanta mudanças em produção.
