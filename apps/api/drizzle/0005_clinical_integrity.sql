-- PRONTUÁRIO: registro finalizado não pode ser editado nem apagado, mesmo
-- por acesso direto ao banco pela aplicação. Correções entram como adendo.
CREATE OR REPLACE FUNCTION oralis_protect_finalized_record() RETURNS trigger AS $$
BEGIN
  IF OLD.status = 'finalized' THEN
    RAISE EXCEPTION 'Registro clínico finalizado não pode ser alterado; registre um adendo.'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER clinical_records_protect_finalized
  BEFORE UPDATE OR DELETE ON "clinical_records"
  FOR EACH ROW EXECUTE FUNCTION oralis_protect_finalized_record();
--> statement-breakpoint
CREATE TRIGGER clinical_record_amendments_append_only
  BEFORE UPDATE OR DELETE ON "clinical_record_amendments"
  FOR EACH ROW EXECUTE FUNCTION oralis_forbid_mutation();
--> statement-breakpoint
CREATE TRIGGER anamnesis_responses_append_only
  BEFORE UPDATE OR DELETE ON "anamnesis_responses"
  FOR EACH ROW EXECUTE FUNCTION oralis_forbid_mutation();
--> statement-breakpoint
CREATE TRIGGER document_versions_append_only
  BEFORE UPDATE OR DELETE ON "document_versions"
  FOR EACH ROW EXECUTE FUNCTION oralis_forbid_mutation();
