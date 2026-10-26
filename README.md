# Atlas API

Backend do Atlas preparado para ser separado do serviço do ControlFinance.

## Estado desta cópia

Esta branch foi criada a partir de `feature/accounts` do repositório `controlfinance`, que contém o backend integrado atualmente usado pelo Atlas.

Para evitar qualquer risco na migração, o código do ControlFinance foi mantido nesta cópia. Nenhum arquivo foi removido do repositório original. Depois que o novo serviço `atlas-api` estiver validado no Render, o backend pode ser refatorado para conter somente as rotas do Atlas.

## Atlas

- API base: `/atlas-api`
- Health check: `/atlas-api/health`
- PostgreSQL: reutilize a mesma `DATABASE_URL` atual durante a migração para manter os dados e tabelas `atlas_*`.
- Node.js: 20+

## Variáveis de ambiente

```env
DATABASE_URL=postgres://...
SESSION_SECRET=uma-chave-grande
ATLAS_DEMO_PASSWORD=senha-opcional-da-demo
PORT=3000
NODE_ENV=production
```

## Render

Ao criar o novo Web Service, aponte para o futuro repositório `atlas-api`, use `npm install` no build e `npm start` no start. Configure o health check como `/atlas-api/health`.

Durante a migração, não desligue nem altere o serviço atual do ControlFinance até confirmar que o frontend do Atlas está respondendo pelo novo endpoint.
