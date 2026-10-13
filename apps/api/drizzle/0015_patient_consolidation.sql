CREATE TABLE patient_import_batches (
  organization_id uuid NOT NULL REFERENCES organizations(id),
  input_hash text NOT NULL,
  actor_user_id uuid NOT NULL REFERENCES users(id),
  result jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, input_hash)
);
--> statement-breakpoint
CREATE TABLE patient_merges (
  source_id uuid PRIMARY KEY,
  target_id uuid NOT NULL,
  organization_id uuid NOT NULL,
  actor_user_id uuid NOT NULL REFERENCES users(id),
  reason text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (source_id, organization_id) REFERENCES patients(id, organization_id),
  FOREIGN KEY (target_id, organization_id) REFERENCES patients(id, organization_id),
  CHECK (source_id <> target_id)
);
--> statement-breakpoint
CREATE INDEX patient_merges_target_idx ON patient_merges(target_id, organization_id);
--> statement-breakpoint
CREATE TRIGGER patient_merges_append_only BEFORE UPDATE OR DELETE ON patient_merges
FOR EACH ROW EXECUTE FUNCTION oralis_forbid_mutation();
--> statement-breakpoint
-- Existing historical records keep their original patient identity. New records
-- must use the canonical registration; a row lock serializes with consolidation.
CREATE FUNCTION oralis_patient_registration_active() RETURNS trigger AS $$
BEGIN
  IF NEW.patient_id IS NULL THEN RETURN NEW; END IF;
  PERFORM id FROM patients WHERE id = NEW.patient_id FOR KEY SHARE;
  IF EXISTS (SELECT 1 FROM patient_merges WHERE source_id = NEW.patient_id) THEN
    RAISE EXCEPTION 'Cadastro consolidado: utilize o paciente principal.' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
DO $$ DECLARE item record; BEGIN
  FOR item IN SELECT table_name FROM information_schema.columns
    WHERE table_schema = 'public' AND column_name = 'patient_id'
      AND table_name IN ('appointments', 'encounters', 'clinical_records', 'treatment_plans', 'odontogram_entries', 'laboratory_orders', 'waitlist_entries')
  LOOP
    EXECUTE format('CREATE TRIGGER patient_registration_active BEFORE INSERT OR UPDATE OF patient_id ON %I FOR EACH ROW EXECUTE FUNCTION oralis_patient_registration_active()', item.table_name);
  END LOOP;
END $$;
