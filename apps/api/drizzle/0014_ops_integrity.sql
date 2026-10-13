-- ESTOQUE: movimentações são rastreáveis e imutáveis (correção = novo ajuste com motivo).
CREATE TRIGGER stock_movements_append_only
  BEFORE UPDATE OR DELETE ON "stock_movements"
  FOR EACH ROW EXECUTE FUNCTION oralis_forbid_mutation();
--> statement-breakpoint
CREATE TRIGGER communication_events_no_delete
  BEFORE DELETE ON "communication_events"
  FOR EACH ROW EXECUTE FUNCTION oralis_forbid_mutation();
--> statement-breakpoint
CREATE TRIGGER laboratory_order_events_append_only
  BEFORE UPDATE OR DELETE ON "laboratory_order_events"
  FOR EACH ROW EXECUTE FUNCTION oralis_forbid_mutation();
