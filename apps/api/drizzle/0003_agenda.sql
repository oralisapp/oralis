CREATE TABLE "appointment_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"appointment_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"appointment_version" integer NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"used_action" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "appointment_links_tokenHash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "communication_preferences" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"patient_id" uuid NOT NULL,
	"channel" text NOT NULL,
	"category" text NOT NULL,
	"allowed" boolean NOT NULL,
	"source" text NOT NULL,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "communication_preferences_patientId_channel_category_unique" UNIQUE("patient_id","channel","category"),
	CONSTRAINT "comm_pref_channel_ck" CHECK ("communication_preferences"."channel" in ('email', 'sms', 'whatsapp')),
	CONSTRAINT "comm_pref_category_ck" CHECK ("communication_preferences"."category" in ('transactional', 'relationship', 'promotional'))
);
--> statement-breakpoint
CREATE TABLE "patient_preferences" (
	"patient_id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"preferred_channel" text,
	"preferred_period" text,
	"accessibility_needs" text,
	"welcome_notes" text,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "patient_representatives" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"patient_id" uuid NOT NULL,
	"full_name" text NOT NULL,
	"relationship" text NOT NULL,
	"cpf" text,
	"phone" text,
	"email" text,
	"is_legal_guardian" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "schedule_blocks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"unit_id" uuid NOT NULL,
	"professional_id" uuid,
	"chair_id" uuid,
	"kind" text DEFAULT 'block' NOT NULL,
	"reason" text,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"series_id" uuid,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "schedule_blocks_range_ck" CHECK ("schedule_blocks"."ends_at" > "schedule_blocks"."starts_at"),
	CONSTRAINT "schedule_blocks_kind_ck" CHECK ("schedule_blocks"."kind" in ('block', 'vacation', 'break', 'maintenance'))
);
--> statement-breakpoint
CREATE TABLE "tasks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"unit_id" uuid,
	"title" text NOT NULL,
	"description" text,
	"due_at" timestamp with time zone,
	"assignee_membership_id" uuid,
	"assignee_role_key" text,
	"status" text DEFAULT 'open' NOT NULL,
	"origin" text DEFAULT 'manual' NOT NULL,
	"related_type" text,
	"related_id" uuid,
	"dedupe_key" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"completed_by" uuid,
	CONSTRAINT "tasks_org_dedupe_uq" UNIQUE("organization_id","dedupe_key"),
	CONSTRAINT "tasks_status_ck" CHECK ("tasks"."status" in ('open', 'done', 'cancelled'))
);
--> statement-breakpoint
CREATE TABLE "waitlist_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"patient_id" uuid NOT NULL,
	"unit_id" uuid,
	"professional_id" uuid,
	"service_id" uuid,
	"duration_minutes" integer NOT NULL,
	"weekdays" smallint[] DEFAULT '{}'::smallint[] NOT NULL,
	"period" text DEFAULT 'any' NOT NULL,
	"earliest_date" date,
	"latest_date" date,
	"priority" smallint DEFAULT 0 NOT NULL,
	"notes" text,
	"status" text DEFAULT 'active' NOT NULL,
	"scheduled_appointment_id" uuid,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "waitlist_id_org_uq" UNIQUE("id","organization_id"),
	CONSTRAINT "waitlist_period_ck" CHECK ("waitlist_entries"."period" in ('any', 'morning', 'afternoon', 'evening')),
	CONSTRAINT "waitlist_status_ck" CHECK ("waitlist_entries"."status" in ('active', 'scheduled', 'removed'))
);
--> statement-breakpoint
ALTER TABLE "appointment_status_history" ALTER COLUMN "changed_by" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "appointment_status_history" ADD COLUMN "source" text DEFAULT 'staff' NOT NULL;--> statement-breakpoint
ALTER TABLE "appointments" ADD COLUMN "series_id" uuid;--> statement-breakpoint
ALTER TABLE "appointments" ADD COLUMN "waitlist_entry_id" uuid;--> statement-breakpoint
ALTER TABLE "appointments" ADD COLUMN "treatment_item_id" uuid;--> statement-breakpoint
ALTER TABLE "appointment_links" ADD CONSTRAINT "appointment_links_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointment_links" ADD CONSTRAINT "appointment_links_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointment_links" ADD CONSTRAINT "appointment_links_appointment_id_organization_id_appointments_id_organization_id_fk" FOREIGN KEY ("appointment_id","organization_id") REFERENCES "public"."appointments"("id","organization_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "communication_preferences" ADD CONSTRAINT "communication_preferences_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "communication_preferences" ADD CONSTRAINT "communication_preferences_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "communication_preferences" ADD CONSTRAINT "communication_preferences_patient_id_organization_id_patients_id_organization_id_fk" FOREIGN KEY ("patient_id","organization_id") REFERENCES "public"."patients"("id","organization_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patient_preferences" ADD CONSTRAINT "patient_preferences_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patient_preferences" ADD CONSTRAINT "patient_preferences_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patient_preferences" ADD CONSTRAINT "patient_preferences_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patient_representatives" ADD CONSTRAINT "patient_representatives_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patient_representatives" ADD CONSTRAINT "patient_representatives_patient_id_organization_id_patients_id_organization_id_fk" FOREIGN KEY ("patient_id","organization_id") REFERENCES "public"."patients"("id","organization_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedule_blocks" ADD CONSTRAINT "schedule_blocks_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedule_blocks" ADD CONSTRAINT "schedule_blocks_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedule_blocks" ADD CONSTRAINT "schedule_blocks_unit_id_organization_id_clinic_units_id_organization_id_fk" FOREIGN KEY ("unit_id","organization_id") REFERENCES "public"."clinic_units"("id","organization_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedule_blocks" ADD CONSTRAINT "schedule_blocks_professional_id_organization_id_professionals_id_organization_id_fk" FOREIGN KEY ("professional_id","organization_id") REFERENCES "public"."professionals"("id","organization_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedule_blocks" ADD CONSTRAINT "schedule_blocks_chair_id_organization_id_chairs_id_organization_id_fk" FOREIGN KEY ("chair_id","organization_id") REFERENCES "public"."chairs"("id","organization_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_completed_by_users_id_fk" FOREIGN KEY ("completed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_assignee_membership_id_organization_id_memberships_id_organization_id_fk" FOREIGN KEY ("assignee_membership_id","organization_id") REFERENCES "public"."memberships"("id","organization_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "waitlist_entries" ADD CONSTRAINT "waitlist_entries_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "waitlist_entries" ADD CONSTRAINT "waitlist_entries_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "waitlist_entries" ADD CONSTRAINT "waitlist_entries_patient_id_organization_id_patients_id_organization_id_fk" FOREIGN KEY ("patient_id","organization_id") REFERENCES "public"."patients"("id","organization_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "waitlist_entries" ADD CONSTRAINT "waitlist_entries_unit_id_organization_id_clinic_units_id_organization_id_fk" FOREIGN KEY ("unit_id","organization_id") REFERENCES "public"."clinic_units"("id","organization_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "waitlist_entries" ADD CONSTRAINT "waitlist_entries_professional_id_organization_id_professionals_id_organization_id_fk" FOREIGN KEY ("professional_id","organization_id") REFERENCES "public"."professionals"("id","organization_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "waitlist_entries" ADD CONSTRAINT "waitlist_entries_service_id_organization_id_services_id_organization_id_fk" FOREIGN KEY ("service_id","organization_id") REFERENCES "public"."services"("id","organization_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "schedule_blocks_organization_id_unit_id_starts_at_index" ON "schedule_blocks" USING btree ("organization_id","unit_id","starts_at");--> statement-breakpoint
CREATE INDEX "tasks_organization_id_status_due_at_index" ON "tasks" USING btree ("organization_id","status","due_at");--> statement-breakpoint
CREATE INDEX "waitlist_entries_organization_id_status_index" ON "waitlist_entries" USING btree ("organization_id","status");