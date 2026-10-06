# Control Finance

App pessoal e simples para substituir as anotações mensais de finanças: você cadastra **ganhos** e **gastos** sem categorias obrigatórias, navega por mês e vê o saldo `ganhos - gastos`.

A regra especial são os **subgastos**. Um gasto possui um valor-base e pode receber subgastos que entram automaticamente no total. Exemplo: `Santander = R$ 300` + `Spotify = R$ 20` → total do Santander `R$ 320`.

## Funcionalidades

- Ganhos e gastos livres, sem classes de cartão/conta/categoria.
- Separação por mês.
- Dia do mês opcional em qualquer lançamento.
- Edição e exclusão a qualquer momento.
- Subgastos dentro de um gasto, com soma automática.
- Resumo mensal de ganhos, gastos e saldo.
- Interface mobile-first inspirada no visual escuro das anotações usadas como referência.
- Proteção por uma senha única (`APP_PASSWORD`).
- PostgreSQL para manter os dados entre deploys.

## Rodar localmente

```bash
npm install
```

Crie um `.env`:

```env
DATABASE_URL=postgres://usuario:senha@localhost:5432/controlfinance
APP_PASSWORD=sua-senha
SESSION_SECRET=uma-chave-grande-e-aleatoria
PORT=3000
```

Depois:

```bash
npm run dev
```

## Deploy no Render

O repositório inclui `render.yaml` para o Web Service Node.

No workspace usado neste projeto, o PostgreSQL `controlfinance-db` já foi criado. Para concluir pelo Blueprint do Render, informe:

- `DATABASE_URL`: o **Internal Database URL** do `controlfinance-db`.
- `APP_PASSWORD`: a senha que você quer usar para entrar no app.
- `SESSION_SECRET`: é gerado automaticamente pelo Blueprint.

O servidor cria as tabelas automaticamente no primeiro start.

> Observação: o banco atualmente está no plano gratuito do Render e, por isso, possui expiração própria do plano. Para uso permanente, mude o banco para um plano persistente antes da expiração.
