# Control Finance

Controle financeiro pessoal simples, sem categorias obrigatórias. Cada pessoa cria a própria conta e vê somente os próprios dados.

## O que faz

- Cadastro e login por usuário + senha.
- Sessão por cookie seguro com duração de 30 dias.
- Dados separados por conta no PostgreSQL.
- Ganhos e gastos livres, separados por mês.
- Edição e exclusão a qualquer momento.
- Subgastos dentro de um gasto: Santander R$ 300 + Spotify R$ 20 = Santander R$ 320.
- Dia e observação opcionais.
- Migração opcional dos dados salvos pela versão antiga em localStorage.

## Deploy

O arquivo `render.yaml` liga o Web Service ao PostgreSQL `controlfinance-db` e gera `SESSION_SECRET` automaticamente.

Para desenvolvimento local:

```env
DATABASE_URL=postgres://usuario:senha@localhost:5432/controlfinance
SESSION_SECRET=uma-chave-grande
PORT=3000
```

Depois rode `npm install` e `npm run dev`.
