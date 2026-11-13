# Componentes e avisos de distribuição

A licença da raiz não substitui as licenças dos componentes. Os avisos e
autores existentes são preservados em CREDITS.md e nos arquivos abaixo.

| Componente | Versão / fonte | Aviso |
| --- | --- | --- |
| Código e adaptações do projeto | Revisão Git da release | LICENSE |
| Clone fornecido e referências | MOOMOO_CLONE_LICENSE.md e CREDITS.md | CC0 documentado para o clone; preservar a distinção dos materiais originais descrita nos créditos |
| Cliente vendorizado | 1.9.4 em client-official/source | CREDITS.md e cabeçalhos existentes |
| Howler.js vendorizado | 2.0.4, conforme cabeçalho do arquivo | legal/Howler-MIT.txt; upstream goldfire/howler.js, tag v2.0.4 |
| nipplejs | 1.0.4 na lockfile, módulo touch compilado | legal/nipplejs-MIT.txt; upstream yoannmoinet/nipplejs, tag v1.0.4 |
| Rye, Barlow Condensed e Inter | Fontes locais | CREDITS.md e public/fonts/OFL.txt |
| Hammersmith One | Fonte local do cliente | CREDITS.md e public/fonts/OFL.txt |
| Material Icons | Fonte local do cliente | public/fonts/Apache-2.0.txt |
| Bibliotecas npm de runtime | package-lock.json | Avisos mantidos nas respectivas pastas node_modules |

O build inclui estes avisos em dist/legal e replica o conjunto no pacote
de assets da central, com hashes no renderer-manifest.json. A imagem
de runtime mantém também os avisos distribuídos com o Node, sistema base
e dependências npm.

npm audit analisa a árvore npm conhecida. Ele não demonstra segurança do
Node, do sistema base ou de todo bundle vendorizado. A revisão desses
componentes deve considerar versões e arquivos efetivamente distribuídos.
