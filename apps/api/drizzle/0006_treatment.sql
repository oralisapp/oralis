CREATE TABLE "odontogram_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"patient_id" uuid NOT NULL,
	"tooth" smallint NOT NULL,
	"surfaces" text[] DEFAULT '{}'::text[] NOT NULL,
	"condition" text NOT NULL,
	"status" text NOT NULL,
	"notes" text,
	"recorded_by" uuid NOT NULL,
	"clinical_record_id" uuid,
	"treatment_item_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"superseded_at" timestamp with time zone,
	"superseded_by" uuid,
	CONSTRAINT "odontogram_tooth_ck" CHECK (("odontogram_entries"."tooth" between 11 and 18) or ("odontogram_entries"."tooth" between 21 and 28) or ("odontogram_entries"."tooth" between 31 and 38) or ("odontogram_entries"."tooth" between 41 and 48) or ("odontogram_entries"."tooth" between 51 and 55) or ("odontogram_entries"."tooth" between 61 and 65) or ("odontogram_entries"."tooth" between 71 and 75) or ("odontogram_entries"."tooth" between 81 and 85)),
	CONSTRAINT "odontogram_status_ck" CHECK ("odontogram_entries"."status" in ('existing', 'planned', 'done'))
);
--> statement-breakpoint
CREATE TABLE "quote_decisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"quote_id" uuid NOT NULL,
	"version_id" uuid NOT NULL,
	"decision" text NOT NULL,
	"reason" text,
	"via" text NOT NULL,
	"decided_by" uuid,
	"acknowledged_name" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "quote_decisions_decision_ck" CHECK ("quote_decisions"."decision" in ('approved', 'rejected')),
	CONSTRAINT "quote_decisions_via_ck" CHECK ("quote_decisions"."via" in ('clinic', 'portal'))
);
--> statement-breakpoint
CREATE TABLE "quote_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"quote_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"items" jsonb NOT NULL,
	"subtotal" numeric(12, 2) NOT NULL,
	"discount" numeric(12, 2) DEFAULT '0' NOT NULL,
	"discount_reason" text,
	"total" numeric(12, 2) NOT NULL,
	"payment_terms" jsonb NOT NULL,
	"valid_until" date NOT NULL,
	"presented_by" uuid NOT NULL,
	"presented_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "quote_versions_quoteId_version_unique" UNIQUE("quote_id","version"),
	CONSTRAINT "quote_versions_id_org_uq" UNIQUE("id","organization_id"),
	CONSTRAINT "quote_versions_total_ck" CHECK ("quote_versions"."total" = "quote_versions"."subtotal" - "quote_versions"."discount" and "quote_versions"."discount" >= 0 and "quote_versions"."total" >= 0)
);
--> statement-breakpoint
CREATE TABLE "quotes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"plan_id" uuid NOT NULL,
	"patient_id" uuid NOT NULL,
	"status" text DEFAULT 'presented' NOT NULL,
	"current_version_id" uuid,
	"last_contact_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "quotes_id_org_uq" UNIQUE("id","organization_id"),
	CONSTRAINT "quotes_status_ck" CHECK ("quotes"."status" in ('presented', 'approved', 'rejected', 'expired'))
);
--> statement-breakpoint
CREATE TABLE "treatment_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"plan_id" uuid NOT NULL,
	"stage" smallint DEFAULT 1 NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"priority" text DEFAULT 'normal' NOT NULL,
	"description" text NOT NULL,
	"service_id" uuid,
	"tooth" smallint,
	"surfaces" text[] DEFAULT '{}'::text[] NOT NULL,
	"professional_id" uuid,
	"depends_on_item_id" uuid,
	"sessions_planned" smallint DEFAULT 1 NOT NULL,
	"unit_price" numeric(12, 2) DEFAULT '0' NOT NULL,
	"status" text DEFAULT 'planned' NOT NULL,
	"done_at" timestamp with time zone,
	"clinical_record_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "treatment_items_id_org_uq" UNIQUE("id","organization_id"),
	CONSTRAINT "treatment_items_status_ck" CHECK ("treatment_items"."status" in ('planned', 'scheduled', 'done', 'cancelled')),
	CONSTRAINT "treatment_items_priority_ck" CHECK ("treatment_items"."priority" in ('low', 'normal', 'high')),
	CONSTRAINT "treatment_items_price_ck" CHECK ("treatment_items"."unit_price" >= 0)
);
--> statement-breakpoint
CREATE TABLE "treatment_plans" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"patient_id" uuid NOT NULL,
	"unit_id" uuid NOT NULL,
	"title" text NOT NULL,
	"objective" text,
	"status" text DEFAULT 'draft' NOT NULL,
	"responsible_professional_id" uuid,
	"shared_with_patient" boolean DEFAULT false NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "treatment_plans_id_org_uq" UNIQUE("id","organization_id"),
	CONSTRAINT "treatment_plans_status_ck" CHECK ("treatment_plans"."status" in ('draft', 'presented', 'approved', 'rejected', 'in_progress', 'completed', 'cancelled'))
);
--> statement-breakpoint
ALTER TABLE "odontogram_entries" ADD CONSTRAINT "odontogram_entries_recorded_by_users_id_fk" FOREIGN KEY ("recorded_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "odontogram_entries" ADD CONSTRAINT "odontogram_entries_superseded_by_users_id_fk" FOREIGN KEY ("superseded_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "odontogram_entries" ADD CONSTRAINT "odontogram_entries_patient_id_organization_id_patients_id_organization_id_fk" FOREIGN KEY ("patient_id","organization_id") REFERENCES "public"."patients"("id","organization_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quote_decisions" ADD CONSTRAINT "quote_decisions_decided_by_users_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quote_decisions" ADD CONSTRAINT "quote_decisions_version_id_organization_id_quote_versions_id_organization_id_fk" FOREIGN KEY ("version_id","organization_id") REFERENCES "public"."quote_versions"("id","organization_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quote_versions" ADD CONSTRAINT "quote_versions_presented_by_users_id_fk" FOREIGN KEY ("presented_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quote_versions" ADD CONSTRAINT "quote_versions_quote_id_organization_id_quotes_id_organization_id_fk" FOREIGN KEY ("quote_id","organization_id") REFERENCES "public"."quotes"("id","organization_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_plan_id_organization_id_treatment_plans_id_organization_id_fk" FOREIGN KEY ("plan_id","organization_id") REFERENCES "public"."treatment_plans"("id","organization_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "treatment_items" ADD CONSTRAINT "treatment_items_plan_id_organization_id_treatment_plans_id_organization_id_fk" FOREIGN KEY ("plan_id","organization_id") REFERENCES "public"."treatment_plans"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "treatment_items" ADD CONSTRAINT "treatment_items_service_id_organization_id_services_id_organization_id_fk" FOREIGN KEY ("service_id","organization_id") REFERENCES "public"."services"("id","organization_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "treatment_items" ADD CONSTRAINT "treatment_items_professional_id_organization_id_professionals_id_organization_id_fk" FOREIGN KEY ("professional_id","organization_id") REFERENCES "public"."professionals"("id","organization_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "treatment_plans" ADD CONSTRAINT "treatment_plans_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "treatment_plans" ADD CONSTRAINT "treatment_plans_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "treatment_plans" ADD CONSTRAINT "treatment_plans_patient_id_organization_id_patients_id_organization_id_fk" FOREIGN KEY ("patient_id","organization_id") REFERENCES "public"."patients"("id","organization_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "treatment_plans" ADD CONSTRAINT "treatment_plans_unit_id_organization_id_clinic_units_id_organization_id_fk" FOREIGN KEY ("unit_id","organization_id") REFERENCES "public"."clinic_units"("id","organization_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "treatment_plans" ADD CONSTRAINT "treatment_plans_responsible_professional_id_organization_id_professionals_id_organization_id_fk" FOREIGN KEY ("responsible_professional_id","organization_id") REFERENCES "public"."professionals"("id","organization_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "odontogram_entries_organization_id_patient_id_tooth_index" ON "odontogram_entries" USING btree ("organization_id","patient_id","tooth");--> statement-breakpoint
CREATE INDEX "quotes_organization_id_status_index" ON "quotes" USING btree ("organization_id","status");--> statement-breakpoint
CREATE INDEX "treatment_items_plan_id_index" ON "treatment_items" USING btree ("plan_id");--> statement-breakpoint
CREATE INDEX "treatment_plans_organization_id_patient_id_index" ON "treatment_plans" USING btree ("organization_id","patient_id");--> statement-breakpoint
CREATE INDEX "treatment_plans_organization_id_status_index" ON "treatment_plans" USING btree ("organization_id","status");