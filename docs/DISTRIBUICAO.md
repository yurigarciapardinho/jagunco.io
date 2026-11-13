# Imagens e releases

A imagem do jogo é `ghcr.io/yurigarciapardinho/jagunco-game` para
Linux amd64. A central e a prévia pertencem ao repositório privado.
Cada candidata possui `game-manifest.json`, com revisão, árvore Git,
digest OCI, plataforma e execução que a construiu. Use o campo `image`
desse manifesto, com `@sha256:...`, para instalar ou voltar de versão.

## Publicar

Depois do `gate` verde na revisão de `main`, execute **Publicar candidata**
em Actions. O número da candidata é obrigatório; uma tag já existente
não é sobrescrita. A publicação constrói a imagem, inclui SBOM e
proveniência BuildKit, atesta o digest com a identidade do workflow,
baixa a imagem, verifica a assinatura e cria a prerelease com SHA256SUMS.

Na primeira publicação, confira a visibilidade do pacote no GitHub.
O pacote público precisa estar como **Public** para download anônimo.
A visibilidade do repositório, isoladamente, não substitui essa etapa.

## Instalar por digest

Baixe `game-manifest.json` da release escolhida e confira SHA256SUMS.
No checkout da revisão indicada no manifesto:

```bash
GAME_IMAGE="$(python3 -c 'import json; print(json.load(open("game-manifest.json"))["image"])')"
docker pull "$GAME_IMAGE"
scripts/install.sh --directory "$PWD/.local-game" --image "$GAME_IMAGE" --development
```

Para produção, use as instruções de `docs/operations/README.md` e
informe seu hostname no instalador. A configuração local não exige
domínio próprio. Instalar o jogo não exige instalar a central.

Verifique a origem pública autenticado no registry:

```bash
gh attestation verify "oci://$GAME_IMAGE" \
  --repo yurigarciapardinho/jagunco.io \
  --signer-workflow yurigarciapardinho/jagunco.io/.github/workflows/release.yml
```

O SBOM registra os componentes; a proveniência BuildKit descreve o build.
A atestação do GitHub vincula o digest à identidade do workflow. Estes
arquivos têm propósitos diferentes e são verificados separadamente.

## Atualizar e recuperar

Faça backup antes da troca. `scripts/ops.sh deploy --image <digest>`
registra o ID imutável anterior; `rollback` recupera essa imagem, mesmo
que uma tag tenha mudado. Rollback de imagem não restaura dados nem
reverte automaticamente migrações de banco. Consulte os procedimentos
de backup/restauração antes de usar uma revisão com schema diferente.

A criação de release não executa deploy em produção.
