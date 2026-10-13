# Matriz de permissões (incremento 1)

Fonte de verdade: `packages/shared/src/permissions.ts`. Os papéis são gravados
por organização (`roles`/`role_permissions`) para permitir personalização futura.
A mesma matriz aparece na tela **Equipe**.

Legenda: ✔ concedido · — não concedido · (próprio) somente consultas do profissional vinculado ao usuário.

| Permissão | Proprietário | Gestor | Dentista | Recepção | Auxiliar | Financeiro |
|---|:-:|:-:|:-:|:-:|:-:|:-:|
| `org.manage` — dados da organização | ✔ | — | — | — | — | — |
| `units.manage` — unidades e horários | ✔ | ✔ | — | — | — | — |
| `team.read` — ver equipe | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ |
| `team.manage` — convidar, alterar papéis | ✔ | ✔¹ | — | — | — | — |
| `professionals.manage` | ✔ | ✔ | — | — | — | — |
| `resources.manage` — cadeiras/salas | ✔ | ✔ | — | — | — | — |
| `services.manage` | ✔ | ✔ | — | — | — | — |
| `patients.read` — cadastro operacional | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ |
| `patients.write` | ✔ | ✔ | ✔ | ✔ | — | — |
| `schedule.read` | ✔ | ✔ | ✔ | ✔ | ✔ | — |
| `schedule.write` — agendar/reagendar | ✔ | ✔ | ✔ | ✔ | — | — |
| `schedule.confirm` | ✔ | ✔ | ✔ | ✔ | — | — |
| `schedule.checkin` | ✔ | ✔ | — | ✔ | ✔ | — |
| `schedule.cancel` — cancelar/registrar falta | ✔ | ✔ | — | ✔ | — | — |
| `schedule.attend` — iniciar/concluir | ✔ | — | ✔ (próprio) | — | — | — |
| `schedule.attend_any` | ✔ | — | — | — | — | — |
| `clinical.read` / `clinical.write` (incremento 2) | ✔ | — | ✔ | — | — | — |
| `audit.read` | ✔ | ✔ | — | — | — | — |

¹ Gestor não concede o papel de Proprietário e não concede acesso a unidades fora do próprio escopo.

## Regras adicionais aplicadas no backend

- **Escopo por unidade**: membro restrito a unidades não vê nem altera agenda, cadeiras ou unidades fora do escopo (responde 404).
- **Organização**: sem vínculo ativo → 404 em qualquer rota da organização.
- **Proprietário**: só outro proprietário altera/remove um proprietário; a organização mantém ao menos um proprietário ativo.
- **Mudança de papel/remoção**: vale na requisição seguinte (permissões não ficam em cache na sessão).
- **Convite**: só pode ser aceito pela conta com o e-mail convidado, uma única vez, em até 7 dias.
- **Administrador do SaaS**: não existe neste incremento e **não terá** bypass do `TenantGuard`.

Observação clínica pendente de validação: o gestor não recebe `clinical.read`
por padrão. Clínicas em que o gestor é também responsável técnico deverão
receber um papel personalizado (incremento futuro), não uma exceção silenciosa.
