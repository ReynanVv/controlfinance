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

O repositório inclui `render.yaml` com um Web Service Node e um PostgreSQL. No Render, crie um Blueprint a partir do repositório e informe `APP_PASSWORD` quando solicitado. `SESSION_SECRET` é gerado automaticamente.

O servidor cria as tabelas automaticamente no primeiro start.
