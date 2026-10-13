CREATE TABLE "automation_executions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"automation_id" uuid NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" uuid NOT NULL,
	"patient_id" uuid,
	"dedupe_key" text NOT NULL,
	"status" text NOT NULL,
	"reason" text,
	"action" text,
	"result" jsonb,
	"executed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "automation_executions_dedupeKey_unique" UNIQUE("dedupe_key"),
	CONSTRAINT "automation_exec_status_ck" CHECK ("automation_executions"."status" in ('done', 'skipped', 'failed'))
);
--> statement-breakpoint
CREATE TABLE "automation_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"automation_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"snapshot" jsonb NOT NULL,
	"changed_by" uuid NOT NULL,
	"changed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "automations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"unit_id" uuid,
	"template_key" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"config" jsonb NOT NULL,
	"channel" text,
	"message_template_id" uuid,
	"window_start" text DEFAULT '08:00' NOT NULL,
	"window_end" text DEFAULT '20:00' NOT NULL,
	"timezone" text DEFAULT 'America/Sao_Paulo' NOT NULL,
	"frequency_limit_hours" integer DEFAULT 72 NOT NULL,
	"status" text DEFAULT 'paused' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "automations_status_ck" CHECK ("automations"."status" in ('active', 'paused')),
	CONSTRAINT "automations_template_ck" CHECK ("automations"."template_key" in ('confirmation', 'vacancy', 'quote_followup', 'continuity', 'stock_minimum', 'overdue_receivable'))
);
--> statement-breakpoint
CREATE TABLE "campaigns" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"name" text NOT NULL,
	"template_id" uuid NOT NULL,
	"criteria" jsonb NOT NULL,
	"recipient_count" integer NOT NULL,
	"status" text DEFAULT 'sent' NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "communication_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"patient_id" uuid,
	"channel" text NOT NULL,
	"category" text NOT NULL,
	"template_id" uuid,
	"template_version" integer,
	"subject" text,
	"body" text NOT NULL,
	"status" text NOT NULL,
	"status_detail" text,
	"provider_message_id" text,
	"sent_by" uuid,
	"automation_id" uuid,
	"campaign_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "communication_events_status_ck" CHECK ("communication_events"."status" in ('queued', 'sent', 'logged_locally', 'failed', 'not_configured', 'blocked_consent', 'blocked_frequency', 'blocked_demo'))
);
--> statement-breakpoint
CREATE TABLE "crm_interactions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"lead_id" uuid,
	"patient_id" uuid,
	"kind" text NOT NULL,
	"summary" text NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "crm_interactions_kind_ck" CHECK ("crm_interactions"."kind" in ('call', 'whatsapp', 'email', 'visit', 'note'))
);
--> statement-breakpoint
CREATE TABLE "crm_leads" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"unit_id" uuid,
	"name" text NOT NULL,
	"phone" text,
	"email" text,
	"source" text NOT NULL,
	"stage" text DEFAULT 'contact' NOT NULL,
	"owner_membership_id" uuid,
	"patient_id" uuid,
	"lost_reason" text,
	"notes" text,
	"stage_changed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "crm_leads_stage_ck" CHECK ("crm_leads"."stage" in ('contact', 'evaluation_scheduled', 'evaluation_done', 'quote_sent', 'approved', 'in_treatment', 'follow_up', 'lost')),
	CONSTRAINT "crm_leads_source_ck" CHECK ("crm_leads"."source" in ('referral', 'instagram', 'google', 'website', 'walk_in', 'phone', 'partnership', 'other'))
);
--> statement-breakpoint
CREATE TABLE "inventory_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"name" text NOT NULL,
	"category" text,
	"unit_measure" text NOT NULL,
	"min_quantity" numeric(12, 3) DEFAULT '0' NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "inventory_items_id_org_uq" UNIQUE("id","organization_id"),
	CONSTRAINT "inventory_items_organizationId_name_unique" UNIQUE("organization_id","name")
);
--> statement-breakpoint
CREATE TABLE "inventory_lots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"item_id" uuid NOT NULL,
	"lot_code" text NOT NULL,
	"expires_on" date,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "inventory_lots_id_org_uq" UNIQUE("id","organization_id"),
	CONSTRAINT "inventory_lots_itemId_lotCode_unique" UNIQUE("item_id","lot_code")
);
--> statement-breakpoint
CREATE TABLE "laboratories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"name" text NOT NULL,
	"phone" text,
	"email" text,
	"notes" text,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "laboratory_order_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"from_status" text,
	"to_status" text NOT NULL,
	"rework" boolean DEFAULT false NOT NULL,
	"note" text,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "laboratory_orders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"unit_id" uuid NOT NULL,
	"patient_id" uuid NOT NULL,
	"laboratory_id" uuid NOT NULL,
	"professional_id" uuid,
	"treatment_item_id" uuid,
	"work" text NOT NULL,
	"instructions" text,
	"shade" text,
	"due_date" date NOT NULL,
	"cost" numeric(12, 2),
	"status" text DEFAULT 'requested' NOT NULL,
	"rework_count" integer DEFAULT 0 NOT NULL,
	"document_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "laboratory_orders_status_ck" CHECK ("laboratory_orders"."status" in ('requested', 'sent', 'in_production', 'received', 'delivered', 'cancelled'))
);
--> statement-breakpoint
CREATE TABLE "message_templates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"key" uuid NOT NULL,
	"version" integer NOT NULL,
	"name" text NOT NULL,
	"category" text NOT NULL,
	"channel" text NOT NULL,
	"subject" text,
	"body" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "message_templates_key_version_unique" UNIQUE("key","version"),
	CONSTRAINT "message_templates_category_ck" CHECK ("message_templates"."category" in ('transactional', 'relationship', 'promotional')),
	CONSTRAINT "message_templates_channel_ck" CHECK ("message_templates"."channel" in ('email', 'sms', 'whatsapp'))
);
--> statement-breakpoint
CREATE TABLE "service_materials" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"service_id" uuid NOT NULL,
	"item_id" uuid NOT NULL,
	"quantity" numeric(12, 3) NOT NULL,
	CONSTRAINT "service_materials_serviceId_itemId_unique" UNIQUE("service_id","item_id")
);
--> statement-breakpoint
CREATE TABLE "stock_movements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"item_id" uuid NOT NULL,
	"lot_id" uuid,
	"unit_id" uuid NOT NULL,
	"type" text NOT NULL,
	"quantity" numeric(12, 3) NOT NULL,
	"unit_cost" numeric(12, 2),
	"reason" text,
	"supplier_id" uuid,
	"appointment_id" uuid,
	"transfer_id" uuid,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "stock_movements_type_ck" CHECK ("stock_movements"."type" in ('in', 'out', 'adjust_in', 'adjust_out', 'transfer_in', 'transfer_out', 'consumption')),
	CONSTRAINT "stock_movements_qty_ck" CHECK ("stock_movements"."quantity" > 0),
	CONSTRAINT "stock_movements_reason_ck" CHECK ("stock_movements"."type" not in ('adjust_in', 'adjust_out') or ("stock_movements"."reason" is not null and length("stock_movements"."reason") >= 3))
);
--> statement-breakpoint
CREATE TABLE "suppliers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"name" text NOT NULL,
	"contact" text,
	"phone" text,
	"email" text,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "automation_executions" ADD CONSTRAINT "automation_executions_automation_id_automations_id_fk" FOREIGN KEY ("automation_id") REFERENCES "public"."automations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_versions" ADD CONSTRAINT "automation_versions_automation_id_automations_id_fk" FOREIGN KEY ("automation_id") REFERENCES "public"."automations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_versions" ADD CONSTRAINT "automation_versions_changed_by_users_id_fk" FOREIGN KEY ("changed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automations" ADD CONSTRAINT "automations_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automations" ADD CONSTRAINT "automations_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "communication_events" ADD CONSTRAINT "communication_events_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "communication_events" ADD CONSTRAINT "communication_events_sent_by_users_id_fk" FOREIGN KEY ("sent_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_interactions" ADD CONSTRAINT "crm_interactions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_interactions" ADD CONSTRAINT "crm_interactions_lead_id_crm_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."crm_leads"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_interactions" ADD CONSTRAINT "crm_interactions_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_leads" ADD CONSTRAINT "crm_leads_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_leads" ADD CONSTRAINT "crm_leads_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_leads" ADD CONSTRAINT "crm_leads_patient_id_organization_id_patients_id_organization_id_fk" FOREIGN KEY ("patient_id","organization_id") REFERENCES "public"."patients"("id","organization_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_leads" ADD CONSTRAINT "crm_leads_owner_membership_id_organization_id_memberships_id_organization_id_fk" FOREIGN KEY ("owner_membership_id","organization_id") REFERENCES "public"."memberships"("id","organization_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_items" ADD CONSTRAINT "inventory_items_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_lots" ADD CONSTRAINT "inventory_lots_item_id_organization_id_inventory_items_id_organization_id_fk" FOREIGN KEY ("item_id","organization_id") REFERENCES "public"."inventory_items"("id","organization_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "laboratories" ADD CONSTRAINT "laboratories_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "laboratory_order_events" ADD CONSTRAINT "laboratory_order_events_order_id_laboratory_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."laboratory_orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "laboratory_order_events" ADD CONSTRAINT "laboratory_order_events_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "laboratory_orders" ADD CONSTRAINT "laboratory_orders_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "laboratory_orders" ADD CONSTRAINT "laboratory_orders_laboratory_id_laboratories_id_fk" FOREIGN KEY ("laboratory_id") REFERENCES "public"."laboratories"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "laboratory_orders" ADD CONSTRAINT "laboratory_orders_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "laboratory_orders" ADD CONSTRAINT "laboratory_orders_patient_id_organization_id_patients_id_organization_id_fk" FOREIGN KEY ("patient_id","organization_id") REFERENCES "public"."patients"("id","organization_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "laboratory_orders" ADD CONSTRAINT "laboratory_orders_professional_id_organization_id_professionals_id_organization_id_fk" FOREIGN KEY ("professional_id","organization_id") REFERENCES "public"."professionals"("id","organization_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "laboratory_orders" ADD CONSTRAINT "laboratory_orders_unit_id_organization_id_clinic_units_id_organization_id_fk" FOREIGN KEY ("unit_id","organization_id") REFERENCES "public"."clinic_units"("id","organization_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_templates" ADD CONSTRAINT "message_templates_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_templates" ADD CONSTRAINT "message_templates_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_materials" ADD CONSTRAINT "service_materials_service_id_organization_id_services_id_organization_id_fk" FOREIGN KEY ("service_id","organization_id") REFERENCES "public"."services"("id","organization_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_materials" ADD CONSTRAINT "service_materials_item_id_organization_id_inventory_items_id_organization_id_fk" FOREIGN KEY ("item_id","organization_id") REFERENCES "public"."inventory_items"("id","organization_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_item_id_organization_id_inventory_items_id_organization_id_fk" FOREIGN KEY ("item_id","organization_id") REFERENCES "public"."inventory_items"("id","organization_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_lot_id_organization_id_inventory_lots_id_organization_id_fk" FOREIGN KEY ("lot_id","organization_id") REFERENCES "public"."inventory_lots"("id","organization_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_unit_id_organization_id_clinic_units_id_organization_id_fk" FOREIGN KEY ("unit_id","organization_id") REFERENCES "public"."clinic_units"("id","organization_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "suppliers" ADD CONSTRAINT "suppliers_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "automation_executions_automation_id_executed_at_index" ON "automation_executions" USING btree ("automation_id","executed_at");--> statement-breakpoint
CREATE INDEX "communication_events_organization_id_created_at_index" ON "communication_events" USING btree ("organization_id","created_at");--> statement-breakpoint
CREATE INDEX "communication_events_organization_id_patient_id_index" ON "communication_events" USING btree ("organization_id","patient_id");--> statement-breakpoint
CREATE INDEX "crm_interactions_organization_id_patient_id_index" ON "crm_interactions" USING btree ("organization_id","patient_id");--> statement-breakpoint
CREATE INDEX "crm_leads_organization_id_stage_index" ON "crm_leads" USING btree ("organization_id","stage");--> statement-breakpoint
CREATE INDEX "laboratory_orders_organization_id_status_due_date_index" ON "laboratory_orders" USING btree ("organization_id","status","due_date");--> statement-breakpoint
CREATE INDEX "stock_movements_organization_id_item_id_unit_id_index" ON "stock_movements" USING btree ("organization_id","item_id","unit_id");