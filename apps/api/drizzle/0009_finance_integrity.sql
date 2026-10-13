-- FINANCEIRO: alocações são somente-inserção (estorno = alocação negativa)
-- e o banco garante que nenhuma parcela receba mais que seu valor e que
-- nenhum pagamento seja alocado além do que entrou — mesmo sob concorrência.
CREATE TRIGGER payment_allocations_append_only
  BEFORE UPDATE OR DELETE ON "payment_allocations"
  FOR EACH ROW EXECUTE FUNCTION oralis_forbid_mutation();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION oralis_check_allocation_totals() RETURNS trigger AS $$
DECLARE
  rec_total numeric;
  rec_amount numeric;
  pay_total numeric;
  pay_amount numeric;
BEGIN
  SELECT amount INTO rec_amount FROM receivables WHERE id = NEW.receivable_id FOR UPDATE;
  SELECT coalesce(sum(amount), 0) INTO rec_total FROM payment_allocations WHERE receivable_id = NEW.receivable_id;
  IF rec_total > rec_amount OR rec_total < 0 THEN
    RAISE EXCEPTION 'Alocação excede o valor da parcela.' USING ERRCODE = 'check_violation';
  END IF;
  SELECT amount INTO pay_amount FROM payments WHERE id = NEW.payment_id FOR UPDATE;
  SELECT coalesce(sum(amount), 0) INTO pay_total FROM payment_allocations WHERE payment_id = NEW.payment_id;
  IF pay_total > pay_amount OR pay_total < 0 THEN
    RAISE EXCEPTION 'Alocação excede o valor do pagamento.' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER payment_allocations_totals
  AFTER INSERT ON "payment_allocations"
  DEFERRABLE INITIALLY IMMEDIATE
  FOR EACH ROW EXECUTE FUNCTION oralis_check_allocation_totals();
