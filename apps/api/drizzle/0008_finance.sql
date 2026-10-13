CREATE TABLE "bank_statement_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"cash_account_id" uuid NOT NULL,
	"date" date NOT NULL,
	"description" text NOT NULL,
	"amount" numeric(12, 2) NOT NULL,
	"external_id" text NOT NULL,
	"status" text DEFAULT 'unmatched' NOT NULL,
	"matched_payment_id" uuid,
	"matched_payable_id" uuid,
	"matched_by" uuid,
	"matched_at" timestamp with time zone,
	"imported_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bank_statement_lines_cashAccountId_externalId_unique" UNIQUE("cash_account_id","external_id"),
	CONSTRAINT "statement_status_ck" CHECK ("bank_statement_lines"."status" in ('unmatched', 'matched', 'ignored'))
);
--> statement-breakpoint
CREATE TABLE "cash_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"unit_id" uuid NOT NULL,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "cash_accounts_id_org_uq" UNIQUE("id","organization_id"),
	CONSTRAINT "cash_accounts_kind_ck" CHECK ("cash_accounts"."kind" in ('cash', 'bank', 'card_acquirer'))
);
--> statement-breakpoint
CREATE TABLE "commission_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"professional_id" uuid NOT NULL,
	"percent" numeric(5, 2) NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "commission_percent_ck" CHECK ("commission_rules"."percent" >= 0 and "commission_rules"."percent" <= 100)
);
--> statement-breakpoint
CREATE TABLE "financial_categories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	CONSTRAINT "financial_categories_id_org_uq" UNIQUE("id","organization_id"),
	CONSTRAINT "financial_categories_organizationId_kind_name_unique" UNIQUE("organization_id","kind","name"),
	CONSTRAINT "financial_categories_kind_ck" CHECK ("financial_categories"."kind" in ('income', 'expense'))
);
--> statement-breakpoint
CREATE TABLE "payables" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"unit_id" uuid NOT NULL,
	"category_id" uuid,
	"supplier_name" text,
	"description" text NOT NULL,
	"amount" numeric(12, 2) NOT NULL,
	"due_date" date NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"paid_at" timestamp with time zone,
	"paid_amount" numeric(12, 2),
	"cash_account_id" uuid,
	"series_id" uuid,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"reconciled_at" timestamp with time zone,
	CONSTRAINT "payables_id_org_uq" UNIQUE("id","organization_id"),
	CONSTRAINT "payables_amount_ck" CHECK ("payables"."amount" > 0),
	CONSTRAINT "payables_status_ck" CHECK ("payables"."status" in ('open', 'paid', 'cancelled')),
	CONSTRAINT "payables_paid_ck" CHECK (("payables"."status" = 'paid') = ("payables"."paid_at" is not null))
);
--> statement-breakpoint
CREATE TABLE "payment_allocations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"payment_id" uuid NOT NULL,
	"receivable_id" uuid NOT NULL,
	"amount" numeric(12, 2) NOT NULL,
	"refund_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payment_allocations_sign_ck" CHECK (("payment_allocations"."refund_id" is null and "payment_allocations"."amount" > 0) or ("payment_allocations"."refund_id" is not null and "payment_allocations"."amount" < 0))
);
--> statement-breakpoint
CREATE TABLE "payments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"unit_id" uuid NOT NULL,
	"cash_account_id" uuid NOT NULL,
	"patient_id" uuid,
	"amount" numeric(12, 2) NOT NULL,
	"method" text NOT NULL,
	"received_at" timestamp with time zone NOT NULL,
	"reference" text,
	"notes" text,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"reconciled_at" timestamp with time zone,
	"reconciled_by" uuid,
	CONSTRAINT "payments_id_org_uq" UNIQUE("id","organization_id"),
	CONSTRAINT "payments_amount_ck" CHECK ("payments"."amount" > 0),
	CONSTRAINT "payments_method_ck" CHECK ("payments"."method" in ('cash', 'pix', 'card_credit', 'card_debit', 'transfer', 'boleto', 'other'))
);
--> statement-breakpoint
CREATE TABLE "receivables" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"unit_id" uuid NOT NULL,
	"patient_id" uuid,
	"professional_id" uuid,
	"plan_id" uuid,
	"quote_version_id" uuid,
	"category_id" uuid,
	"description" text NOT NULL,
	"amount" numeric(12, 2) NOT NULL,
	"due_date" date NOT NULL,
	"group_id" uuid NOT NULL,
	"installment_no" integer DEFAULT 1 NOT NULL,
	"installments_total" integer DEFAULT 1 NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"collection_hold" boolean DEFAULT false NOT NULL,
	"collection_hold_reason" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"cancelled_at" timestamp with time zone,
	"cancelled_by" uuid,
	"cancel_reason" text,
	CONSTRAINT "receivables_id_org_uq" UNIQUE("id","organization_id"),
	CONSTRAINT "receivables_quote_installment_uq" UNIQUE("quote_version_id","installment_no"),
	CONSTRAINT "receivables_amount_ck" CHECK ("receivables"."amount" > 0),
	CONSTRAINT "receivables_status_ck" CHECK ("receivables"."status" in ('open', 'paid', 'cancelled')),
	CONSTRAINT "receivables_cancel_ck" CHECK (("receivables"."status" = 'cancelled') = ("receivables"."cancelled_at" is not null))
);
--> statement-breakpoint
CREATE TABLE "refunds" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"payment_id" uuid NOT NULL,
	"receivable_id" uuid,
	"amount" numeric(12, 2) NOT NULL,
	"reason" text NOT NULL,
	"status" text DEFAULT 'requested' NOT NULL,
	"requested_by" uuid NOT NULL,
	"decided_by" uuid,
	"decided_at" timestamp with time zone,
	"decision_note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "refunds_amount_ck" CHECK ("refunds"."amount" > 0),
	CONSTRAINT "refunds_status_ck" CHECK ("refunds"."status" in ('requested', 'approved', 'rejected'))
);
--> statement-breakpoint
ALTER TABLE "bank_statement_lines" ADD CONSTRAINT "bank_statement_lines_matched_by_users_id_fk" FOREIGN KEY ("matched_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_statement_lines" ADD CONSTRAINT "bank_statement_lines_cash_account_id_organization_id_cash_accounts_id_organization_id_fk" FOREIGN KEY ("cash_account_id","organization_id") REFERENCES "public"."cash_accounts"("id","organization_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cash_accounts" ADD CONSTRAINT "cash_accounts_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cash_accounts" ADD CONSTRAINT "cash_accounts_unit_id_organization_id_clinic_units_id_organization_id_fk" FOREIGN KEY ("unit_id","organization_id") REFERENCES "public"."clinic_units"("id","organization_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commission_rules" ADD CONSTRAINT "commission_rules_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commission_rules" ADD CONSTRAINT "commission_rules_professional_id_organization_id_professionals_id_organization_id_fk" FOREIGN KEY ("professional_id","organization_id") REFERENCES "public"."professionals"("id","organization_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "financial_categories" ADD CONSTRAINT "financial_categories_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payables" ADD CONSTRAINT "payables_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payables" ADD CONSTRAINT "payables_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payables" ADD CONSTRAINT "payables_unit_id_organization_id_clinic_units_id_organization_id_fk" FOREIGN KEY ("unit_id","organization_id") REFERENCES "public"."clinic_units"("id","organization_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payables" ADD CONSTRAINT "payables_category_id_organization_id_financial_categories_id_organization_id_fk" FOREIGN KEY ("category_id","organization_id") REFERENCES "public"."financial_categories"("id","organization_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payables" ADD CONSTRAINT "payables_cash_account_id_organization_id_cash_accounts_id_organization_id_fk" FOREIGN KEY ("cash_account_id","organization_id") REFERENCES "public"."cash_accounts"("id","organization_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_allocations" ADD CONSTRAINT "payment_allocations_payment_id_organization_id_payments_id_organization_id_fk" FOREIGN KEY ("payment_id","organization_id") REFERENCES "public"."payments"("id","organization_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_allocations" ADD CONSTRAINT "payment_allocations_receivable_id_organization_id_receivables_id_organization_id_fk" FOREIGN KEY ("receivable_id","organization_id") REFERENCES "public"."receivables"("id","organization_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_reconciled_by_users_id_fk" FOREIGN KEY ("reconciled_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_cash_account_id_organization_id_cash_accounts_id_organization_id_fk" FOREIGN KEY ("cash_account_id","organization_id") REFERENCES "public"."cash_accounts"("id","organization_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_patient_id_organization_id_patients_id_organization_id_fk" FOREIGN KEY ("patient_id","organization_id") REFERENCES "public"."patients"("id","organization_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "receivables" ADD CONSTRAINT "receivables_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "receivables" ADD CONSTRAINT "receivables_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "receivables" ADD CONSTRAINT "receivables_cancelled_by_users_id_fk" FOREIGN KEY ("cancelled_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "receivables" ADD CONSTRAINT "receivables_unit_id_organization_id_clinic_units_id_organization_id_fk" FOREIGN KEY ("unit_id","organization_id") REFERENCES "public"."clinic_units"("id","organization_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "receivables" ADD CONSTRAINT "receivables_patient_id_organization_id_patients_id_organization_id_fk" FOREIGN KEY ("patient_id","organization_id") REFERENCES "public"."patients"("id","organization_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "receivables" ADD CONSTRAINT "receivables_professional_id_organization_id_professionals_id_organization_id_fk" FOREIGN KEY ("professional_id","organization_id") REFERENCES "public"."professionals"("id","organization_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "receivables" ADD CONSTRAINT "receivables_category_id_organization_id_financial_categories_id_organization_id_fk" FOREIGN KEY ("category_id","organization_id") REFERENCES "public"."financial_categories"("id","organization_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_requested_by_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_decided_by_users_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_payment_id_organization_id_payments_id_organization_id_fk" FOREIGN KEY ("payment_id","organization_id") REFERENCES "public"."payments"("id","organization_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "payables_organization_id_status_due_date_index" ON "payables" USING btree ("organization_id","status","due_date");--> statement-breakpoint
CREATE INDEX "payment_allocations_receivable_id_index" ON "payment_allocations" USING btree ("receivable_id");--> statement-breakpoint
CREATE INDEX "payment_allocations_payment_id_index" ON "payment_allocations" USING btree ("payment_id");--> statement-breakpoint
CREATE INDEX "payments_organization_id_received_at_index" ON "payments" USING btree ("organization_id","received_at");--> statement-breakpoint
CREATE INDEX "receivables_organization_id_status_due_date_index" ON "receivables" USING btree ("organization_id","status","due_date");--> statement-breakpoint
CREATE INDEX "receivables_organization_id_patient_id_index" ON "receivables" USING btree ("organization_id","patient_id");