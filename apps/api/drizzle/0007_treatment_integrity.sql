-- ORÇAMENTO: versão apresentada e decisões são imutáveis.
CREATE TRIGGER quote_versions_append_only
  BEFORE UPDATE OR DELETE ON "quote_versions"
  FOR EACH ROW EXECUTE FUNCTION oralis_forbid_mutation();
--> statement-breakpoint
CREATE TRIGGER quote_decisions_append_only
  BEFORE UPDATE OR DELETE ON "quote_decisions"
  FOR EACH ROW EXECUTE FUNCTION oralis_forbid_mutation();
--> statement-breakpoint

-- ODONTOGRAMA: histórico temporal. Um registro só pode ser marcado como
-- substituído (uma vez); conteúdo e exclusão são proibidos.
CREATE OR REPLACE FUNCTION oralis_odontogram_history() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Registros do odontograma não podem ser apagados.' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD.superseded_at IS NOT NULL
     OR NEW.tooth IS DISTINCT FROM OLD.tooth OR NEW.surfaces IS DISTINCT FROM OLD.surfaces
     OR NEW.condition IS DISTINCT FROM OLD.condition OR NEW.status IS DISTINCT FROM OLD.status
     OR NEW.notes IS DISTINCT FROM OLD.notes OR NEW.recorded_by IS DISTINCT FROM OLD.recorded_by
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'Registro do odontograma é histórico: registre um novo em vez de alterar.' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER odontogram_entries_history
  BEFORE UPDATE OR DELETE ON "odontogram_entries"
  FOR EACH ROW EXECUTE FUNCTION oralis_odontogram_history();
