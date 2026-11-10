# Instalação e operação em contêineres

O jogo usa Node 26.13.0, MySQL 8.4.13 e Caddy 2.11.9. As bases de produção
estão fixadas por digest. Node 24.22.2 é o runtime de compatibilidade.
Builds e exportação de sprites devem acontecer na estação de trabalho ou
no CI; a EC2 recebe imagens prontas.

## Preparar o host

Ubuntu 24.04, Python 3, Docker Engine 29 e Docker Compose são os alvos.
O modelo usa recursos disponíveis no Compose 2.24.4 ou posterior; Compose
5.7.0 foi exercitado na estação de QA. `scripts/bootstrap-host.sh` instala
pelo repositório oficial em um host novo. Se Docker e Compose já existem,
o script verifica as versões e não reinstala o daemon.

A instalação por APT em uma VM vazia precisa de homologação própria.
Não execute o bootstrap para atualizar indiscriminadamente um host saudável.
A participação no grupo docker equivale a acesso administrativo ao host.

## Construir e transportar

```sh
docker build -t jagunco-game:<revisao> .
docker save jagunco-game:<revisao> | gzip > jagunco-game.tar.gz
```

Transfira a imagem por SSH, confira o SHA-256 do arquivo e carregue com
`gunzip -c jagunco-game.tar.gz | docker load`. Registre a revisão Git, a
árvore, o digest da base e o ID efetivo da imagem no manifesto da entrega.
A imagem final não contém o navegador nem ferramentas do build.

## Instalação nova

```sh
sudo scripts/install.sh --directory /opt/jagunco \
  --image jagunco-game:<revisao> --control \
  --domain jogo.exemplo.com --owner-email dono@exemplo.com
```

O instalador gera segredos em `.secrets/`, cria volumes e redes com nomes
estáveis, provisiona usuários SQL distintos, prepara permissões e executa
o migrador antes do app. O runtime recebe DML; o migrador recebe DDL apenas
no esquema do jogo. A raiz do app fica somente leitura, com UID 1000,
limites de memória/PIDs/CPU e rotação de logs.

Repita o mesmo comando para retomar uma instalação incompleta. Os segredos,
contas, certificados e identidades dos volumes são preservados. Mudar a
imagem de uma instalação existente usa `ops.sh deploy`, explicitamente.
Não edite arquivos reais de ambiente para copiar senhas em linha de comando.

Para desenvolvimento, acrescente `--development --port 3300`. Essa variante
publica o app apenas em loopback e mantém os controles de contêiner de
produção. O proxy público fica desligado.

## Adotar a EC2 existente

Use `--adopt --project jagunco` no diretório `/opt/jagunco`. O instalador
inspeciona os serviços existentes e os destinos exatos dos volumes. Ele
preserva APP_SECRET, credenciais MySQL e certificados, copia a configuração
anterior para `.ops/` e mantém o Caddyfile existente, incluindo o redirecionamento
do IP. O serviço público continua sendo o projeto `jagunco`.

O conector opcional usa volume próprio e segredo independente. A central
não recebe `game-data`, admin.token, credenciais do jogo ou socket Docker.
Não há porta TCP para o conector nem rota equivalente no HTTP público.

## Operar

```sh
sudo /opt/jagunco/scripts/ops.sh status
sudo /opt/jagunco/scripts/ops.sh migrate
sudo /opt/jagunco/scripts/ops.sh deploy --image jagunco-game:<nova-revisao>
sudo /opt/jagunco/scripts/ops.sh rollback
```

`/health` indica processo vivo; `/ready` também verifica MySQL e bloqueio
de reconciliação. Compose não reinicia automaticamente um contêiner apenas
porque ele ficou unhealthy. Alertas e diagnóstico devem considerar essa
separação. O mundo em RAM é recriado ao reiniciar o jogo.

Rollback troca a imagem, preserva dados e exige schema compatível. O CI
exercita retorno de Node 24 para 26 com o mesmo contrato. Imagens anteriores
à migração de segredos e diretórios, inclusive a antiga imagem Node 20,
precisam de procedimento próprio; não são um rollback automático homologado.

## Backup e restauração

```sh
sudo /opt/jagunco/scripts/ops.sh backup --control-dir /opt/jagunco-control
sudo /opt/jagunco/scripts/ops.sh restore \
  --file /opt/jagunco/backups/<data>/database.sql \
  --control-dir /opt/jagunco-control
```

O backup pausa a central, usa `mysqldump --single-transaction` nos dois
esquemas, arquiva game-data e volumes do Caddy e gera hashes. O arquivo de
recuperação contém segredos e deve continuar com acesso restrito. Não
publique dumps nem esse arquivo em releases, logs ou artefatos do CI.

A restauração para o host existente verifica o SQL, para as aplicações,
restaura o banco e só então hidrata os processos. Em recuperação de host
inteiro, valide todos os hashes, recupere as configurações e segredos em
um diretório protegido e restaure os volumes arquivados antes de subir
os serviços. Não extraia um arquivo desconhecido como root.

Backup local não cobre perda da EC2. Configure um destino externo protegido
e uma política de retenção antes de aceitar contas reais. RPO/RTO e restauração
em uma segunda EC2 continuam dependendo desse destino e do ensaio de desastre.
