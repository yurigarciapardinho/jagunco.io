# Contrato privado de administração

API v1 por HTTP sobre Unix socket. Toda requisição exige um bearer de serviço,
independente do JWT de jogadores. O socket usa modo 0660 no volume exclusivo,
com UID/GID 1000. A permissão do arquivo complementa a autenticação.

Leituras: status/capacidades, catálogo, jogadores, contas paginadas, mapa atual,
recibos, auditoria e telemetria paginada. Catálogo e renderer possuem hashes;
a central recusa comandos quando seus artefatos não correspondem ao jogo.

Comandos: cargo, moderação de conta, aparência, segmentação analítica, poder,
recurso, XP, teleporte, animal temporário, encerramento de sessão, publicação de
mapa/regras e agenda de eventos. Não há texto de console, shell, SQL livre,
Docker ou código executável fornecido pelo chamador.

O envelope contém apiVersion, operationId UUID v4, actor owner, reason,
expectedRevision, expiresAt, target e payload. Alterações de conta também
exigem o fingerprint recebido na leitura, detectando mudanças de perfil
ou moderação realizadas fora da central. Alvos transitórios incluem mundo,
instanceId, sessionId e lifeId. O prazo máximo de solicitação é dois minutos.

Um ID repetido com corpo diferente falha. Um ID repetido com o mesmo corpo
consulta o recibo; não paga outro recurso. A consulta antecede a validação
de prazo e vida, permitindo observar uma operação antiga sem reaplicá-la.

O comando `xp` recebe `{ "amount": 1250 }` e exige um inteiro entre 1 e
1.000.000. Usa o mesmo alvo de vida, motivo, revisão e recibo dos demais
efeitos transitórios. Divide o crédito entre os limiares nativos de idade,
mantendo o restante e os pontos de evolução, até a idade máxima. Não concede
recursos ou XP de arma. O resultado registra quantidade solicitada, aplicada
e progressão antes/depois. `status.capabilities` anuncia `xp`,
`status.limits.xpGrant` informa o limite e `players[].progression` apresenta
idade, XP, limiar e evoluções pendentes. Uma nova vida reinicia esse progresso.

Persistência de domínio e recibo compartilham transação. A fila de snapshots
é serializada com o comando; a projeção em RAM acontece antes de liberar a
fila. Se a confirmação do commit se perde e não pode ser consultada, os
snapshots ficam bloqueados até a reconciliação. O jogo continua simulando,
mas readiness fica degradada. Não há promessa de atomicidade RAM/disco.

Efeitos de vida registram intenção antes da aplicação. Uma queda entre
intenção e aplicação produz resultado incerto, que não é repetido na vida
seguinte. Recibos observados no processo ajudam a reconciliar uma resposta
perdida. No boot, intenções transitórias antigas não são reaplicadas.

Cargos são concedidos pela central; `/api/mod/role` recusa inclusive admins.
OWNER_EMAIL passa a ser bootstrap único registrado no banco. Despromover
a conta não é revertido pelo próximo boot. A identidade da central é outra
credencial, exclusiva do dono, e não depende desse cargo.

Mapa v1 mantém dimensões, biomas, rio, caverna e arena. Espécies são explícitas;
um cacto fora do deserto é inválido. Objetos, construções, encontros e entradas
de jogador usam IDs autorais, diferentes dos SIDs. A validação cobre IDs,
limites, sobreposição, espécies, rio, densidade e área da caverna. Guardiões e
Treasure são preservados pela engine. A entrada de jogador usa a mesma colisão
nativa e retorna ao spawn normal se uma construção posterior bloquear o ponto.

Publicação registra versão desejada; novo mundo ativa a versão. Regras
suportadas v1: multiplicadores de coleta do cenário e recompensas de animais,
ambos de 1 a 5. Eventos por mundo não se sobrepõem, duram até sete dias,
podem começar até trinta dias à frente e expiram no jogo sem depender da central.

Telemetria operacional é limitada, com fila e contadores de descarte. A central
consome por cursor e deduplica IDs. Ela não certifica entrega perfeita após
queda abrupta. Auditoria de comandos duráveis é separada dessa coleta.
