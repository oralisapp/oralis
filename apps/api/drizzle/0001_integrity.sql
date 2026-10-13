-- Restrições de integridade que não são expressas pelo esquema Drizzle.

CREATE EXTENSION IF NOT EXISTS btree_gist;
--> statement-breakpoint
CREATE EXTENSION IF NOT EXISTS pg_trgm;
--> statement-breakpoint

-- AGENDA: dois agendamentos ativos não podem ocupar o mesmo profissional,
-- a mesma cadeira ou o mesmo paciente em intervalos sobrepostos.
-- O intervalo é semiaberto [início, fim): 09:00–10:00 e 10:00–11:00 não conflitam.
-- Por ser uma restrição do banco, vale também para requisições simultâneas.
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_no_professional_overlap"
  EXCLUDE USING gist (
    "organization_id" WITH =,
    "professional_id" WITH =,
    tstzrange("starts_at", "ends_at", '[)') WITH &&
  ) WHERE ("status" IN ('scheduled', 'confirmed', 'arrived', 'in_progress', 'completed'));
--> statement-breakpoint
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_no_chair_overlap"
  EXCLUDE USING gist (
    "organization_id" WITH =,
    "chair_id" WITH =,
    tstzrange("starts_at", "ends_at", '[)') WITH &&
  ) WHERE ("chair_id" IS NOT NULL AND "status" IN ('scheduled', 'confirmed', 'arrived', 'in_progress', 'completed'));
--> statement-breakpoint
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_no_patient_overlap"
  EXCLUDE USING gist (
    "organization_id" WITH =,
    "patient_id" WITH =,
    tstzrange("starts_at", "ends_at", '[)') WITH &&
  ) WHERE ("status" IN ('scheduled', 'confirmed', 'arrived', 'in_progress', 'completed'));
--> statement-breakpoint

-- Busca de pacientes por trecho do nome (já normalizado sem acentos).
CREATE INDEX "patients_search_name_trgm_idx" ON "patients" USING gin ("search_name" gin_trgm_ops);
--> statement-breakpoint

-- Tabelas somente-inserção: auditoria e histórico de status.
CREATE OR REPLACE FUNCTION oralis_forbid_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'Tabela % é somente-inserção: registros não podem ser alterados nem excluídos.', TG_TABLE_NAME
    USING ERRCODE = 'insufficient_privilege';
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER audit_events_append_only
  BEFORE UPDATE OR DELETE ON "audit_events"
  FOR EACH ROW EXECUTE FUNCTION oralis_forbid_mutation();
--> statement-breakpoint
CREATE TRIGGER appointment_status_history_append_only
  BEFORE UPDATE OR DELETE ON "appointment_status_history"
  FOR EACH ROW EXECUTE FUNCTION oralis_forbid_mutation();
