# Cursos em Video

## Estado atual

- O site publico do professor exibe a secao "Cursos em video" abaixo das turmas.
- O painel do professor possui o menu "Cursos em video".
- O professor pode cadastrar, editar, publicar, ocultar e excluir cards de cursos.
- Cada curso aceita titulo, resumo, descricao, capa, preco, horas, quantidade de aulas e UID do Cloudflare Stream.
- Os dados desta primeira fase ficam no CMS do site, junto das demais configuracoes do professor.
- Cada card publico aponta para uma pagina propria do curso em `/redacao/:slug/videos/:courseId`.
- O painel do aluno possui o menu "Cursos em video".
- A area do aluno lista cursos publicados, mostra progresso e bloqueia o player quando nao ha matricula ativa.
- A migration `010_video_courses.sql` cria matriculas, progresso e anotacoes de aulas.
- A migration `011_video_course_payments.sql` adiciona `product_type` e `course_id` em `payments`.
- Progresso e anotacoes possuem fallback controlado quando a migration ainda nao foi aplicada no banco remoto.
- A pagina publica do curso possui checkout proprio para curso em video, usando o preco salvo no CMS do professor.
- O pagamento de curso em video cria `payments.product_type = VIDEO_COURSE` e nao mistura `turma_id`.
- O webhook do Asaas libera `video_course_enrollments` apenas para pagamentos confirmados/recebidos.
- O link de cadastro enviado por e-mail ou exibido no checkout inclui `product=video`, `course`, `checkout_code`, e-mail, nome e CPF.

## Cloudflare Stream

O Stream deve ser ativado com videos privados e URLs assinadas.

Variaveis planejadas:

- `ENABLE_VIDEO_COURSES`
- `ENABLE_CLOUDFLARE_STREAM`
- `CLOUDFLARE_ACCOUNT_ID`
- `CLOUDFLARE_STREAM_TOKEN`
- `CLOUDFLARE_STREAM_CUSTOMER_CODE`
- `CLOUDFLARE_STREAM_SIGNING_KEY_ID`
- `CLOUDFLARE_STREAM_SIGNING_KEY_JWK`
- `CLOUDFLARE_STREAM_TOKEN_TTL_SECONDS`

Implementacao atual:

- Com `ENABLE_CLOUDFLARE_STREAM=false`, o painel nao carrega video.
- Com `ENABLE_CLOUDFLARE_STREAM=true`, `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_STREAM_TOKEN` e `CLOUDFLARE_STREAM_CUSTOMER_CODE`, o Worker pede um token temporario ao endpoint `/stream/:video_uid/token`.
- O token atual expira pelo valor de `CLOUDFLARE_STREAM_TOKEN_TTL_SECONDS`, limitado entre 60 e 3600 segundos.
- O token e enviado somente para aluno autenticado, vinculado ao mesmo site e com matricula ativa no curso.

## Politicas de protecao

- Videos devem exigir signed URLs.
- O UID do video nunca deve liberar acesso sozinho.
- O Worker deve validar usuario, site, curso e matricula antes de gerar token.
- Tokens devem expirar rapidamente, inicialmente em 15 minutos.
- Links diretos de download devem ficar desabilitados quando possivel.
- O player deve ser carregado apenas em paginas autenticadas.
- Progresso e anotacoes devem ser vinculados ao aluno e ao curso.
- O sistema deve registrar ultimo tempo assistido para retomar o video.
- O player publico nao exibe video; a aula so abre dentro do painel autenticado do aluno.
- Enquanto `ENABLE_CLOUDFLARE_STREAM=false`, o painel mostra uma mensagem controlada e nao tenta carregar video desprotegido.

## Limitacoes reais

Nao existe bloqueio 100% garantido contra gravacao de tela em navegadores comuns. As protecoes reduzem compartilhamento e acesso indevido, mas nao impedem captura externa.

## Proxima fase

1. Configurar Cloudflare Stream no painel, marcar videos como privados e salvar os secrets no Worker.
2. Migrar de token via API para signing key local quando houver alto volume de alunos.
3. Testar uma cobranca real de sandbox para curso em video, confirmando webhook, matricula e acesso no painel do aluno.
4. Exibir compras de cursos em video no financeiro do professor e no superadmin.
5. Criar upload/ingest de video para o professor, inicialmente via UID do Stream e depois por upload direto.
6. Avaliar PCI/seguranca antes de ativar cartao em producao dentro do site do professor.
